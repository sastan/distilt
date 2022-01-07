#!/usr/bin/env node

import { existsSync, accessSync, readFileSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { builtinModules } from 'module'
import { fileURLToPath } from 'url'

import { findUpSync } from 'find-up'
import normalizeData from 'normalize-package-data'
import { globby } from 'globby'
import * as esbuild from 'esbuild'
import { rollup } from 'rollup'
import dts from 'rollup-plugin-dts'
import { init, parse } from 'es-module-lexer'
import { execa } from 'execa'

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

function findPaths() {
  const current = process.cwd()
  const root = searchForPackageRoot(current)
  const workspace = searchForWorkspaceRoot(current, root)
  const dist = path.resolve(root, 'dist')

  const tsconfig = findUpSync('tsconfig.json', { cwd: root })

  return { current, workspace, root, dist, tsconfig }
}

async function main() {
  const paths = findPaths()

  const workspaceManifest = JSON.parse(
    readFileSync(path.resolve(paths.workspace, 'package.json'), { encoding: 'utf-8' }),
  )
  const packageManifest = JSON.parse(
    readFileSync(path.resolve(paths.root, 'package.json'), { encoding: 'utf-8' }),
  )
  normalizeData(workspaceManifest)
  normalizeData(packageManifest)

  const manifest = { ...workspaceManifest, ...packageManifest }

  // merge keywords
  manifest.keywords = [
    ...new Set([...(workspaceManifest.keywords || []), ...(packageManifest.keywords || [])]),
  ]

  if (
    paths.workspace != paths.root &&
    workspaceManifest.repository &&
    !packageManifest.repository
  ) {
    // "repository": "github:tw-in-js/twind",
    // "repository": {
    //   "type": "git",
    //   "url": "https://github.com/tw-in-js/twind.git",
    //   "directory": "packages/preset-tailwind"
    // },

    const { repository } = workspaceManifest

    manifest.repository = {
      ...repository,
      direction: path.relative(paths.workspace, paths.root),
    }
  }

  const resolveExtensions = ['.tsx', '.ts', '.jsx', '.mjs', '.js', '.cjs', '.css', '.json']

  const globalName = camelize(manifest.name)

  // TODO read from manifest.engines
  const targets = {
    node: 'node12.4',
    module: 'es2021',
    script: 'es2017',
    esnext: 'esnext',
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

  // The package itself is external as well
  external.push(manifest.name)

  const publishManifest = {
    ...manifest,
    type: 'module',

    exports: {
      '.': manifest.source || manifest.main,
      // Allow access to package.json
      './package.json': './package.json',
      ...manifest.exports,
    },

    // Allow publish
    private: undefined,

    // Include all files in the dist folder
    files: undefined,

    // These are not needed any more
    source: undefined,
    scripts: undefined,
    packageManager: undefined,
    devDependencies: undefined,
    optionalDependencies: undefined,
    engines: manifest.engines && {
      ...manifest.engines,
      npm: undefined,
      yarn: undefined,
      pnpm: undefined,
    },
    workspaces: undefined,

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

    // Added by normalizeData
    readme: undefined,
    _id: undefined,
  }

  console.log(`Bundling ${manifest.name}@${manifest.version}`)

  await prepare()

  const typesDirectoryPromise = paths.tsconfig && generateTypescriptDeclarations()

  try {
    await Promise.all([
      copyFiles(),
      manifest.exports
        ? generateMultiBundles()
        : generateBundles({
            manifest,
            bundleName: manifest.name.split('/').pop(),
            globalName,
            inputFile: path.resolve(paths.root, manifest.source || manifest.main),
          }),
    ])
  } finally {
    const typesDirectory = await typesDirectoryPromise
    typesDirectory && (fs.rm || fs.rmdir)(typesDirectory, { force: true, recursive: true })
  }

  if (manifest['size-limit']) {
    const { default: run } = await import('size-limit/run.js')

    await run(process)
  }

  async function prepare() {
    // Cleanup old build
    await (fs.rm || fs.rmdir)(paths.dist, { recursive: true, force: true })

    // Prepare next one
    await fs.mkdir(paths.dist, { recursive: true })
  }

  async function copyFiles() {
    console.time('Copied files to ' + path.relative(process.cwd(), paths.dist))

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
      files.map(async (file) => {
        const target = path.join(paths.dist, file)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(path.resolve(paths.root, file), target)
      }),
    )

    console.timeEnd('Copied files to ' + path.relative(process.cwd(), paths.dist))
  }

  async function generateMultiBundles() {
    const bundles = {}

    await Promise.all(
      Object.entries(publishManifest.exports)
        .filter(([entryPoint, inputFile]) => /\.([mc]js|[jt]sx?)$/.test(inputFile))
        .map(async ([entryPoint, inputFile], index, entryPoints) => {
          const fileName = path.resolve(paths.root, inputFile)

          const config = {
            entryPoint,
            inputFile,
            outputFile: entryPoint == '.' ? './' + manifest.name.split('/').pop() : entryPoint,
            globalName: camelize(globalName + entryPoint.slice(1).replace(/\//g, '_')),
          }

          const outputs = await getOutputs({ ...config, manifest })

          bundles[fileName] = { ...config, outputs }

          publishManifest.exports[entryPoint] = getExports({ ...config, outputs })
        }),
    )

    if (publishManifest.exports['.']) {
      Object.assign(publishManifest, {
        // Not needed anymore
        browser: undefined,
        // Used by node
        main: publishManifest.exports['.'].node?.require || publishManifest.exports['.'].module,
        // Used by bundlers like rollup and CDNs
        module: publishManifest.exports['.'].module,
        esnext: publishManifest.exports['.'].esnext,
        // Support common CDNs
        unpkg: publishManifest.exports['.'].script,
        jsdelivr: publishManifest.exports['.'].script,
        'umd:main': publishManifest.exports['.'].script,
        // Typescript
        types: publishManifest.exports['.'].types,
      })
    }

    for await (const bundle of Object.values(bundles)) {
      await generateBundles({
        ...bundle,
        manifest: bundle.entryPoint == '.' && publishManifest,
        plugins: [resolveExternalParent(bundle)],
      })
    }

    function resolveExternalParent(bundle) {
      return {
        name: 'external:parent',
        setup(build) {
          const marker = Symbol()

          if (!build.initialOptions.outfile?.endsWith('.umd.js')) {
            // Match all parent imports and mark them as external
            // match: '..', '../', '../..', '../index'
            // no match: '../helper' => this will be included in all bundles referencing it
            build.onResolve(
              {
                filter: /^\.\.?\/?/,
                namespace: 'file',
              },
              async ({ path: unresolved, pluginData, ...args }) => {
                if (pluginData?.[marker]) return

                if (args.kind == 'import-statement') {
                  const result = await build.resolve(unresolved, {
                    ...args,
                    pluginData: { ...pluginData, [marker]: true },
                  })

                  if (result.errors.length > 0 || result.external) {
                    return result
                  }

                  const { path: resolved } = result
                  const targetBundle = bundles[resolved]
                  if (targetBundle) {
                    let target = path.relative(
                      path.dirname(bundle.outputFile),
                      targetBundle.outputFile,
                    )
                    if (target[0] != '.') target = './' + target

                    target += build.initialOptions.outfile
                      ? build.initialOptions.outfile.slice(
                          path.resolve(paths.dist, bundle.outputFile).length,
                        )
                      : build.initialOptions.entryNames.slice(bundle.outputFile.slice(2).length)

                    return { path: target, external: true }
                  }
                }
              },
            )
          }
        },
      }
    }
  }

  async function getOutputs({ inputFile, manifest, outputFile, globalName }) {
    const outputs = {}

    if (manifest.browser !== true) {
      Object.assign(outputs, {
        // Used by nodejs
        require: {
          outfile: `${outputFile}.cjs`,
          platform: 'node',
          target: targets.node,
          format: 'cjs',
          define: {
            'process.browser': 'false',
          },
        },
        // Used by wmr
        module: {
          outfile: `${outputFile}.js`,
          platform: 'node',
          target: targets.node,
          format: 'esm',
          define: {
            'process.browser': 'false',
          },
        },
        esnext: {
          outfile: `${outputFile}.esnext.js`,
          platform: 'node',
          target: targets.esnext,
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
          outfile: `${outputFile}.js`,
          platform: 'browser',
          target: targets.module,
          format: 'esm',
        },
        esnext: {
          outfile: `${outputFile}.esnext.js`,
          platform: 'browser',
          target: targets.esnext,
          format: 'esm',
        },
        // Can be used from a normal script tag without module system.
        script: {
          outfile: `${outputFile}.umd.js`,
          platform: 'browser',
          target: targets.script,
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
              name: globalName,
              globals: (id) => {
                return { jquery: '$', lodash: '_' }[id] || camelize(id)
              },
            },
          },
        },
      })
    }

    return outputs
  }

  function getExports({ outputs, outputFile }) {
    // Define package loading
    // https://gist.github.com/sokra/e032a0f17c1721c71cfced6f14516c62
    return {
      // used by bundlers — compatible with current Spec and stage 4 proposals
      esnext: outputs.esnext.outfile,
      // used by bundlers
      module: outputs.module.outfile,
      // for direct script usage
      script: outputs.script && outputs.script.outfile,
      // typescript
      types: paths.tsconfig ? `${outputFile}.d.ts` : undefined,
      // Node.js
      node: outputs.require && {
        // used by bundlers
        module: outputs.module.outfile,
        // nodejs esm wrapper
        import: `${outputFile}.mjs`,
        require: outputs.require.outfile,
      },
      // fallback to esm
      default: outputs.module.outfile,
    }
  }

  async function generateBundles({ manifest, inputFile, outputFile, outputs, plugins }) {
    const manifestPath = path.resolve(paths.dist, 'package.json')

    if (manifest) {
      await fs.mkdir(path.dirname(manifestPath), { recursive: true })
      await fs.writeFile(manifestPath, JSON.stringify(manifest, omitComments, 2))
    }

    await Promise.all([
      /\.tsx?$/.test(inputFile) &&
        generateTypesBundle(
          inputFile,
          path.resolve(path.dirname(manifestPath), `${outputFile}.d.ts`),
        ),
      ...Object.entries(outputs)
        .filter(([, output]) => output)
        .map(async ([key, { rollup: rollupConfig, ...output }]) => {
          const outfile = path.resolve(paths.dist, output.outfile)

          const logKey = `Bundled ${path.relative(process.cwd(), inputFile)} -> ${path.relative(
            process.cwd(),
            outfile,
          )} (${(rollupConfig && rollupConfig.output.format) || output.format} - ${output.target})`

          console.time(logKey)

          const env =
            output.platform === 'node' && output.format === 'cjs'
              ? {
                  inject: [fileURLToPath(new URL('./shim-node-cjs.js', import.meta.url))],
                  define: {
                    'import.meta.url': 'shim_import_meta_url',
                    'import.meta.resolve': 'shim_import_meta_resolve',
                  },
                }
              : {}

          await esbuild.build({
            ...output,
            ...env,
            entryPoints: [inputFile],
            ...(output.format === 'esm' && !rollupConfig
              ? {
                  outfile: undefined,
                  entryNames: path.relative(paths.dist, outfile).slice(0, -3),
                  outdir: paths.dist,
                  splitting: true,
                  chunkNames: `${path
                    .relative(paths.dist, outfile)
                    .slice(0, -3)}/chunks/[name]-[hash]`,
                  assetNames: `${path
                    .relative(paths.dist, outfile)
                    .slice(0, -3)}/assets/[name]-[hash]`,
                }
              : { outfile }),
            charset: 'utf8',
            resolveExtensions,
            bundle: true,
            external:
              output.external === false
                ? []
                : rollupConfig
                ? external.filter((dependency) => !bundledDependencies.includes(dependency))
                : external,
            mainFields: [
              'esnext',
              'esmodules',
              'modern',
              output.platform === 'browser' && 'browser:module',
              output.platform === 'browser' && 'browser',
              'es2015',
              'module',
              'jsnext:main',
              'main',
            ].filter(Boolean),
            conditions: [
              'production',
              'esmodules',
              'module',
              output.platform === 'browser' ? 'node' : 'browser',
              'import',
              'require',
              'default',
            ],
            sourcemap: true,
            tsconfig: paths.tsconfig,
            plugins: [
              ...(plugins || []),
              output.format === 'esm' && output.platform === 'node' && markBuiltinModules(),
            ].filter(Boolean),
          })

          if (rollupConfig) {
            const bundle = await rollup({
              ...rollupConfig,
              input: outfile,
            })

            await bundle.write({
              ...rollupConfig.output,
              file: outfile,
              sourcemap: true,
              preferConst: true,
              exports: 'auto',
              compact: true,
            })
          }

          console.timeEnd(logKey)

          // generate esm wrapper for Node.js
          if (outputs.require && key === 'module') {
            const wrapperfile = path.resolve(
              path.dirname(path.resolve(paths.dist, outputs.require.outfile)),
              `${outputFile}.mjs`,
            )

            const logKey = `Bundled ${path.relative(process.cwd(), inputFile)} -> ${path.relative(
              process.cwd(),
              wrapperfile,
            )} (esm wrapper)`

            console.time(logKey)

            await init
            const source = await fs.readFile(outfile, 'utf-8')
            const [, exportedNames] = parse(source)

            let wrapper = ''
            const starExports = source.match(/^\s*(export\s+\*\s+from\s*(['"])[^]+?\2)/gm)
            if (starExports) {
              wrapper += starExports.join(';\n') + ';\n'
            }

            wrapper += `import __$$ from ${JSON.stringify(
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

    const bundle = await rollup({
      input: path.relative(process.cwd(), sourceDtsFile),
      plugins: [dts()],
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
            '**/*.test.js',
            '**/*.spec.js',
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
      await execa('tsc', ['--project', tsconfig], {
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

function camelize(str) {
  return str.replace(/[^a-z\d]+([a-z\d])/gi, (_, $1) => $1.toUpperCase())
}

function markBuiltinModules() {
  return {
    name: 'markBuiltinModules',
    setup(build) {
      build.onResolve({ filter: /^[^.]/ }, ({ path }) => {
        if (builtinModules.includes(path)) {
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

// Based in https://github.com/vitejs/vite/blob/414bc45693762c330efbe1f3c8c97829cc05695a/packages/vite/src/node/server/searchRoot.ts
/**
 * Use instead of fs.existsSync(filename)
 * #2051 if we don't have read permission on a directory, existsSync() still
 * works and will result in massively slow subsequent checks (which are
 * unnecessary in the first place)
 */
function isFileReadable(filename) {
  try {
    accessSync(filename, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}
// npm: https://docs.npmjs.com/cli/v7/using-npm/workspaces#installing-workspaces
// yarn: https://classic.yarnpkg.com/en/docs/workspaces/#toc-how-to-use-it
function hasWorkspacePackageJSON(root) {
  const file = path.join(root, 'package.json')
  if (!isFileReadable(file)) {
    return false
  }
  const content = JSON.parse(readFileSync(file, 'utf-8')) || {}
  return !!content.workspaces
}

function hasRootFile(root) {
  const ROOT_FILES = [
    '.git',

    // https://github.com/lerna/lerna#lernajson
    'lerna.json',

    // https://pnpm.js.org/workspaces/
    'pnpm-workspace.yaml',

    // https://rushjs.io/pages/advanced/config_files/
    'rush.json',

    // https://nx.dev/latest/react/getting-started/nx-setup
    'workspace.json',
    'nx.json',
  ]

  return ROOT_FILES.some((file) => existsSync(path.join(root, file)))
}

function hasPackageJSON(root) {
  const file = path.join(root, 'package.json')
  return existsSync(file)
}

/**
 * Search up for the nearest `package.json`
 */
export function searchForPackageRoot(current, root = current) {
  if (hasPackageJSON(current)) return current

  const dir = path.dirname(current)
  // reach the fs root
  if (!dir || dir === current) return root

  return searchForPackageRoot(dir, root)
}

/**
 * Search up for the nearest workspace root
 */
function searchForWorkspaceRoot(current, root = searchForPackageRoot(current)) {
  if (hasRootFile(current)) return current
  if (hasWorkspacePackageJSON(current)) return current

  const dir = path.dirname(current)
  // reach the fs root
  if (!dir || dir === current) return root

  return searchForWorkspaceRoot(dir, root)
}
