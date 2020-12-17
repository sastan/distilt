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
  const inputFile = path.resolve(paths.root, manifest.source || manifest.main)

  const bundleName = manifest.name.replace('@', '').replace('/', '_')
  const globalName = manifest.globalName || manifest.name.replace('@', '').replace('/', '.')

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

  console.log(`Bundling ${manifest.name}@${manifest.version} (${path.relative(process.cwd(), inputFile)})`)

  await prepare()
  await Promise.all([
    copyFiles(),
    paths.tsconfig && generateTypescriptDeclarations(),
    generateBundles(),
  ])

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

  async function generateTypescriptDeclarations() {
    const dtsFile = path.resolve(paths.dist, `types/${bundleName}.d.ts`)

    console.time('Bundled ' + path.relative(process.cwd(), dtsFile))

    const typesDirectory = path.resolve(paths.dist, '.types')

    const tsconfig = path.resolve(path.dirname(paths.tsconfig), 'tsconfig.dist.json')

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

    const sourceDtsFile = await require('find-up')(
      path.basename(inputFile.replace(/\.(ts|tsx)$/, '.d.ts')),
      {
        cwd: path.resolve(typesDirectory, path.relative(paths.root, path.dirname(inputFile))),
      },
    )

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

    fs.rmdir(typesDirectory, { force: true, recursive: true })

    console.timeEnd('Bundled ' + path.relative(process.cwd(), dtsFile))
  }

  async function generateBundles() {
    const outputs = {}

    if (manifest.browser !== true) {
      Object.assign(outputs, {
        // Used by nodejs
        node: {
          outfile: `./node/${bundleName}.js`,
          platform: 'node',
          target: targets.node,
          format: 'cjs',
        },
      })
    }

    if (manifest.browser !== false) {
      Object.assign(outputs, {
        browser: {
          outfile: `./browser/${bundleName}.js`,
          platform: 'browser',
          target: targets.browser,
          format: 'esm',
          minify: true,
        },
        // Can be used from a normal script tag without module system.
        script: {
          outfile: `./script/${bundleName}.js`,
          platform: 'browser',
          target: 'es2015',
          format: 'iife',
          globalName,
          minify: true,
          external: false,
        },
      })
    }

    const publishManifest = {
      ...manifest,

      // Define package loading
      // https://gist.github.com/sokra/e032a0f17c1721c71cfced6f14516c62
      exports: {
        ...manifest.exports,
        '.': {
          // Only add if we have browser and node bundles
          node: outputs.browser && outputs.node && outputs.node.outfile,
          script: outputs.script && outputs.script.outfile,
          types: paths.tsconfig ? `./types/${bundleName}.d.ts` : undefined,
          default: outputs.browser ? outputs.browser.outfile : outputs.node.outfile,
        },

        // Allow access to all files (including package.json, ...)
        './': './',
      },

      // Used by node
      main: outputs.node && outputs.node.outfile,

      // Used by bundlers like rollup and CDNs
      module: outputs.browser && outputs.browser.outfile,

      unpkg: outputs.script && outputs.script.outfile,

      types: paths.tsconfig ? `./types/${bundleName}.d.ts` : undefined,

      // Some defaults
      sideEffects: manifest.sideEffects === true,

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

    await fs.writeFile(
      path.join(paths.dist, 'package.json'),
      JSON.stringify(publishManifest, null, 2),
    )

    const service = await require('esbuild').startService()

    try {
      await Promise.all(
        Object.entries(outputs)
          .filter(([, output]) => output)
          .map(async ([, output]) => {
            const outfile = path.resolve(paths.dist, output.outfile)

            const logKey = `Bundled ${path.relative(process.cwd(), outfile)} (${output.format} - ${
              output.target
            })`
            console.time(logKey)

            await service.build({
              ...output,
              outfile,
              entryPoints: [inputFile],
              charset: 'utf8',
              resolveExtensions: ['.tsx', '.ts', '.jsx', '.mjs', '.js', '.cjs', '.css', '.json'],
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
              sourcemap: 'external',
              tsconfig: paths.tsconfig,
            })

            console.timeEnd(logKey)
          }),
      )
    } finally {
      service.stop()
    }
  }
}
