# @kontourai/station-shared

Station is Kontour's local-first agent workspace: you direct agent work, and the
gate verdicts, evidence, and trust state stay in the same context as the work.
Plugins are how the workspace is extended — a plugin contributes layouts,
agents, MCP integrations, providers, and knowledge namespaces to the Station
shell.

This package holds the runtime helpers Station and its plugins share: plugin
manifest parsing, the esbuild-based plugin build (`buildPlugin`), config and
path helpers, redaction, and runtime-event projection. If you are building a
plugin, this is the package that builds it.

## Installation

```bash
npm install @kontourai/station-shared
```

## Requires a bundler (ships TypeScript source)

This package publishes **raw TypeScript**. Every entry in `exports` points at a
`.ts` file under `src/`; there is no compiled `dist/`. That is deliberate — the
supported consumer is a Station plugin, whose `npm run build` calls
`buildPlugin()` from `@kontourai/station-shared/build` and bundles the plugin
with esbuild, which reads `.ts` from `node_modules` directly.

- **Supported:** esbuild, Vite, webpack, Rollup, or any TS-aware loader/runtime
  (`tsx`, `ts-node`, Bun, Deno). The plugin build entry point
  (`@kontourai/station-shared/build`) runs under Node via a TS-aware loader such
  as `tsx`.
- **Not supported today:** plain-Node `require()` / `import` of this package
  without a TS-aware step.

This is a disclosed constraint, not an accident. If you need a precompiled
build for a non-bundled runtime, open an issue.

## Usage

```ts
import { buildPlugin } from '@kontourai/station-shared/build';
import { readPluginManifest } from '@kontourai/station-shared/parsers';

const result = await buildPlugin(process.cwd(), 'production');
console.log(result.bundlePath);
```

`buildPlugin` reads `plugin.json`, installs the plugin's own npm dependencies,
and bundles the manifest `entrypoint` with esbuild into `dist/bundle.js`,
externalizing the modules the Station host provides at runtime (React,
`@tanstack/react-query`, `@kontourai/station-sdk`, …).

Run that file with a TS-aware loader — the scaffolded plugin `package.json`
uses `tsx`:

```json
{
  "scripts": {
    "build": "tsx build.ts",
    "dev": "tsx build.ts --dev"
  }
}
```

The full plugin walkthrough — manifest, entrypoint, build script, and how to
load the bundle into a running Station — is in the
[`@kontourai/station-sdk`](https://www.npmjs.com/package/@kontourai/station-sdk)
README.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
