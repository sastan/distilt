#!/usr/bin/env node

import { existsSync, accessSync, readFileSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

import { findUpSync } from 'find-up'
import normalizeData from 'normalize-package-data'
import { globby } from 'globby'

import { rollup } from 'rollup'
import esbuild from 'rollup-plugin-esbuild'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import * as dynamicImportVarsNS from '@rollup/plugin-dynamic-import-vars'
import inject from '@rollup/plugin-inject'
import { terser } from 'rollup-plugin-terser'
import dts from 'rollup-plugin-dts'

import { execa } from 'execa'

const dynamicImportVars = dynamicImportVarsNS.default?.default || dynamicImportVarsNS.default

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

  // keep dependencies as is
  const allDepdenciesManifest = JSON.parse(
    JSON.stringify({
      dependencies: packageManifest.dependencies,
      peerDependencies: packageManifest.peerDependencies,
      devDependencies: packageManifest.devDependencies,
    }),
  )

  normalizeData(workspaceManifest)
  normalizeData(packageManifest)

  const manifest = { ...workspaceManifest, ...packageManifest, ...allDepdenciesManifest }

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
    // TODO node12.4 seems to be broken
    node: 'es2019',
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
    mangle: undefined,

    // Added by normalizeData
    readme: undefined,
    _id: undefined,
  }

  console.log(`Bundling ${manifest.name}@${manifest.version}`)

  await prepare()

  const typesDirectoryPromise = paths.tsconfig && generateTypescriptDeclarations()

  try {
    await Promise.all([copyFiles(), generateMultiBundles()])
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
    ;[]
    let mainEntryPoint

    const entryPoints = Object.entries(publishManifest.exports)
      .filter(([entryPoint, inputFile]) => /\.([mc]js|[jt]sx?)$/.test(inputFile))
      .map(([entryPoint, conditions]) => {
        if (typeof conditions == 'string') {
          conditions = { default: conditions }
        }

        // Support default -> neutral, browser -> browser, node -> node
        if (!(conditions.default || conditions.browser || conditions.node)) {
          return
        }

        const outputFile = entryPoint == '.' ? './' + manifest.name.split('/').pop() : entryPoint

        if (entryPoint == '.') {
          mainEntryPoint = outputFile.slice(2)
        }

        // Define package loading
        // https://gist.github.com/sokra/e032a0f17c1721c71cfced6f14516c62
        publishManifest.exports[entryPoint] = {
          // used by bundlers — compatible with current Spec and stage 4 proposals
          esnext: outputFile + '.esnext.js',
          // used by bundlers
          module: outputFile + '.js',

          // for direct script usage
          script: (conditions.default || conditions.browser) && outputFile + '.global.js',

          // typescript
          types: paths.tsconfig ? `${outputFile}.d.ts` : undefined,

          // Node.js
          node: (conditions.default || conditions.node) && {
            // nodejs esm wrapper
            import: outputFile + '.mjs',
            require: outputFile + '.cjs',
          },

          // fallback to esm
          default: outputFile + '.js',
        }

        return {
          outputFile: outputFile.slice(2),
          conditions,
        }
      })
      .filter(Boolean)

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
        // Typescript
        types: publishManifest.exports['.'].types,
      })
    }

    const manifestPath = path.resolve(paths.dist, 'package.json')
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.writeFile(manifestPath, JSON.stringify(publishManifest, omitComments, 2))

    await Promise.all(
      [
        async () => {
          console.time('Generated esnext bundles')

          const bundle = await rollup({
            input: Object.fromEntries(
              entryPoints.map(({ outputFile, conditions }) => [
                outputFile,
                conditions.default || conditions.browser || conditions.node,
              ]),
            ),
            external,
            preserveEntrySignatures: 'strict',
            treeshake: {
              propertyReadSideEffects: false,
            },
            onwarn(warning, warn) {
              if (warning.code === 'CIRCULAR_DEPENDENCY') return

              // Use default for everything else
              warn(warning)
            },
            plugins: [
              nodeResolve({
                extensions: resolveExtensions,
                mainFields: [
                  'esnext',
                  'esmodules',
                  'modern',
                  'es2015',
                  'module',
                  'jsnext:main',
                  'main',
                ],
                exportConditions: [
                  'production',
                  'esnext',
                  'modern',
                  'esmodules',
                  'es2015',
                  'module',
                  'import',
                  'default',
                  'require',
                ],
              }),
              esbuild({
                exclude: null,
                // platform: 'neutral',
                target: targets.esnext,
                tsconfig: paths.tsconfig,
                // TODO optimizeDeps: ['vue', 'vue-router'],
                // TODO maybe configurable
                loaders: {
                  // Add .json files support
                  // require @rollup/plugin-commonjs
                  '.json': 'json',
                  // Enable JSX in .js files too
                  '.js': 'jsx',
                },
              }),
              dynamicImportVars({ warnOnError: true }),
            ],
          })

          await bundle.write({
            format: 'es',
            dir: paths.dist,
            entryFileNames: '[name].esnext.js',
            chunkFileNames: '_/[name]-[hash].js',
            assetFileNames: '_/assets/[name]-[hash][extname]',
            generatedCode: 'es2015',
            preferConst: true,
            hoistTransitiveImports: false,
            interop: 'auto',
            minifyInternalExports: true,
            sourcemap: true,
            sourcemapExcludeSources: true,
            freeze: false,
            esModule: false,
          })

          await bundle.close()

          console.timeEnd('Generated esnext bundles')
        },
        async () => {
          console.time('Generated module bundles')

          const bundle = await rollup({
            input: Object.fromEntries(
              entryPoints.map(({ outputFile, conditions }) => [
                outputFile,
                conditions.default || conditions.browser || conditions.node,
              ]),
            ),
            external,
            preserveEntrySignatures: 'strict',
            treeshake: {
              propertyReadSideEffects: false,
            },
            onwarn(warning, warn) {
              if (warning.code === 'CIRCULAR_DEPENDENCY') return

              // Use default for everything else
              warn(warning)
            },
            plugins: [
              nodeResolve({
                extensions: resolveExtensions,
                mainFields: [
                  'esnext',
                  'esmodules',
                  'modern',
                  'es2015',
                  'module',
                  'jsnext:main',
                  'main',
                ],
                exportConditions: [
                  'production',
                  'esnext',
                  'modern',
                  'esmodules',
                  'es2015',
                  'module',
                  'import',
                  'default',
                  'require',
                ],
              }),
              esbuild({
                exclude: null,
                // platform: 'neutral',
                target: targets.module,
                tsconfig: paths.tsconfig,
                // TODO optimizeDeps: ['vue', 'vue-router'],
                // TODO maybe configurable
                loaders: {
                  // Add .json files support
                  // require @rollup/plugin-commonjs
                  '.json': 'json',
                  // Enable JSX in .js files too
                  '.js': 'jsx',
                },
              }),
              dynamicImportVars({ warnOnError: true }),
            ],
          })

          await bundle.write({
            format: 'es',
            dir: paths.dist,
            entryFileNames: '[name].js',
            chunkFileNames: '_/[name]-[hash].js',
            assetFileNames: '_/assets/[name]-[hash][extname]',
            generatedCode: 'es2015',
            preferConst: true,
            hoistTransitiveImports: false,
            interop: 'auto',
            minifyInternalExports: true,
            sourcemap: true,
            sourcemapExcludeSources: true,
            freeze: false,
            esModule: false,
          })

          await bundle.close()

          console.timeEnd('Generated module bundles')
        },
        async () => {
          console.time('Generated Node.js cjs bundles')

          const bundle = await rollup({
            input: Object.fromEntries(
              entryPoints.map(({ outputFile, conditions }) => [
                outputFile,
                conditions.node || conditions.default,
              ]),
            ),
            external,
            preserveEntrySignatures: 'strict',
            treeshake: {
              propertyReadSideEffects: false,
            },
            onwarn(warning, warn) {
              if (warning.code === 'CIRCULAR_DEPENDENCY') return

              // Use default for everything else
              warn(warning)
            },
            plugins: [
              nodeResolve({
                extensions: [...resolveExtensions, '.node'],
                mainFields: [
                  'esnext',
                  'esmodules',
                  'modern',
                  'es2015',
                  'module',
                  'jsnext:main',
                  'main',
                ],
                exportConditions: [
                  'node',
                  'production',
                  'esnext',
                  'modern',
                  'esmodules',
                  'es2015',
                  'module',
                  'import',
                  'default',
                  'require',
                ],
              }),
              esbuild({
                exclude: null,
                // platform: 'neutral',
                target: targets.node,
                tsconfig: paths.tsconfig,
                define: {
                  'process.browser': false,
                  'import.meta.url': '__$$shim_import_meta_url',
                  'import.meta.resolve': '__$$shim_import_meta_resolve',
                },

                // TODO optimizeDeps: ['vue', 'vue-router'],
                // TODO maybe configurable
                loaders: {
                  // Add .json files support
                  // require @rollup/plugin-commonjs
                  '.json': 'json',
                  // Enable JSX in .js files too
                  '.js': 'jsx',
                },
              }),
              dynamicImportVars({ warnOnError: true }),
              inject({
                __$$shim_import_meta_url: [
                  fileURLToPath(new URL('./shim-node-cjs.js', import.meta.url)),
                  'shim_import_meta_url',
                ],
                __$$shim_import_meta_resolve: [
                  fileURLToPath(new URL('./shim-node-cjs.js', import.meta.url)),
                  'shim_import_meta_resolve',
                ],
              }),
            ],
          })

          const { output } = await bundle.write({
            format: 'cjs',
            exports: 'auto',
            dir: paths.dist,
            entryFileNames: '[name].cjs',
            chunkFileNames: '_/[name]-[hash].cjs',
            assetFileNames: '_/assets/[name]-[hash][extname]',
            generatedCode: 'es2015',
            preferConst: true,
            hoistTransitiveImports: false,
            interop: 'auto',
            minifyInternalExports: true,
            sourcemap: true,
            sourcemapExcludeSources: true,
            freeze: false,
            esModule: false,
          })

          await bundle.close()

          console.timeEnd('Generated Node.js cjs bundles')

          // 2. generate esm wrapper for Node.js
          console.time('Generated Node.js esm wrappers')
          await Promise.all(
            output
              .filter((chunk) => chunk.isEntry)
              .map(async ({ name, exports }) => {
                // exports: [ '*@twind/core', 'default', 'toColorValue' ]

                let wrapper = ''

                if (!exports.includes('default')) {
                  wrapper += `import __$$ from ${JSON.stringify('./' + name + '.cjs')};\n`
                  wrapper += `export default __$$;\n`
                }

                exports
                  .filter((name) => name[0] == '*')
                  .forEach((name) => {
                    wrapper += `export * from ${JSON.stringify(name.slice(1))};\n`
                  })

                const namedExports = exports.filter((name) => name[0] != '*')
                if (namedExports.length) {
                  wrapper += `export { ${namedExports.join(', ')} } from ${JSON.stringify(
                    './' + name + '.cjs',
                  )};\n`
                }

                await fs.writeFile(path.resolve(paths.dist, name + '.mjs'), wrapper)
              }),
          )

          console.timeEnd('Generated Node.js esm wrappers')
        },
        async () => {
          console.time('Generated browser global bundles')

          await Promise.all(
            entryPoints
              .filter(({ conditions }) => conditions.browser || conditions.default)
              .map(async ({ outputFile, conditions }) => {
                const inputFile = conditions.browser || conditions.default

                const bundle = await rollup({
                  input: inputFile,
                  external: external.filter(
                    (dependency) => !bundledDependencies.includes(dependency),
                  ),
                  preserveEntrySignatures: 'strict',
                  treeshake: {
                    propertyReadSideEffects: false,
                  },
                  onwarn(warning, warn) {
                    if (warning.code === 'CIRCULAR_DEPENDENCY') return

                    // Use default for everything else
                    warn(warning)
                  },
                  plugins: [
                    nodeResolve({
                      browser: true,
                      extensions: resolveExtensions,
                      mainFields: [
                        'esnext',
                        'esmodules',
                        'modern',
                        'es2015',
                        'module',
                        'browser',
                        'jsnext:main',
                        'main',
                      ],
                      exportConditions: [
                        'production',
                        'esnext',
                        'modern',
                        'esmodules',
                        'es2015',
                        'module',
                        'import',
                        'default',
                        'require',
                        'browser',
                      ],
                    }),
                    esbuild({
                      exclude: null,
                      // platform: 'neutral',
                      target: targets.script,
                      tsconfig: paths.tsconfig,
                      // TODO optimizeDeps: ['vue', 'vue-router'],
                      define: {
                        'process.browser': true,
                        'process.env.NODE_ENV': `"production"`,
                      },
                      // TODO maybe configurable
                      loaders: {
                        // Add .json files support
                        // require @rollup/plugin-commonjs
                        '.json': 'json',
                        // Enable JSX in .js files too
                        '.js': 'jsx',
                      },
                    }),
                    dynamicImportVars({ warnOnError: true }),
                  ],
                })

                await bundle.write({
                  format: 'iife',
                  file: path.resolve(paths.dist, `${outputFile}.global.js`),
                  assetFileNames: '_/assets/[name]-[hash][extname]',
                  name:
                    mainEntryPoint == outputFile
                      ? globalName
                      : camelize(globalName + '-' + outputFile),
                  // TODO configureable globals
                  globals: (id) => {
                    return (
                      {
                        lodash: '_',
                        'lodash-es': '_',
                        jquery: '$',
                      }[id] || camelize(id)
                    )
                  },
                  generatedCode: 'es2015',
                  preferConst: true,
                  hoistTransitiveImports: false,
                  interop: 'auto',
                  minifyInternalExports: true,
                  sourcemap: true,
                  sourcemapExcludeSources: true,
                  freeze: false,
                  esModule: false,
                  plugins: [
                    terser({
                      ecma: Number(targets.script.slice(2)), // specify one of: 5, 2015, 2016, etc.
                      warnings: true,
                      compress: {
                        keep_infinity: true,
                        pure_getters: true,
                        // Ideally we'd just get Terser to respect existing Arrow functions...
                        // unsafe_arrows: true,
                        passes: 10,
                      },
                      format: {
                        // By default, Terser wraps function arguments in extra parens to trigger eager parsing.
                        // Whether this is a good idea is way too specific to guess, so we optimize for size by default:
                        wrap_func_args: false,
                      },
                    }),
                  ],
                })

                await bundle.close()
              }),
          )

          console.timeEnd('Generated browser global bundles')
        },
        async () => {
          console.time('Bundled typescript declarations')
          await Promise.all(
            entryPoints.map(({ outputFile, conditions }) => {
              return generateTypesBundle(
                conditions.default || conditions.browser || conditions.node,
                path.resolve(paths.dist, `${outputFile}.d.ts`),
              )
            }),
          )
          console.timeEnd('Bundled typescript declarations')
        },
      ].map((task) => task()),
    )
  }

  async function generateTypesBundle(inputFile, dtsFile) {
    const typesDirectory = await typesDirectoryPromise

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
      sourcemapExcludeSources: true,
      freeze: false,
      esModule: false,
      preferConst: true,
      exports: 'auto',
    })
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
            module: 'ESNext',
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

function camelize(str) {
  return str.replace(/[^a-z\d]+([a-z\d])/gi, (_, $1) => $1.toUpperCase())
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
