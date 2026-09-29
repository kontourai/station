# @kontourai/station-contracts

This package owns cross-package domain shapes used by Station's server, SDK,
CLI and extensions. Import the owning domain subpath rather than an application
internal or a compatibility re-export.

The current surface includes types, constants and executable pure contract
helpers: for example, [child-work reducers](./src/child-work.ts),
[live-surface parsers](./src/live-surface.ts) and
[Task Basis page builders](./src/task-basis-mcp.ts). It is not a service or
transport implementation. Parsing a shape or slicing an already-authorized
collection does not grant access or establish that an operation occurred.

## Installation

```bash
npm install @kontourai/station-contracts
```

Declare it directly when your package imports its subpaths, even if the SDK or
shared package also depends on it. Use a release containing the required export;
this checkout's source is not evidence that a particular npm version is live.

## Source distribution

The [export map and file list](./package.json) expose `.ts` source under `src/`;
they do not select a compiled `dist/` package. Type-only imports can be erased
by the consumer; runtime constants and parsers need a toolchain that handles
the source and its imports. Station's esbuild plugin build is one such consumer.
Do not treat the source suffix alone as proof of compatibility with every
Node loader, bundler or alternate runtime.

## Usage

```ts
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { DEFAULT_GUARDRAILS } from '@kontourai/station-contracts/agent';
```

The root export re-exports a compatibility selection. The subpaths listed in
`package.json` are the authoritative domain inventory; the root does not imply
that every opt-in contract is re-exported. See the
[contracts reference](../../docs/reference/contracts.md) for ownership and
domain descriptions.

For the plugin walkthrough these contracts describe, see the
[`@kontourai/station-sdk`](../sdk/README.md)
README.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
