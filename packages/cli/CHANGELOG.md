# @kontourai/station-cli

## 0.7.0

### Minor Changes

- 4aca094: Add read-only cloud setup preview and AWS EC2 template preparation. Report credential enrollment, workspace review, and unavailable execution handoff explicitly; do not provision resources or transfer authority.
- 4206b09: Compose encrypted workspace import with existing authenticated Project creation and identity read-back. Retain imported bytes and a durable request when registration is uncertain, and document explicit target mapping and reconciliation.
- 7ef36cc: Add enrolled cloud target verification with stable boot observation, redirect refusal, bounded responses and no execution authority transfer.
- 1344781: Record recovery-from-copy provenance atomically with an offline home restore. Show the snapshot time and explicit absence of transferred execution authority in CLI and JSON output, and expose a bounded read-only recovery-record reader.
  
  Expose a host-scoped system-status disclosure and show a persistent browser recovery notice with snapshot time and explicit authority limits.
- ce6ec59: Add encrypted, bounded Git workspace packages with shared capture, inspection, and fresh-directory import APIs and cloud CLI commands. Preserve supported staged and uncommitted work without transferring credentials or execution authority. Document self-hosted use, resource limits, and recovery.
- 0c3d60e: Verify restored Git workspace contents through the bounded package codecs and emit a package-bound verification receipt. Check fresh local imports before target Project creation, preserving failed imports for explicit recovery and reporting platform limitations.

### Patch Changes

- f6f9497: Add a GCP development target to the shared read-only cloud preview, retaining explicit gaps for provisioning, credentials, and execution transfer. Document the isolated operator-run Compute Engine bootstrap.
- d209461: Keep plugin builds from reinstalling a containing Station workspace. Root-managed
  plugins use the managed dependency bootstrap; standalone nested plugins install
  only into their own directory, preserving the host's lock and dependencies.

## 0.6.0

### Minor Changes

- d926a67: Expose exact authorized terminal tool-result reads and identity-only Task Keep
  operations through typed clients and CLI commands. Protected reads validate
  Thread projections, withhold stale content, and preserve generic failure states.

## 0.5.0

### Minor Changes

- b118d6e: Command Station Slice B (#1984, #1986, #1991): the CLI now dispatches through a
  Commander program, `station [dir]` (in a TTY) lazily opens a running Station in
  the browser (finding it through the instance registry and the
  `GET /api/system/instance` probe) and offers inline / service / temp-home when
  none is running, `station service` (in a TTY) presents an interactive menu, and
  a one-time short-TTL local-bootstrap token lets that opener hand the local
  browser a paired credential through the URL fragment without any peer-address
  trust.
  
  Commander is bundled (a devDependency esbuild inlines into `dist/station.mjs`),
  not added to `dependencies`: the published tarball still carries only the
  audited `@napi-rs/keyring` runtime dependency (`bundle.test.ts`). The
  interactive menus use Node's built-in `readline/promises` rather than a new
  prompt dependency, so nothing new reaches the runtime install graph.

## 0.4.0

### Patch Changes

- Updated dependencies [2b01d6a]
  - @kontourai/station-shared@0.4.0
