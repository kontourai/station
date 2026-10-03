# @kontourai/station-shared

Runtime helpers shared by Station and its extensions: manifest parsing, plugin
builds, filesystem/process owners, redaction and event projections. Stable domain
contracts belong to [`station-contracts`](../contracts/README.md).

Use an explicit subpath for the helper you need. The root is a compatibility
barrel with selected helpers and contract re-exports, not a browser-safe catalog
of every export. [package.json](./package.json) is the entry-point inventory;
Node/filesystem helpers and browser-safe projections have different requirements.

## Installation

```bash
npm install @kontourai/station-shared
```

## Source entry points and runtime requirements

The manifest exports source: mostly `.ts`, with `.mjs` Node compatibility leaves
such as `/node-http-compat` and `/process-identity`. It declares Node **24.x**.
For the build helper, use Node 24 with a source-aware loader such as `tsx`;
browser consumers need a bundler and a browser-compatible subpath. These are
not interchangeable environments, and this README does not certify every
alternate runtime or loader. The package does not select a compiled `dist/` tree.

## Usage

```ts
import { buildPlugin } from '@kontourai/station-shared/build';
import { readPluginManifest } from '@kontourai/station-shared/parsers';

const result = await buildPlugin(process.cwd(), 'production');
if (result.built) console.log(result.bundlePath);
```

`readPluginManifest` reads and parses `plugin.json`; it is not an installation
approval. `buildPlugin` selects the manifest entrypoint, prepares dependencies,
and emits `dist/bundle.js` (`dist/bundle-dev.js` in dev mode), plus CSS when
present. It can mutate the authoring directory and install dependencies. A
manifest without an entrypoint produces a no-bundle result; manifest-controlled
shell build commands are refused.

The [build implementation](./src/build.ts) owns input/output containment,
dependency preparation and the exact shared-module allowlist. Root SDK,
SDK `/agent`, `/client` and `/voice`, React and React Query are among the externalized
modules; other SDK leaves are not automatically external. Bundles register with
Station's host runtime. Successful bundling does not install a plugin, approve
permissions or activate its server contributions.

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

These scripts must use the mode-selection build file in the
[SDK walkthrough](../sdk/README.md#start-from-npm); `--dev` produces one dev
bundle, not a watcher. Use that guide for manifest, entrypoint and installation
steps. Package availability on npm and live plugin activation are separate from
source/build verification.

Portable packages with visual Skill declarations also use this build path for
local author validation of referenced definitions and bundled Skill bytes.
See the [authoring contract](../../docs/reference/skill-experiences.md);
successful validation does not activate or render an experience.

## Registry authoring Node leaves

Candidate releases containing these exports provide `computePluginTreeDigest(root)`
from `@kontourai/station-shared/plugin-tree-digest` and
`registryPackageSignaturePayload(claim)` from
`@kontourai/station-shared/plugin-registry-signature`. They are explicit Node
subpaths, not root-barrel exports. The digest observes a source tree without
following symlinks and excludes root `.git` metadata; it does not grant execution
or prove materialization containment. Signature input uses the untrusted
`RegistryPackageClaim` shape from `@kontourai/station-contracts/registry-trust`.

Use a release containing these leaves or packaged candidates from the reviewed
checkout. A source change is not evidence that the exports are already on npm.
The [signing example](../../examples/registry/signed-package/README.md) uses a
TS-aware loader, keeps private keys outside the signed package, and leaves host
trust configuration to the host operator.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
