#!/usr/bin/env node

import { existsSync, accessSync, readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { findUpSync } from 'find-up'
import normalizeData from 'normalize-package-data'
import { globby } from 'globby'
import { makeLegalIdentifier } from '@rollup/pluginutils'

import { rollup } from 'rollup'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import * as dynamicImportVarsNS from '@rollup/plugin-dynamic-import-vars'
import json from '@rollup/plugin-json'
import replace from '@rollup/plugin-replace'
import inject from '@rollup/plugin-inject'

import * as tsPathsNS from 'rollup-plugin-tsconfig-paths'

import { transform, minify } from '@swc/core'

import dts from 'rollup-plugin-dts'
import { execa } from 'execa'

import semver from 'semver'

const dynamicImportVars = dynamicImportVarsNS.default?.default || dynamicImportVarsNS.default
const tsPaths = tsPathsNS.default?.default || tsPathsNS.default

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

  return { current, workspace, root, relative: path.relative(workspace, root), dist, tsconfig }
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
      dependencies: { ...workspaceManifest.dependencies, ...packageManifest.dependencies },
      devDependencies: { ...workspaceManifest.devDependencies, ...packageManifest.devDependencies },
      peerDependencies: {
        ...workspaceManifest.peerDependencies,
        ...packageManifest.peerDependencies,
      },
      peerDependenciesMeta: {
        ...workspaceManifest.peerDependenciesMeta,
        ...packageManifest.peerDependenciesMeta,
      },
    }),
  )

  normalizeData(workspaceManifest)
  normalizeData(packageManifest)

  const manifest = {
    ...workspaceManifest,
    ...packageManifest,
    ...allDepdenciesManifest,
  }

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
      directory: path.relative(paths.workspace, paths.root),
    }
  }

  if (manifest.publishConfig?.directory) {
    paths.dist = path.resolve(paths.root, manifest.publishConfig.directory)
  }

  const resolveExtensions = ['.tsx', '.ts', '.jsx', '.mjs', '.js', '.cjs', '.css', '.json']

  const globalName = manifest.globalName || manifest.amdName || makeGlobalName(manifest.name)

  const targets = {
    node:
      manifest.publishConfig?.targets?.node ??
      (await (async (nodeTarget = '14.x') => {
        const minNodeVersion = semver.minVersion(nodeTarget)

        for (const [esversion, nodeRange] of [
          // ['es2023', '>=18.0.0'], // TODO: not yet supported by swc
          ['es2022', '>=16.11.0'],
          ['es2021', '>=15.0.0'],
          ['es2020', '>=14.0.0'],
          ['es2019', '>=12.0.0'],
        ]) {
          if (semver.satisfies(minNodeVersion, nodeRange)) {
            return esversion
          }
        }

        return 'es2018' // >=10.0.0
      })(manifest.engines?.node)),
    module: manifest.publishConfig?.targets?.module ?? 'es2021',
    script: manifest.publishConfig?.targets?.script ?? 'es2017',
    browser: manifest.publishConfig?.targets?.browser ?? 'es2019',
    esnext: manifest.publishConfig?.targets?.esnext ?? 'es2022',
  }

  // Bundled dependencies are included in every bundle
  const bundledDependencies = [
    ...(manifest.bundledDependencies || []),
    ...(manifest.bundleDependencies || []),
  ]

  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  })

  // all dependencies and peerDependencies are marked as external
  // except for bundledDependencies
  const external = dependencies.filter((dependency) => !bundledDependencies.includes(dependency))

  // except when bundling `script` conditions — their only the peerDependencies are marked as external
  const scriptExternal = Object.keys(manifest.peerDependencies).filter(
    (dependency) => !bundledDependencies.includes(dependency),
  )

  // The package itself is external as well
  external.push(manifest.name)

  let needsDevelopmentBuild = false

  function swc({ mode, format, ...options } = {}) {
    // https://github.com/swc-project/swc/blob/main/crates/swc_ecma_minifier/src/option/terser.rs#L429
    const ecma = Math.min(2020, Number((options.jsc.target || 'es2015').slice(2)))

    return {
      name: 'swc',
      resolveId(source) {
        if (source === '@swc/helpers' || source.startsWith('@swc/helpers/')) {
          if (manifest.dependencies['@swc/helpers']) {
            // TODO: verify semver matches
          } else {
            manifest.dependencies['@swc/helpers'] = `^${
              createRequire(import.meta.url)('@swc/helpers/package.json').version
            }`
          }

          if (format === 'iife') {
            return this.resolve(source, fileURLToPath(import.meta.url), { skipSelf: true }).then(
              (resolved) => {
                return resolved && { ...resolved, external: false }
              },
            )
          }

          if (format === 'cjs') {
            source = source.replace('/src/', '/lib/').replace(/\.mjs$/, '.js')
          }

          return { id: source, external: true }
        }
      },
      async transform(code, filename) {
        if (!needsDevelopmentBuild) {
          needsDevelopmentBuild = /from\s+(["'])distilt\/env\1/.test(code)
        }

        return transform(code, {
          ...options,
          envName: mode,
          // https://swc.rs/docs/configuration/modules
          module: {
            type: 'es6',
            strictMode: false,
            ignoreDynamic: true,
            ...options.module,
          },
          jsc: {
            // TODO enable loose? https://2ality.com/2015/12/babel6-loose-mode.html
            loose: false,
            externalHelpers: true,
            // Enabling this option will make swc preserve original class names.
            keepClassNames: true,

            ...options.jsc,

            // https://swc.rs/docs/configuration/compilation#jscparser
            parser: {
              // TODO based on input files: typescript or ecmascript
              syntax: 'typescript',
              ...options.jsc.parser,
            },

            // https://swc.rs/docs/configuration/compilation#jsctransform
            transform: {
              ...options.jsc.transform,

              // https://swc.rs/docs/configuration/compilation#jsctransformconstmodules
              constModules: {
                ...options.jsc.transform?.constModules,
                globals: {
                  ...options.jsc.transform?.constModules?.globals,
                  'distilt/env': {
                    // TODO: add target like node, browser, script, module, esnext
                    MODE: JSON.stringify(mode === 'development' ? 'development' : 'production'),
                    DEV: String(mode === 'development'),
                    PROD: String(mode !== 'development'),
                    ...options.jsc.transform?.constModules?.globals?.['distilt/env'],
                  },
                },
              },

              react: {
                // https://reactjs.org/blog/2020/09/22/introducing-the-new-jsx-transform.html
                runtime: 'automatic',
                // Use Object.assign() instead of _extends
                useBuiltins: true,
                ...options.jsc.transform?.react,
              },
            },

            experimental: {
              keepImportAssertions: true,
              ...options.jsc.experimental,
            },

            preserveAllComments: true,
            minify: undefined,
          },

          sourceMaps: true,
          minify: false,
          filename,
        })
      },
      renderChunk(code, chunk) {
        if (options.minify) {
          return minify(code, {
            // https://github.com/swc-project/swc/blob/main/crates/swc_ecma_minifier/src/option/terser.rs#L429
            ecma,
            mangle: true,
            // https://swc.rs/docs/configuration/minification
            ...options.jsc.minify,
            compress: {
              ecma,
              passes: 0,
              keep_infinity: true,
              pure_getters: true,
              keep_fargs: false,
              typeofs: false,
              unsafe_symbols: mode === 'production',
              const_to_let: true,
              ...options.jsc.minify?.compress,
            },
            sourceMap: true,
            outputPath: chunk.fileName,
          })
        } else {
          // return
          return transform(code, {
            ...options,
            envName: mode,
            // https://swc.rs/docs/configuration/modules
            module: {
              type: 'es6',
              strictMode: false,
              ignoreDynamic: true,
              ...options.module,
            },
            jsc: {
              // TODO enable loose? https://2ality.com/2015/12/babel6-loose-mode.html
              loose: false,
              externalHelpers: true,
              // Enabling this option will make swc preserve original class names.
              keepClassNames: true,

              ...options.jsc,

              // https://swc.rs/docs/configuration/compilation#jscparser
              parser: {
                // TODO based on input files: typescript or ecmascript
                syntax: 'typescript',
                ...options.jsc.parser,
              },

              // https://swc.rs/docs/configuration/compilation#jsctransform
              transform: undefined,

              experimental: {
                keepImportAssertions: true,
                ...options.jsc.experimental,
              },

              preserveAllComments: true,
              minify: {
                compress: {
                  ecma,
                  defaults: true,
                  passes: 0,
                  booleans: false,
                  arrows: false,
                  booleans: false,
                  keep_classnames: true,
                  keep_fnames: true,
                  keep_infinity: true,
                  sequences: false,
                  typeofs: false,
                  unsafe_symbols: mode === 'production',
                  const_to_let: true,
                },
                mangle: false,
              },
            },

            sourceMaps: true,
            minify: false,
            filename: chunk.fileName,
          })
        }
      },
    }
  }

  // 'commonjs' or 'module'
  const type = manifest.type || 'module'
  const cjsExt = type === 'commonjs' ? '.js' : '.cjs'

  const publishManifest = {
    ...manifest,

    type,

    exports: manifest.exports
      ? {
          ...manifest.exports,
          // Allow access to package.json
          './package.json': './package.json',
        }
      : manifest.source || manifest.main
      ? {
          '.': manifest.source || manifest.main,
          // Allow access to package.json
          './package.json': './package.json',
        }
      : {
          // Allow access to package.json
          './package.json': './package.json',
        },

    // Allow publish
    private: undefined,

    // Include all files in the dist folder
    files: undefined,

    // Clean up publish config
    publishConfig: {
      ...manifest.publishConfig,
      // Remove directory as it is no longer needed
      directory: undefined,
      // Remove distilt options
      targets: undefined,
    },

    // These are not needed any more
    source: undefined,
    scripts: undefined,
    packageManager: undefined,
    engines: manifest.engines && {
      ...manifest.engines,
      npm: undefined,
      yarn: undefined,
      pnpm: undefined,
    },
    workspaces: undefined,

    // Reset bundledDependencies as rollup includes those into the bundle
    bundledDependencies: undefined,
    bundleDependencies: undefined,

    // not needed for published packages
    devDependencies: undefined,

    // Reset config sections
    pnpm: undefined,
    typedoc: undefined,
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
  console.time(`Bundled ${manifest.name}@${manifest.version}`)

  await prepare()

  const typesDirectoryPromise = paths.tsconfig && generateTypescriptDeclarations()

  try {
    await Promise.all([copyFiles(), generateMultiBundles()])
  } finally {
    const typesDirectory = await typesDirectoryPromise
    typesDirectory && (fs.rm || fs.rmdir)(typesDirectory, { force: true, recursive: true })
  }

  console.timeEnd(`Bundled ${manifest.name}@${manifest.version}`)

  if (packageManifest['size-limit']) {
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
    let mainEntryPoint

    const entryPoints = Object.entries(publishManifest.exports)
      .map(([entryPoint, conditions]) => {
        if (typeof conditions === 'string') {
          conditions = { default: conditions }
        }

        // Support default -> neutral, browser -> browser, node -> node
        if (!(conditions.default || conditions.browser || conditions.node)) {
          return
        }

        if (
          !Object.values(conditions).every(
            (inputFile) => inputFile === null || /\.([mc]js|[jt]sx?)$/.test(inputFile),
          )
        ) {
          return
        }

        const outputFile = entryPoint === '.' ? './' + manifest.name.split('/').pop() : entryPoint

        if (entryPoint === '.') {
          mainEntryPoint = outputFile.slice(2)
        }

        // Define package loading
        // https://gist.github.com/sokra/e032a0f17c1721c71cfced6f14516c62
        publishManifest.exports[entryPoint] = {
          // typescript
          types: paths.tsconfig ? `${outputFile}.d.ts` : undefined,

          development: undefined,

          // used by bundlers — compatible with current Spec and stage 4 proposals
          esnext:
            targets.esnext && conditions.esnext !== null ? `${outputFile}.esnext.js` : undefined,

          // used by bundlers
          module: targets.module
            ? `${outputFile}${type === 'commonjs' ? '.esm' : ''}.js`
            : undefined,

          // used by some bundlers and jspm.dev
          browser:
            targets.browser && conditions.browser !== null
              ? (conditions.browser || conditions.default) && `${outputFile}.browser.js`
              : undefined,

          // for direct script usage
          script:
            targets.script && conditions.script !== null
              ? (conditions.script || conditions.browser || conditions.default) &&
                `${outputFile}.global.js`
              : undefined,

          // Node.js
          node:
            targets.node && conditions.node !== null
              ? (conditions.node || conditions.default) && {
                  // nodejs esm wrapper
                  import: `${outputFile}.mjs`,
                  require: `${outputFile}${cjsExt}`,
                }
              : undefined,

          default: undefined,
        }

        if (!publishManifest.exports[entryPoint].default) {
          publishManifest.exports[entryPoint].default =
            publishManifest.exports[entryPoint].module ||
            (type === 'commonjs'
              ? publishManifest.exports[entryPoint].node?.require
              : publishManifest.exports[entryPoint].node?.import) ||
            publishManifest.exports[entryPoint].esnext ||
            publishManifest.exports[entryPoint].script
        }

        return {
          entryPoint,
          outputFile: outputFile.slice(2),
          conditions,
        }
      })
      .filter(Boolean)

    if (publishManifest.exports['.']) {
      Object.assign(publishManifest, {
        // Used by node
        main: publishManifest.exports['.'].node?.require || publishManifest.exports['.'].module,
        // Used by bundlers like rollup and CDNs
        module: publishManifest.exports['.'].module,
        esnext: publishManifest.exports['.'].esnext,
        // Support common CDNs
        unpkg: publishManifest.exports['.'].script,
        jsdelivr: publishManifest.exports['.'].script,
        // Used by bundlers and jspm.dev
        browser: publishManifest.exports['.'].browser,
        // Typescript
        types: publishManifest.exports['.'].types,
      })
    }

    const manifestPath = path.resolve(paths.dist, 'package.json')
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })

    const generatedBundles = async (mode = 'production') => {
      const suffix = mode === 'development' ? '.dev' : ''

      await Promise.all(
        [
          async () => {
            if (!targets.esnext) return

            const inputs = entryPoints
              .filter(({ conditions }) => conditions.esnext !== null)
              .map(({ outputFile, conditions }) => [
                outputFile,
                conditions.default || conditions.browser || conditions.node,
              ])
              .filter(([_, source]) => source)

            if (!inputs.length) return

            console.time(`Generated esnext bundles (${targets.esnext}) [${mode}]`)

            const bundle = await rollup({
              input: Object.fromEntries(inputs),
              external: (source) =>
                external.includes(source) ||
                external.some((external) => source.startsWith(external + '/')),
              preserveEntrySignatures: 'strict',
              treeshake: {
                propertyReadSideEffects: false,
              },
              onwarn(warning, warn) {
                if (
                  warning.code === 'CIRCULAR_DEPENDENCY' ||
                  (warning.code === 'UNRESOLVED_IMPORT' && warning.source?.startsWith('node:'))
                ) {
                  return
                }

                // Use default for everything else
                warn(warning)
              },
              plugins: [
                tsPaths({ tsConfigPath: paths.tsconfig }),
                commonjs({
                  extensions: ['.cjs', '.js'],
                }),
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
                    mode,
                    'esnext',
                    'modern',
                    'esmodules',
                    'es2015',
                    'module',
                    'import',
                    'require',
                    'default',
                  ],
                }),
                json({ preferConst: true }),
                swc({ mode, format: 'es', jsc: { target: targets.esnext } }),
                dynamicImportVars({ warnOnError: true }),
              ],
            })

            await bundle.write({
              format: 'es',
              dir: paths.dist,
              entryFileNames: `[name].esnext${suffix}.js`,
              chunkFileNames: `_/[name]-[hash].js`,
              assetFileNames: '_/assets/[name]-[hash][extname]',
              generatedCode: {
                preset: 'es2015',
                arrowFunctions: true,
                constBindings: true,
                objectShorthand: true,
                // prevent: [Symbol.toStringTag]: { value: 'Module' }
                symbols: false,
              },
              hoistTransitiveImports: false,
              interop: 'auto',
              minifyInternalExports: false,
              sourcemap: true,
              freeze: false,
              esModule: false,
            })

            await bundle.close()

            console.timeEnd(`Generated esnext bundles (${targets.esnext}) [${mode}]`)
          },
          async () => {
            if (!targets.module) return

            const inputs = entryPoints
              .map(({ outputFile, conditions }) => [
                outputFile,
                conditions.default || conditions.browser || conditions.node,
              ])
              .filter(([_, source]) => source)

            if (!inputs.length) return

            console.time(`Generated module bundles (${targets.module}) [${mode}]`)

            const bundle = await rollup({
              input: Object.fromEntries(inputs),
              external: (source) =>
                external.includes(source) ||
                external.some((external) => source.startsWith(external + '/')),
              preserveEntrySignatures: 'strict',
              treeshake: {
                propertyReadSideEffects: false,
              },
              onwarn(warning, warn) {
                if (
                  warning.code === 'CIRCULAR_DEPENDENCY' ||
                  (warning.code === 'UNRESOLVED_IMPORT' && warning.source?.startsWith('node:'))
                ) {
                  return
                }

                // Use default for everything else
                warn(warning)
              },
              plugins: [
                tsPaths({ tsConfigPath: paths.tsconfig }),
                commonjs({
                  extensions: ['.cjs', '.js'],
                }),
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
                    mode,
                    'esnext',
                    'modern',
                    'esmodules',
                    'es2015',
                    'module',
                    'import',
                    'require',
                    'default',
                  ],
                }),
                json({ preferConst: true }),
                swc({ mode, format: 'es', jsc: { target: targets.module } }),
                dynamicImportVars({ warnOnError: true }),
              ],
            })

            await bundle.write({
              format: 'es',
              dir: paths.dist,
              entryFileNames: `[name]${type === 'commonjs' ? '.esm' : ''}${suffix}.js`,
              chunkFileNames: `_/[name]-[hash].js`,
              assetFileNames: '_/assets/[name]-[hash][extname]',
              generatedCode: {
                preset: 'es2015',
                arrowFunctions: true,
                constBindings: true,
                objectShorthand: true,
                // prevent: [Symbol.toStringTag]: { value: 'Module' }
                symbols: false,
              },
              hoistTransitiveImports: false,
              interop: 'auto',
              minifyInternalExports: false,
              sourcemap: true,
              freeze: false,
              esModule: false,
            })

            await bundle.close()

            console.timeEnd(`Generated module bundles (${targets.module}) [${mode}]`)
          },
          async () => {
            if (!targets.node) return

            const inputs = entryPoints
              .filter(({ conditions }) => conditions.node !== null)
              .map(({ outputFile, conditions }) => [
                outputFile,
                conditions.node || conditions.default,
              ])
              .filter(([_, source]) => source)

            if (!inputs.length) return

            console.time(`Generated Node.js cjs bundles (${targets.node}) [${mode}]`)

            const bundle = await rollup({
              input: Object.fromEntries(inputs),
              external: (source) =>
                external.includes(source) ||
                external.some((external) => source.startsWith(external + '/')),
              preserveEntrySignatures: 'strict',
              treeshake: {
                propertyReadSideEffects: false,
              },
              onwarn(warning, warn) {
                if (
                  warning.code === 'CIRCULAR_DEPENDENCY' ||
                  (warning.code === 'UNRESOLVED_IMPORT' && warning.source?.startsWith('node:'))
                ) {
                  return
                }

                // Use default for everything else
                warn(warning)
              },
              plugins: [
                tsPaths({ tsConfigPath: paths.tsconfig }),
                commonjs({
                  extensions: ['.cjs', '.js'],
                }),
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
                    mode,
                    'esnext',
                    'modern',
                    'esmodules',
                    'es2015',
                    'module',
                    'import',
                    'require',
                    'default',
                  ],
                }),
                json({ preferConst: true }),
                swc({
                  mode,
                  format: 'cjs',
                  jsc: {
                    target: targets.node,
                    // https://swc.rs/docs/configuration/compilation#jsctransform
                    transform: {
                      // https://swc.rs/docs/configuration/compilation#jsctransformoptimizer
                      optimizer: {
                        globals: {
                          // If you set { "window": "object" }, typeof window will be replaced with "object".
                          typeofs: {
                            self: 'undefined',
                            window: 'undefined',
                            document: 'undefined',
                            process: 'object',
                          },
                        },
                      },
                    },
                  },
                }),
                dynamicImportVars({ warnOnError: true }),
                replace({
                  preventAssignment: true,
                  values: {
                    'process.browser': false,
                    'import.meta.url': '__$$shim_import_meta_url',
                    'import.meta.resolve': '__$$shim_import_meta_resolve',
                  },
                }),
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
              entryFileNames: `[name]${suffix}${cjsExt}`,
              chunkFileNames: `_/[name]-[hash]${cjsExt}`,
              assetFileNames: '_/assets/[name]-[hash][extname]',
              generatedCode: {
                preset: 'es2015',
                arrowFunctions: true,
                constBindings: true,
                objectShorthand: true,
                // add: [Symbol.toStringTag]: { value: 'Module' }
                symbols: true,
              },
              hoistTransitiveImports: false,
              interop: 'auto',
              minifyInternalExports: false,
              sourcemap: true,
              freeze: true,
              esModule: true,
              strict: true,
            })

            await bundle.close()

            console.timeEnd(`Generated Node.js cjs bundles (${targets.node}) [${mode}]`)

            // 2. generate esm wrapper for Node.js
            console.time(`Generated Node.js esm wrappers [${mode}]`)
            await Promise.all(
              output
                .filter((chunk) => chunk.isEntry)
                .map(async ({ name, exports }) => {
                  // exports: [ '*@twind/core', 'default', 'toColorValue' ]

                  let wrapper = ''

                  if (!exports.includes('default')) {
                    wrapper += `import __$$ from ${JSON.stringify(
                      `./${name}${suffix}${cjsExt}`,
                    )};\n`
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
                      `./${name}${suffix}${cjsExt}`,
                    )};\n`
                  }

                  await fs.writeFile(path.resolve(paths.dist, `${name}${suffix}.mjs`), wrapper)
                }),
            )

            console.timeEnd(`Generated Node.js esm wrappers [${mode}]`)
          },
          async () => {
            if (!targets.browser) return

            const inputs = entryPoints
              .filter(({ conditions }) => conditions.browser !== null)
              .map(({ outputFile, conditions }) => [
                outputFile,
                conditions.browser || conditions.default,
              ])
              .filter(([_, source]) => source)

            if (!inputs.length) return

            console.time(`Generated browser bundles (${targets.browser}) [${mode}]`)

            const bundle = await rollup({
              input: Object.fromEntries(inputs),
              external: (source) =>
                external.includes(source) ||
                external.some((external) => source.startsWith(external + '/')),
              preserveEntrySignatures: 'strict',
              treeshake: {
                propertyReadSideEffects: false,
              },
              onwarn(warning, warn) {
                if (warning.code === 'CIRCULAR_DEPENDENCY') {
                  return
                }

                if (warning.code === 'UNRESOLVED_IMPORT' && warning.source?.startsWith('node:')) {
                  throw new Error(warning.message)
                }

                // Use default for everything else
                warn(warning)
              },
              plugins: [
                tsPaths({ tsConfigPath: paths.tsconfig }),
                commonjs({
                  extensions: ['.cjs', '.js'],
                }),
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
                    mode,
                    'esnext',
                    'modern',
                    'esmodules',
                    'es2015',
                    'module',
                    'import',
                    'require',
                    'default',
                    'browser',
                  ],
                }),
                json({ preferConst: true }),
                swc({
                  mode,
                  format: 'es',
                  jsc: {
                    target: targets.browser, // https://swc.rs/docs/configuration/compilation#jsctransform
                    transform: {
                      // https://swc.rs/docs/configuration/compilation#jsctransformoptimizer
                      optimizer: {
                        globals: {
                          // If you set { "window": "object" }, typeof window will be replaced with "object".
                          typeofs: {
                            self: 'object',
                            window: 'object',
                            document: 'object',
                            process: 'undefined',
                          },
                        },
                      },
                    },

                    // https://2ality.com/2015/12/babel6-loose-mode.html
                    loose: true,
                    keepClassNames: false,
                  },
                  minify: true,
                }),
                replace({
                  preventAssignment: true,
                  values: {
                    'process.browser': true,
                    'process.env.NODE_ENV': JSON.stringify(mode),
                  },
                }),
                dynamicImportVars({ warnOnError: true }),
              ],
            })

            await bundle.write({
              format: 'es',
              dir: paths.dist,
              entryFileNames: `[name].browser${suffix}.js`,
              chunkFileNames: `_/[name]-[hash].js`,
              assetFileNames: '_/assets/[name]-[hash][extname]',
              compact: true,
              generatedCode: {
                preset: 'es2015',
                arrowFunctions: true,
                constBindings: true,
                objectShorthand: true,
                // prevent: [Symbol.toStringTag]: { value: 'Module' }
                symbols: false,
              },
              hoistTransitiveImports: false,
              interop: 'auto',
              minifyInternalExports: true,
              sourcemap: true,
              freeze: false,
              esModule: false,
            })

            await bundle.close()

            console.timeEnd(`Generated browser bundles (${targets.browser}) [${mode}]`)
          },

          async () => {
            if (!targets.script) return

            const inputs = entryPoints.filter(
              ({ conditions }) =>
                conditions.script !== null &&
                (conditions.script || conditions.browser || conditions.default),
            )

            if (!inputs.length) return

            console.time(`Generated script bundles (${targets.script}) [${mode}]`)

            await Promise.all(
              inputs.map(async ({ outputFile, conditions }) => {
                const inputFile = conditions.script || conditions.browser || conditions.default

                const bundle = await rollup({
                  input: inputFile,
                  external: (source) =>
                    scriptExternal.includes(source) ||
                    scriptExternal.some((external) => source.startsWith(external + '/')),
                  preserveEntrySignatures: 'strict',
                  treeshake: {
                    propertyReadSideEffects: false,
                  },
                  onwarn(warning, warn) {
                    if (warning.code === 'CIRCULAR_DEPENDENCY') {
                      return
                    }

                    if (
                      warning.code === 'UNRESOLVED_IMPORT' &&
                      warning.source?.startsWith('node:')
                    ) {
                      throw new Error(warning.message)
                    }

                    // Use default for everything else
                    warn(warning)
                  },
                  plugins: [
                    tsPaths({ tsConfigPath: paths.tsconfig }),
                    commonjs({
                      extensions: ['.cjs', '.js'],
                    }),
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
                        mode,
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
                    json({ preferConst: true }),
                    swc({
                      mode,
                      format: 'iife',
                      jsc: {
                        target: targets.script,
                        // https://swc.rs/docs/configuration/compilation#jsctransform
                        transform: {
                          // https://swc.rs/docs/configuration/compilation#jsctransformoptimizer
                          optimizer: {
                            globals: {
                              // If you set { "window": "object" }, typeof window will be replaced with "object".
                              typeofs: {
                                self: 'object',
                                window: 'object',
                                document: 'object',
                                process: 'undefined',
                              },
                            },
                          },
                        },

                        // https://2ality.com/2015/12/babel6-loose-mode.html
                        loose: true,
                        keepClassNames: false,
                      },

                      minify: true,
                    }),
                    replace({
                      preventAssignment: true,
                      values: {
                        'process.browser': true,
                        'process.env.NODE_ENV': JSON.stringify(mode),
                      },
                    }),
                    dynamicImportVars({ warnOnError: true }),
                  ],
                })

                const content = await fs.readFile(inputFile, { encoding: 'utf-8' })

                const name =
                  content.match(/\/\*\s*@distilt-global-name\s+(\S+)\s*\*\//)?.[1] ||
                  (mainEntryPoint === outputFile
                    ? globalName
                    : globalName + '_' + makeGlobalName(outputFile))

                await bundle.write({
                  format: 'iife',
                  file: path.resolve(paths.dist, `${outputFile}.global${suffix}.js`),
                  assetFileNames: '_/assets/[name]-[hash][extname]',
                  name,
                  compact: true,
                  inlineDynamicImports: true,
                  // TODO configureable globals
                  globals: (id) => {
                    return (
                      {
                        lodash: '_',
                        'lodash-es': '_',
                        jquery: '$',
                      }[id] || makeGlobalName(id)
                    )
                  },
                  generatedCode: {
                    preset: 'es2015',
                    arrowFunctions: true,
                    constBindings: true,
                    objectShorthand: true,
                    // prevent: [Symbol.toStringTag]: { value: 'Module' }
                    symbols: false,
                  },
                  hoistTransitiveImports: false,
                  interop: 'auto',
                  minifyInternalExports: true,
                  sourcemap: true,
                  freeze: false,
                  esModule: false,
                  strict: true,
                })

                await bundle.close()
              }),
            )

            console.timeEnd(`Generated script bundles (${targets.script}) [${mode}]`)
          },
        ].map((task) => task()),
      )
    }

    await Promise.all([
      (async () => {
        await generatedBundles('production')

        if (needsDevelopmentBuild) {
          for (const { entryPoint } of entryPoints) {
            publishManifest.exports[entryPoint].development = {
              // used by bundlers — compatible with current Spec and stage 4 proposals
              esnext: publishManifest.exports[entryPoint].esnext?.replace(
                /\.([cm]?js)$/,
                '.dev.$1',
              ),

              // used by bundlers
              module: publishManifest.exports[entryPoint].module?.replace(
                /\.([cm]?js)$/,
                '.dev.$1',
              ),

              // for bundlers and jsbpm.dev
              browser: publishManifest.exports[entryPoint].browser?.replace(
                /\.([cm]?js)$/,
                '.dev.$1',
              ),

              // for direct script usage
              script: publishManifest.exports[entryPoint].script?.replace(
                /\.([cm]?js)$/,
                '.dev.$1',
              ),

              // Node.js
              node: publishManifest.exports[entryPoint].node && {
                // nodejs esm wrapper
                import: publishManifest.exports[entryPoint].node.import.replace(
                  /\.([cm]?js)$/,
                  '.dev.$1',
                ),
                require: publishManifest.exports[entryPoint].node.require.replace(
                  /\.([cm]?js)$/,
                  '.dev.$1',
                ),
              },

              default: publishManifest.exports[entryPoint].default?.replace(
                /\.([cm]?js)$/,
                '.dev.$1',
              ),
            }
          }

          await generatedBundles('development')
        }

        const readFile = (file) =>
          readFileSync(path.resolve(paths.dist, file), 'utf8').replace(
            /^\/\/# sourceMappingURL=\S+\.map$/m,
            '',
          )

        const createFacade = async (from, to, isCJS = false) => {
          const toFile = path.resolve(paths.dist, to)
          const fromFile = path.resolve(paths.dist, from)

          const target = path.relative(path.dirname(fromFile), toFile)
          const relative = target[0] === '.' ? target : `./${target}`

          let content
          if (isCJS) {
            content = `module.exports = require(${JSON.stringify(relative)});`
          } else {
            const { parse } = await import('es-module-lexer')
            const { 1: exports, 2: facade } = await parse(readFileSync(toFile, 'utf8'))

            content =
              [
                (facade || exports.some(({ n }) => n && n !== 'default')) &&
                  `export * from ${JSON.stringify(relative)};`,
                exports.some(({ n }) => n === 'default') &&
                  `export { default } from ${JSON.stringify(relative)};`,
              ]
                .filter(Boolean)
                .join('\n') || `import ${JSON.stringify(relative)};`
          }

          await fs.writeFile(fromFile, content)
          await fs.unlink(`${fromFile}.map`)
        }

        console.time('De-duplicated entry points based on content')
        // de-duplicate entryPoints
        for (const { entryPoint } of entryPoints) {
          if (needsDevelopmentBuild) {
            const {
              esnext,
              module,
              browser,
              node: { require: node } = {},
            } = publishManifest.exports[entryPoint]
            const {
              esnext: esnextDev,
              module: moduleDev,
              browser: browserDev,
              node: { require: nodeDev } = {},
            } = publishManifest.exports[entryPoint].development

            if (esnext && esnextDev && readFile(esnext) === readFile(esnextDev)) {
              await createFacade(esnextDev, esnext)
            }

            if (module && moduleDev && readFile(module) === readFile(moduleDev)) {
              await createFacade(moduleDev, module)
            }

            if (browser && browserDev && readFile(browser) === readFile(browserDev)) {
              await createFacade(browserDev, browser)
            }

            if (node && nodeDev && readFile(node) === readFile(nodeDev)) {
              await createFacade(nodeDev, node, true)
            }
          }

          // esnext maybe the same as module
          const { esnext, module } = publishManifest.exports[entryPoint]

          if (
            module &&
            esnext &&
            readFile(module) ==
              readFile(esnext).replace(
                /from '(.\[^'])\.esnext\.js';/g,
                `$1${type === 'commonjs' ? '.esm' : ''}.js`,
              )
          ) {
            await createFacade(esnext, module)
          }
        }

        console.timeEnd('De-duplicated entry points based on content')
      })(),
      (async () => {
        console.time('Generated typescript bundles')
        await Promise.all(
          entryPoints.map(({ outputFile, conditions }) => {
            return generateTypesBundle(
              conditions.default || conditions.browser || conditions.node,
              path.resolve(paths.dist, `${outputFile}.d.ts`),
            )
          }),
        )
        console.timeEnd('Generated typescript bundles')
      })(),
    ])

    publishManifest.dependencies = Object.keys(manifest.dependencies).length
      ? manifest.dependencies
      : undefined

    await fs.writeFile(manifestPath, JSON.stringify(publishManifest, omitComments, 2))
  }

  async function generateTypesBundle(inputFile, dtsFile) {
    const typesDirectory = await typesDirectoryPromise

    inputFile = path.relative(path.dirname(paths.tsconfig), path.resolve(process.cwd(), inputFile))

    // './src/shim/index.ts'
    // => '.types/src/shim/index.ts'
    // => '.types/shim/index.ts'
    // => '.types/index.ts'

    const parts = inputFile.replace(/\.(ts|tsx)$/, '.d.ts').split(path.sep)

    if (paths.relative) {
      parts.unshift(...paths.relative.split(path.sep))
    }

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
      freeze: false,
      esModule: false,
      exports: 'auto',
      generatedCode: 'es2015'
    })
  }

  async function generateTypescriptDeclarations() {
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

    return typesDirectory
  }
}

function makeGlobalName(name) {
  // package -> package
  // package/export -> package_export
  // @scope/package -> scope.package
  // @scope/package/export -> scope.package_export
  return name.replace(/^(?:@([^/]+)\/)?(.+)/, (_, scope, name) => {
    return (
      (scope ? makeLegalIdentifier(scope).replace(/^_(?=.)/, '') + '.' : '') +
      makeLegalIdentifier(name).replace(/^_(?=.)/, '')
    )
  })
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
