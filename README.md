# distilt

> bundle a project for node and browser using swc and rollup

[![MIT License](https://badgen.net/github/license/sastan/distilt)](https://github.com/sastan/distilt/blob/main/LICENSE)
[![Latest Release](https://flat.badgen.net/npm/v/distilt?icon=npm&label)](https://www.npmjs.com/package/distilt)
[![Github](https://flat.badgen.net/badge/icon/sastan%2Fdistilt?icon=github&label)](https://github.com/sastan/distilt)
[![PRs Welcome](https://flat.badgen.net/badge/PRs/welcome/purple)](http://makeapullrequest.com)

---

## Usage

```sh
npm i -D distilt
```

Add to your `package.json`:

```json
{
  "scripts": {
    "build": "distilt"
    "prepublishOnly": "npm run build"
  }
}
```

Add run:

```sh
npm build
```

This creates a `dist/` folder which is ready to be published:

```sh
npm publish dist
```

## Features

- nodejs bundle (CommonJS and ESM wrapper)
- browser bundles (ESM and IIFE)
- shared state between all exports
- typescript types
- bundled dependencies
  - `bundledDependencies` are always bundled
  - for script exports all `dependencies` are bundled except they are listed in `peerDependencies`
- [dynamic-import-vars](https://github.com/rollup/plugins/tree/master/packages/dynamic-import-vars)
- `@swc/helper` are inlined (only once) if not defined as a `dependency``
- customize [global name](https://rollupjs.org/guide/en/#outputname) for `script` exports
  1. doc-block comment in entry file: `/* @distilt-global-name useThisGlobalName */`
  2. `globalName` or `name` from `package.json` appended with current entry point name
- size-limit

## Input/Output

```
package.json

  "exports": {
    // platform: neutral
    ".": "./src/index.ts",
    "./web": {
      // platform: browser
      browser: "./src/web.ts",
    },
    "./node": {
      // platform: node
      "node": "./src/node.ts",
    },
  },

-------------
dist/package.json

  "exports": {
    ".": {
      // platform: neutral
      // bundle "./src/index.ts", "./src/web.ts", "./src/node.ts"
      "esnext": "./pkg.esnext.js",
      "module": "./pkg.js",

      // platform: browser
      // bundle "./src/index.ts", "./src/web.ts"
      "script": "./pkg.global.js",

      "types": "./pkg.d.ts",

      // platform: node
      // bundle "./src/index.ts", "./src/node.ts"
      "node": {
        "module": "./pkg.js",
        "import": "./pkg.mjs",
        "require": "./pkg.cjs"
      },

      // platform: neutral
      // bundle "./src/index.ts", "./src/web.ts", "./src/node.ts"
      "default": "./pkg.js"
    },
    "./web": {
      // platform: neutral
      // bundle "./src/index.ts", "./src/web.ts", "./src/node.ts"
      "esnext": "./web.esnext.js",
      "module": "./web.js",

      // platform: browser
      // bundle "./src/index.ts" and "./src/web.ts"
      "script": "./web.global.js",

      "types": "./web.d.ts",

      // platform: neutral
      // bundle "./src/index.ts", "./src/web.ts", "./src/node.ts"
      "default": "./web.js"
    },
    "./node": {
      // platform: neutral
      // bundle "./src/index.ts", "./src/web.ts", "./src/node.ts"
      "esnext": "./node.esnext.js",
      "module": "./node.js",

      "types": "./node.d.ts",

      // platform: node
      // bundle "./src/index.ts" and "./src/node.ts"
      "node": {
        "module": "./node.js",
        "import": "./node.mjs",
        "require": "./node.cjs"
      },

      // platform: neutral
      // bundle "./src/index.ts", "./src/web.ts", "./src/node.ts"
      "default": "./node.js"
    },
  },
```

## License

[MIT](https://github.com/sastan/distilt/blob/main/LICENSE)
