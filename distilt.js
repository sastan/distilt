#!/usr/bin/env node

const { existsSync, promises: fs } = require('fs')
const path = require('path')

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
} else {
  module.exports = main
}

function findPaths() {
  const root = require('pkg-dir').sync() || require('project-root-directory')
  const dist = path.resolve(root, 'dist')

  const manifest = path.resolve(root, 'package.json')
  const tsconfig = require('find-up').sync('tsconfig.json', { cwd: root })

  return { root, dist, manifest, tsconfig }
}

async function main() {
  const paths = findPaths()

  const manifest = require(paths.manifest)

  const resolveExtensions = ['.tsx', '.ts', '.jsx', '.mjs', '.js', '.cjs', '.css', '.json']

  const bundleName = manifest.name.split('/').pop()
  const globalName = manifest.globalName || manifest.name.replace('@', '').replace(/\//g, '.')

  // TODO read from manifest.engines
  const targets = {
    node: 'node10.13',
    browser: ['chrome79', 'firefox78', 'safari13.1', 'edge79'],
  }

  // Bundled dependencies are included in the the output bundle
  const bundledDependencies = [
    ...(manifest.bundledDependencies || []),
    ...(manifest.bundleDependencies || []),
  ]

  const external = Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.devDependencies,
    ...manifest.optinonalDependencies,
  })

  console.log(`Bundling ${manifest.name}@${manifest.version}`)

  await prepare()

  const service = await require('esbuild').startService()

  const typesDirectoryPromise = paths.tsconfig && generateTypescriptDeclarations()

  try {
    await Promise.all([
      copyFiles(),
      manifest.exports
        ? generateMultiBundles()
        : generateBundles({
            manifest,
            bundleName,
            globalName,
            inputFile: path.resolve(paths.root, manifest.source || manifest.main),
          }),
    ])
  } finally {
    service.stop()

    const typesDirectory = await typesDirectoryPromise
    typesDirectory && fs.rmdir(typesDirectory, { force: true, recursive: true })
  }

  if (manifest['size-limit']) {
    await require('size-limit/run')(process)
  }

  async function prepare() {
    // Cleanup old build
    await fs.rmdir(paths.dist, { recursive: true, force: true })

    // Prepare next one
    await fs.mkdir(paths.dist, { recursive: true })
  }

  async function copyFiles() {
    console.time('Copied files to ' + path.relative(process.cwd(), paths.dist))

    const globby = require('globby')

    /**
     * Copy readme, license, changelog to dist
     */
    const files = await globby(
      [
        ...(manifest.files || []),
        '{changes,changelog,history,license,licence,notice,readme}?(.md|.txt)',
      ],
      {
        cwd: paths.root,
        absolute: false,
        gitignore: true,
        caseSensitiveMatch: false,
        dot: true,
      },
    )

    await Promise.all(
      files.map((file) => fs.copyFile(path.resolve(paths.root, file), path.join(paths.dist, file))),
    )

    console.timeEnd('Copied files to ' + path.relative(process.cwd(), paths.dist))
  }

  async function generateMultiBundles() {
    let mainEntryFile

    const resolveExternalParent = (extension = 'js') => {
      return {
        name: 'external:parent:' + extension,
        setup(build) {
          // Match all parent imports and mark them as external
          // match: '..', '../', '../..', '../index'
          // no match: '../helper' => this will be included in all bundles referencing it
          build.onResolve(
            {
              filter: /^\.\.(\/|(\/.+)*\/index(?:\.(?:[mc]js|[jt]sx?))?)?$/,
              namespace: 'file',
            },
            ({ path: file, resolveDir }) => {
              const target = path.resolve(resolveDir, file)

              const isInputFile =
                target ===
                path.resolve(paths.root, mainEntryFile).replace(/(?:\.(?:[mc]js|[jt]sx?))?$/, '')

              file = file.replace(/\/index(?:\.(?:[mc]js|[jt]sx?))?$/, '')

              const basename = isInputFile
                ? globalName
                : path.basename(target.replace(/\/index(?:\.(?:[mc]js|[jt]sx?))?$/, ''))

              return {
                path: `${file}/${basename}.${extension}`,
                external: true,
              }
            },
          )
        },
      }
    }

    await Promise.all(
      Object.entries(manifest.exports)
        .filter(([entryPoint, inputFile]) => /\.([mc]js|[jt]sx?)$/.test(inputFile))
        .map(async ([entryPoint, inputFile], index, entryPoints) => {
          if (entryPoint === '.') {
            mainEntryFile = inputFile

            const exports = {}

            await Promise.all(
              entryPoints.map(async ([subEntryPoint, subInputFile]) => {
                const bundleName = path.relative(
                  '.',
                  path.join(subEntryPoint, path.basename(subEntryPoint)),
                )

                const outputs = await getOutputs({
                  inputFile: subInputFile,
                  manifest,
                  bundleName,
                  globalName: globalName + subEntryPoint.slice(1).replace(/\//g, '.'),
                })

                exports[subEntryPoint] = getExports({ outputs, bundleName })
              }),
            )

            return generateBundles({
              manifest: {
                ...manifest,
                exports: {
                  ...manifest.exports,
                  ...exports,
                },
              },
              bundleName,
              globalName,
              inputFile,
            })
          }

          return generateBundles({
            manifest: {
              browser: manifest.browser,
              exports: false,
            },
            manifestFile: path.relative('.', path.join(entryPoint, 'package.json')),
            bundleName: path.relative('.', path.join(entryPoint, path.basename(entryPoint))),
            globalName: globalName + entryPoint.slice(1).replace(/\//g, '.'),
            inputFile,
            plugins: [
              resolveExternalParent('js'),
              resolveExternalParent('cjs'),
              resolveExternalParent('umd.js'),
            ],
          })
        }),
    )
  }

  async function getOutputs({ inputFile, manifest, bundleName, globalName }) {
    const outputs = {}

    if (manifest.browser !== true) {
      Object.assign(outputs, {
        // Used by nodejs
        require: {
          outfile: `./${bundleName}.cjs`,
          platform: 'node',
          target: targets.node,
          format: 'cjs',
          define: {
            'process.browser': 'false',
          },
        },
        // Used by wmr
        module: {
          outfile: `./${bundleName}.js`,
          platform: 'node',
          target: targets.node,
          format: 'esm',
          define: {
            'process.browser': 'false',
          },
        },
      })
    }

    if (
      manifest.browser !== false &&
      // Do not create browser bundle node modules
      !/^\/\* eslint-env node\b/.test(
        await fs.readFile(path.resolve(paths.root, inputFile), 'utf-8'),
      )
    ) {
      Object.assign(outputs, {
        module: {
          outfile: `./${bundleName}.js`,
          platform: 'browser',
          target: targets.browser,
          format: 'esm',
          minify: true,
        },
        // Can be used from a normal script tag without module system.
        script: {
          outfile: `./${bundleName}.umd.js`,
          platform: 'browser',
          target: 'es2015',
          format: 'esm',
          minify: true,
          define: {
            'process.env.NODE_ENV': '"production"',
            'process.platform': '"browser"',
            'process.browser': 'true',
          },
          rollup: {
            external: () => true,
            output: {
              format: 'umd',
              name: camelize(globalName),
              globals: (id) => {
                return { jquery: '$', lodash: '_' }[id] || camelize(id, globalName, paths.dist)
              },
            },
          },
        },
      })
    }

    return outputs
  }

  function getExports({ outputs, bundleName, manifestFile = 'package.json' }) {
    return {
      // 1. used by bundlers
      module: relative(manifestFile, outputs.module.outfile),
      // 2. for direct script usage
      script: outputs.script && relative(manifestFile, outputs.script.outfile),
      // 3. typescript
      types: paths.tsconfig ? relative(manifestFile, `./${bundleName}.d.ts`) : undefined,
      // 4. nodejs CJS
      require: outputs.require && relative(manifestFile, outputs.require.outfile),
      // 5. nodejs esm wrapper
      node: outputs.require && relative(manifestFile, `./${bundleName}.mjs`),
      // 6. fallback to esm
      default: relative(manifestFile, outputs.module.outfile),
    }
  }

  async function generateBundles({
    manifest,
    manifestFile = 'package.json',
    bundleName,
    globalName,
    inputFile,
    plugins,
  }) {
    const outputs = await getOutputs({ inputFile, manifest, bundleName, globalName })

    const manifestPath = path.resolve(paths.dist, manifestFile)

    const exports = getExports({ outputs, bundleName, manifestFile })

    const publishManifest = {
      ...manifest,

      // Define package loading
      // https://gist.github.com/sokra/e032a0f17c1721c71cfced6f14516c62
      exports:
        manifest.exports === false
          ? undefined
          : {
              ...manifest.exports,

              '.': exports,

              // Allow access to package.json
              './package.json': './package.json',
            },

      // Used by node
      main: exports.require || exports.module,
      // Used by bundlers like rollup and CDNs
      module: exports.module,
      unpkg: exports.script,
      'umd:main': exports.script,
      types: exports.types,

      // Allow publish
      private: undefined,

      // Include all files in the dist folder
      files: undefined,

      // Default to cjs
      type: undefined,

      // These are not needed any more
      source: undefined,
      scripts: undefined,
      devDependencies: undefined,
      optionalDependencies: undefined,

      // Reset bundledDependencies as esbuild includes those into the bundle
      bundledDependencies: undefined,
      bundleDependencies: undefined,

      // Reset config sections
      eslintConfig: undefined,
      prettier: undefined,
      np: undefined,
      'size-limit': undefined,
      'lint-staged': undefined,
      husky: undefined,
    }

    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.writeFile(manifestPath, JSON.stringify(publishManifest, omitComments, 2))

    await Promise.all([
      exports.types &&
        generateTypesBundle(inputFile, path.resolve(path.dirname(manifestPath), exports.types)),
      ...Object.entries(outputs)
        .filter(([, output]) => output)
        .map(async ([key, { rollup, ...output }]) => {
          const outfile = path.resolve(paths.dist, output.outfile)

          const logKey = `Bundled ${path.relative(process.cwd(), inputFile)} -> ${path.relative(
            process.cwd(),
            outfile,
          )} (${(rollup && rollup.output.format) || output.format} - ${output.target})`

          console.time(logKey)

          await service.build({
            ...output,
            outfile,
            entryPoints: [inputFile],
            charset: 'utf8',
            resolveExtensions,
            bundle: true,
            external:
              output.external === false
                ? []
                : rollup
                ? external.filter((dependency) => !bundledDependencies.includes(dependency))
                : external,
            mainFields: [
              'esnext',
              output.platform === 'browser' && 'browser:module',
              output.platform === 'browser' && 'browser',
              'es2015',
              'module',
              'main',
            ].filter(Boolean),
            sourcemap: true,
            tsconfig: paths.tsconfig,
            plugins:
              plugins &&
              plugins
                .filter(
                  (plugin) =>
                    !plugin.name.startsWith('external:parent:') ||
                    (rollup
                      ? plugin.name.endsWith(':umd.js')
                      : output.format === 'cjs'
                      ? plugin.name.endsWith(':cjs')
                      : true),
                )
                .concat(
                  output.format === 'esm' && output.platform === 'node'
                    ? [markBuiltinModules()]
                    : [],
                ),
          })

          if (rollup) {
            const bundle = await require('rollup').rollup({
              ...rollup,
              input: outfile,
            })

            await bundle.write({
              ...rollup.output,
              file: outfile,
              sourcemap: true,
              preferConst: true,
              exports: 'auto',
              compact: true,
            })
          }

          console.timeEnd(logKey)

          // generate esm wrapper for nodejs
          if (outputs.require && key === 'module') {
            const wrapperfile = path.resolve(
              path.dirname(path.resolve(paths.dist, outputs.require.outfile)),
              exports.node,
            )

            const logKey = `Bundled ${path.relative(process.cwd(), inputFile)} -> ${path.relative(
              process.cwd(),
              wrapperfile,
            )} (esm wrapper)`

            console.time(logKey)

            const { init, parse } = require('es-module-lexer')
            await init
            const source = await fs.readFile(outfile, 'utf-8')
            const [, exportedNames] = parse(source)

            let wrapper = `import __$$ from ${JSON.stringify(
              './' + path.basename(outputs.require.outfile),
            )};\n`

            const namedExports = exportedNames.filter((name) => name !== 'default')

            if (namedExports.length) {
              wrapper += `export const { ${namedExports.join(', ')} } = __$$;\n`
            }

            if (exportedNames.includes('default')) {
              wrapper += `export default __$$.default;\n`
            } else {
              wrapper += `export default __$$;\n`
            }

            await fs.writeFile(wrapperfile, wrapper)

            console.timeEnd(logKey)
          }
        }),
    ])
  }

  async function generateTypesBundle(inputFile, dtsFile) {
    const typesDirectory = await typesDirectoryPromise

    const logKey = `Bundled ${path.relative(process.cwd(), inputFile)} -> ${path.relative(
      process.cwd(),
      dtsFile,
    )}`
    console.time(logKey)

    inputFile = path.relative(path.dirname(paths.tsconfig), path.resolve(process.cwd(), inputFile))

    // './src/shim/index.ts'
    // => '.types/src/shim/index.ts'
    // => '.types/shim/index.ts'
    // => '.types/index.ts'

    const parts = inputFile.replace(/\.(ts|tsx)$/, '.d.ts').split('/')
    let sourceDtsFile = path.resolve(typesDirectory, parts.join('/'))

    for (let offset = 0; offset < parts.length && !existsSync(sourceDtsFile); offset++) {
      sourceDtsFile = path.resolve(typesDirectory, parts.slice(offset).join('/'))
    }

    const bundle = await require('rollup').rollup({
      input: path.relative(process.cwd(), sourceDtsFile),
      plugins: [(0, require('rollup-plugin-dts').default)()],
    })

    await bundle.write({
      format: 'esm',
      file: dtsFile,
      sourcemap: true,
      preferConst: true,
      exports: 'auto',
    })

    console.timeEnd(logKey)
  }

  async function generateTypescriptDeclarations() {
    console.time('Generated typescript declarations')

    const typesDirectory = path.resolve(paths.dist, '.types')

    const tsconfig = path.resolve(path.dirname(paths.tsconfig), 'tsconfig.dist.json')

    await fs.writeFile(
      tsconfig,
      JSON.stringify(
        {
          extends: './' + path.basename(paths.tsconfig),
          exclude: [
            '**/__mocks__/**',
            '**/__fixtures__/**',
            '**/__tests__/**',
            '**/test/**',
            '**/tests/**',
            '**/*.test.ts',
            '**/*.test.tsx',
            '**/*.spec.ts',
            '**/*.spec.tsx',
          ],
          compilerOptions: {
            target: 'ESNext',
            module: manifest.browser === false ? 'CommonJS' : 'ESNext',
            emitDeclarationOnly: true,
            noEmit: false,
            outDir: typesDirectory,
          },
        },
        null,
        2,
      ),
    )

    try {
      // tsc --project tsconfig.dist.json
      await require('execa')('tsc', ['--project', tsconfig], {
        cwd: paths.root,
        extendEnv: true,
        stdout: 'inherit',
        stderr: 'inherit',
      })
    } finally {
      await fs.unlink(tsconfig)
    }

    console.timeEnd('Generated typescript declarations')

    return typesDirectory
  }
}

function relative(from, to) {
  const p = path.relative(path.dirname(from), to)

  return p[0] === '.' ? p : './' + p
}

function camelize(str, globalName, root) {
  if (str.startsWith(root)) {
    str = path.dirname(str).slice(root.length + 1)
    str = [globalName.split('.')[0], str].filter(Boolean).join('/')
  }

  return str.replace(/\W/g, ' ').replace(/(?:^\w|[A-Z]|\b\w|\s+)/g, function (match, index) {
    if (+match === 0) return '' // or if (/\s+/.test(match)) for white spaces
    return index === 0 ? match.toLowerCase() : match.toUpperCase()
  })
}

function markBuiltinModules() {
  const builtin = require('module').builtinModules

  return {
    name: 'markBuiltinModules',
    setup(build) {
      build.onResolve({ filter: /^[^.]/ }, ({ path }) => {
        if (builtin.includes(path)) {
          return {
            path: 'node:' + path,
            external: true,
          }
        }
      })
    },
  }
}

function omitComments(key, value) {
  if (key.startsWith('//')) {
    return undefined
  }

  return value
}
