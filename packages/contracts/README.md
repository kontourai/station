# @kontourai/station-contracts

Station is Kontour's local-first agent workspace: you direct agent work, and the
gate verdicts, evidence, and trust state stay in the same context as the work.

This package holds Station's runtime, provider, and orchestration contracts —
the TypeScript types and constants shared between the Station host, the plugin
SDK, and plugin authors. It is types and constants only; there is no runtime
behavior here.

## Installation

```bash
npm install @kontourai/station-contracts
```

It is normally installed transitively as a dependency of
`@kontourai/station-sdk` or `@kontourai/station-shared`; install it directly
only when you need a contract subpath those packages do not re-export.

## Requires a bundler (ships TypeScript source)

This package publishes **raw TypeScript**. Every entry in `exports` points at a
`.ts` file under `src/`; there is no compiled `dist/`. That is deliberate — the
supported consumer is a Station plugin, whose `npm run build` calls
`buildPlugin()` from `@kontourai/station-shared/build` and bundles the plugin
with esbuild, which reads `.ts` from `node_modules` directly.

- **Supported:** esbuild, Vite, webpack, Rollup, or any TS-aware loader/runtime
  (`tsx`, `ts-node`, Bun, Deno).
- **Not supported today:** plain-Node `require()` / `import` of this package
  without a TS-aware step.

This is a disclosed constraint, not an accident. If you need a precompiled
build for a non-bundled runtime, open an issue.

## Usage

```ts
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { DEFAULT_GUARDRAILS } from '@kontourai/station-contracts/agent';
```

The root export (`@kontourai/station-contracts`) re-exports the common
contracts; the subpath exports listed in `package.json` give you one module per
contract domain (`/agent`, `/plugin`, `/runtime`, `/workflow`, …).

For the plugin walkthrough these contracts describe, see the
[`@kontourai/station-sdk`](https://www.npmjs.com/package/@kontourai/station-sdk)
README.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
