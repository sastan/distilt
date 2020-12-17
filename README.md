# distilt

> bundle a project for node and browser using esbuild

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

- nodejs bundle (CommonJS)
- browser bundles (ESM and IIFE)
- typescript types
- bundled dependencies
- size-limit

## License

[MIT](https://github.com/sastan/distilt/blob/main/LICENSE)
