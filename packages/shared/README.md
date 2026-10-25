# @kontourai/station-shared

The explicit `@kontourai/station-shared/native-relay-link` subpath owns the
canonical native relay link scheme/encode/parse helpers.
Connect's existing entry re-exports that same implementation, while published
SDK and server consumers use Shared directly. Parsing a link supplies no
trust or application authority, and receiving invitation secrets remains with
the native host. See the [codec reference](../../docs/reference/shared.md#native-relay-link-codec)
for its scope and source-distribution requirements.

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

The browser-safe `/skill-experience-values` leaf validates inert start inputs,
compares complete installed identities, and derives defaults, role positions and
input errors. `/skill-experience-reader` adds canonical definition validation for
inventory/session wire projections. The SDK client imports that reader
statically and runs it only on a successful feature response; synchronous UI
hydration retains only bounded display previews.
Neither helper discovers files, executes Skills, acquires grants or makes cached
inventory authoritative.

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

## Subpaths without a reference section

The [shared reference](../../docs/reference/shared.md) documents most helpers.
These subpaths are exported but not described there yet. Several are Node-only;
read the module before using one in a browser bundle.

- Station home storage (Node): `/durable-json-file` (temp, fsync and rename
  writes), `/regular-file` (non-blocking regular-file opens), `/temp-dir`
  (Station-scoped temporary directories), `/checkpoints` (checkpoint refs and
  retention audits), `/environment-security-record`,
  `/tool-server-credential-store` (per-principal tool server credential
  buckets).
- SQLite integrity (Node): `/sqlite-integrity`, `/sqlite-corruption-marker`,
  `/sqlite-corruption-watch`, `/sqlite-store-integrity`,
  `/orchestration-store-quarantine`.
- Runtime and packaging (Node): `/node-runtime` (supported Node range),
  `/launch-path` (sanitized `PATH` for launched processes), `/source-watch`
  (native watching with a bounded polling fallback), `/owned-dependency-installer`,
  `/prebuilt-archive` (packaged release manifest and archive markers),
  `/terminal-capability` (missing `node-pty` reasons).
- Projections and formatting: `/thread-projection` (conversation to the portable
  `@kontourai/thread` schema), `/usage-measurement` (measured tokens and cost,
  and what was not reported), `/build-provenance` (build timestamp
  presentation), `/portability` (guidance and MCP configuration export and
  import helpers).
- Browser and identifiers: `/return-focus` (focus restoration for dismissible
  surfaces), `/native-shell-origin` (packaged shell origins), `/random-id`
  (correlation ids outside a secure context), `/setup-import-bounds`,
  `/authored-input` (whether a turn start carries authored input, shared by the
  Session inventory listing, its exact read, and the SDK).

## License

Apache-2.0 — see [LICENSE](./LICENSE).

The Node-only `/skill-experience-workflow` subpath supplies bounded local Skill
library inspection and revision-bound author review. Use the
[author learning path](../../docs/guides/authoring-skill-experiences.md) for its
agent proposal and evaluation process. It checks source/package/transcript bytes
and reviewer assertions; it grants no runtime authority or model/device/release
qualification.


## Publisher telemetry parsing

The Node-only `@kontourai/station-shared/plugin-telemetry` subpath validates
publisher declarations and declared `plugin_daily` histograms. See the
[shared reference](../../docs/reference/shared.md#plugin-publisher-telemetry).
Broker acceptance and distribution manifest loading are separate work.

The Node-only `/child-workload` leaf lets Station install a process launcher
before admitting engine, MCP and tool workloads. Its spawn helper preserves
Node child-process streams and PID ownership, and cleans descendants after leader
exit. Standalone SDK consumers that install no launcher keep ordinary Node
process behavior. Resource budgets belong to the server; see
[Linux service workload budgets](../../docs/guides/development.md#linux-service-workload-budgets).
