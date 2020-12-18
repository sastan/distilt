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
  const tsconfig = path.resolve(root, 'tsconfig.json')

  return { root, dist, manifest, tsconfig: existsSync(tsconfig) && tsconfig }
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
  }).filter((dependency) => !bundledDependencies.includes(dependency))

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
    await Promise.all(
      Object.entries(manifest.exports)
        .filter(([entryPoint, inputFile]) => /\.([mc]js|[jt]sx?)$/.test(inputFile))
        .map(([entryPoint, inputFile], index, entryPoints) => {
          if (entryPoint === '.') {
            const exports = {}

            // TODO generate types
            entryPoints.forEach(([subEntryPoint]) => {
              const bundleName = path.relative(
                '.',
                path.join(subEntryPoint, path.basename(subEntryPoint)),
              )

              const outputs = getOutputs({
                manifest,
                bundleName,
                globalName: globalName + subEntryPoint.slice(1).replace(/\//g, '.'),
              })

              exports[subEntryPoint] = getExports({ outputs, bundleName })
            })

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
              {
                name: 'external:parent',
                setup(build) {
                  // Match all parent imports and mark them as external
                  build.onResolve({ filter: /^\.\./ }, ({ path }) => ({
                    path: path.replace(/\/index(?:\.(?:[mc]js|[jt]sx?))?$/, ''),
                    external: true,
                  }))
                },
              },
            ],
          })
        }),
    )
  }

  function getOutputs({ manifest, bundleName, globalName }) {
    const outputs = {}

    if (manifest.browser !== true) {
      Object.assign(outputs, {
        // Used by nodejs
        node: {
          outfile: `./${bundleName}.cjs`,
          platform: 'node',
          target: targets.node,
          format: 'cjs',
        },
      })
    }

    if (manifest.browser !== false) {
      Object.assign(outputs, {
        browser: {
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
          format: 'iife',
          globalName: 'exports',
          minify: true,
          external: false,
          // TODO dedent and minify
          banner:
            `!function(e,t){` +
            `"function"==typeof define&&define.amd` +
            `?define(t)` +
            `:"object"==typeof module&&module.exports` +
            `?module.exports=t(require)` +
            // IIFE - provide a simple require function for looking up values in root scope
            `:e.${globalName}=t((function(t){for(var i=${JSON.stringify(
              globalName,
            )}.split("."),n=t.split("/");".."==n[0];)n.shift(),i.pop();for(var f,o=i.concat(t),r=e;r&&(f=o.shift());r=r[f]);return r}))` +
            `}("undefined"!=typeof self?self:this,(function(require){`,
          // var exports = ...
          footer: `return exports}));`,
        },
      })
    }

    return outputs
  }

  function getExports({ outputs, bundleName, manifestFile = 'package.json' }) {
    return {
      // Only add if we have browser and node bundles
      node: outputs.browser && outputs.node && relative(manifestFile, outputs.node.outfile),
      script: outputs.script && relative(manifestFile, outputs.script.outfile),
      types: paths.tsconfig ? relative(manifestFile, `./${bundleName}.d.ts`) : undefined,
      default: relative(
        manifestFile,
        outputs.browser ? outputs.browser.outfile : outputs.node.outfile,
      ),
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
    const outputs = getOutputs({ manifest, bundleName, globalName })

    const manifestPath = path.resolve(paths.dist, manifestFile)

    const exports = getExports({ outputs, bundleName, manifestFile })

    const publishManifest = {
      ...manifest,

      // Define package loading
      // https://gist.github.com/sokra/e032a0f17c1721c71cfced6f14516c62
      exports: manifest.exports  === false ? undefined : {
        ...manifest.exports,

        '.': exports,

        // Allow access to package.json
        './package.json': './package.json',
      },

      // Used by node
      main: exports.node,
      // Used by bundlers like rollup and CDNs
      module: outputs.browser && exports.default,
      unpkg: exports.script,
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

      // Resets comments
      '//': undefined,
    }

    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.writeFile(manifestPath, JSON.stringify(publishManifest, null, 2))

    await Promise.all([
      exports.types && generateTypesBundle(inputFile, path.resolve(path.dirname(manifestPath), exports.types)),
      ...Object.entries(outputs)
        .filter(([, output]) => output)
        .map(async ([, output]) => {
          const outfile = path.resolve(paths.dist, output.outfile)

          const logKey = `Bundled ${path.relative(process.cwd(), inputFile)} -> ${path.relative(
            process.cwd(),
            outfile,
          )} (${output.format} - ${output.target})`

          console.time(logKey)

          await service.build({
            ...output,
            outfile,
            entryPoints: [inputFile],
            charset: 'utf8',
            resolveExtensions,
            bundle: true,
            external: output.external === false ? undefined : external,
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
            plugins,
          })

          console.timeEnd(logKey)
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

    const tsconfig = path.resolve(
      path.dirname(paths.tsconfig),
      'tsconfig.dist.json',
    )

    await fs.writeFile(
      tsconfig,
      JSON.stringify(
        {
          extends: './' + path.basename(paths.tsconfig),
          exclude: ['**/__mocks__/**', '**/__fixtures__/**', '**/__tests__/**'],
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

    // TODO run tsc only once; and rollup for every export
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
