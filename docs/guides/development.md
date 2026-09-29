# Developer Guide

This guide describes the checkout workflow and routes to its command owners.
Commands below are instructions, not evidence that this revision has completed
all builds or platform checks. Use [testing](testing.md) for diagnostic versus
completion evidence and [documentation maintenance](documentation.md) when a
change alters a guide, diagram, example or public contract.

## Source Prerequisites

Working from source needs Node.js 24.x, npm for the script/bootstrap interface,
the exact pnpm version in `package.json`, and Git. The managed dependency runner
resolves and checks that package-manager pin. On Linux,
`npm run dependencies:install` additionally needs a C++ toolchain (`g++`,
`make`, `python3`) when the `node-pty` terminal module must be compiled.
macOS and Windows normally use the supported prebuild paths. The Linux
[prebuild manifest](../../packaging/node-pty-prebuilds/manifest.json) is currently
empty. Its future artifact channel needs the libc compatibility admission in
[#2813](https://github.com/kontourai/station/issues/2813) before it can replace
source builds on supported hosts. `npm_config_build_from_source=true` opts out
of prebuild staging. Other native dependencies retain their own platform
requirements. Rust and platform SDKs are needed for native builds/checks; a server/UI-only
loop need not run them.

## Optional `just` contributor Interface

`just` forwards to Station's existing commands; it does not replace them. Use
the [generated contributor command reference](../reference/contributor-commands.md)
for the exact nine recipes and their checked Unix and Windows implementations.

Install Just **1.44.0 or later**: `brew install just` on macOS, your Linux
distribution's package manager (or `cargo install just --locked`), or `winget install --id Casey.Just --exact` in Windows Package Manager. The minimum is
required for the Windows `[script]` recipes. Run `just --version` after
installation.

Run the recipes from the repository root. The forwarding recipes preserve
arguments: on macOS/Linux quote shell-sensitive values with single quotes; in
Windows Command Prompt use double quotes.

```sh
just dev --instance=docs-smoke --temp-home --clean --force --port=3242 --ui-port=5274
just test 'scripts/__tests__/product-laws.test.ts'
```

```bat
just dev --instance=docs-smoke --temp-home --clean --force --port=3242 --ui-port=5274
just test "scripts/__tests__/product-laws.test.ts"
```

`just full` delegates to `npm run full:regression`, but it is an explicit
diagnostic tool rather than the ordinary delivery loop. Hosted promotion owns
the canonical completion receipt.

## Local Runtime

For a fresh checkout, select Node.js 24.x (also recorded in `.nvmrc`), then
install the locked dependencies and repository hooks from the repository root:

```bash
npm run dependencies:ci
```

Use the managed dependency command when refreshing an existing checkout too;
it applies Station's dependency lifecycle policy.

### Package-manager migration

The org-wide pnpm direction and Station's migration work are tracked in
[issue #516](https://github.com/kontourai/station/issues/516). A sibling
repository's migration does not change this checkout's install contract.
Check the root lockfile, package metadata, and `scripts/dependency-lifecycle.mjs`
before choosing an installer. This revision uses `pnpm-lock.yaml` and the
managed pnpm lifecycle above. `npm run` remains the script interface; it does
not select npm dependency storage. The migration must update those inputs, native
hooks and patches, verification identity, packaging, CI, and this guide together.

Executable version-manager shims keep their invocation name while Station
checks and launches the canonical driver outside the dependency tree being
retired. An alias does not relax the exact pnpm pin: an unconfigured shim or
a different manager version still refuses before installation.

Each worktree keeps its own writable dependency tree; pnpm's shared package
store does not make another worktree's `node_modules` safe to delete or reuse
as a symlink. If installation fails with `ENOSPC`, check free space and treat the
partial install as unverified before diagnosing downstream build/test errors.
Do not reclaim another active worktree's dependencies to repair your own.

Prefer the `./station` CLI for starting and stopping the app. It coordinates server, UI, build artifacts, instance state, and data directories.

```bash
./station --help
./station start --instance=dev-smoke --temp-home --clean --force --port=3242 --ui-port=5274
./station stop --instance=dev-smoke
./station doctor
```

Release channels and development worktrees have reserved, generated port bands.
Agent and contributor smoke runs should use unique ports and `--temp-home`
unless the task explicitly needs the selected channel's default runtime home.
See [release channel ports](release-channel-ports.md) for the canonical map.

The root Vite development command is local-only by default:

```bash
npm run dev:ui
# http://127.0.0.1:5173
```

It listens on IPv4 loopback, and the Tauri development shell uses that same endpoint. Direct LAN or other non-loopback exposure of the root Vite server is unsupported. When developing on a remote machine, keep Vite on loopback and forward it explicitly from your local machine:

```bash
ssh -L 5173:127.0.0.1:5173 user@remote-host
```

Then open `http://127.0.0.1:5173` locally. This boundary applies only to the root Vite/Tauri development server; built Station and Tailscale deployments, the phone UI server, Android previews, and plugin development servers have separate listener policies.

## Data Directory

Station keeps shared client metadata, channel installs, caches, and runtime
homes under one `STATION_ROOT` (`~/.station` by default):

```text
~/.station/
+-- config/
|   +-- profiles.json
+-- cache/
+-- installs/
|   +-- stable/
|   +-- beta/
|   +-- nightly/
+-- instances/
    +-- stable/       # runtime home: config, projects, agents, plugins, logs...
    +-- beta/
    +-- nightly/
    +-- dev/<worktree-id>/
```

Use `STATION_HOME`, `./station start --home=<dir>` (or its original alias
`--base=<dir>`), or `./station start --temp-home` to select one runtime. These
never move `$STATION_ROOT/config/profiles.json`. Deleting the selected
channel's default runtime home requires `--allow-default-home-clean` in
addition to `--force`; the shared root is not a runtime cleanup target.

### Read-only recovery planning

`./station home recovery-plan --base=<existing-home> --json` (or `--home=`)
reports a bounded observation of schema and selected Engine/Agent identity
fields. An explicit target is required; no default home is selected and no
`--temp-home`, `--confirm`, or mutation flags are accepted. This command does
not migrate, reset, back up, repair, start Station, or authorize any apply.
Normal startup still refuses unsupported home schemas.

The report contains category counts and fixed reason codes, not raw paths,
identities, config values, transcript text, or credentials. It reads selected
JSON metadata files, including `config/app.json`; arbitrary connection config
inside those files is not interpreted or printed. Credential files, app-home
payloads, SQLite stores, history, grants and plugin code are not opened. Opaque
directories count as one observed entry, not as an inventory of their contents.
Unknown entries and uninspected fields remain explicit, not implicitly safe.

Exit 2 means partial or refused inspection; exit 0 only means the selected
fields produced no finding. Neither means recovery is safe. Filesystem checks
detect observed changes and unsafe links; they are not an atomic snapshot or
protection against every non-cooperating filesystem race. PID existence is not
exact process-birth ownership. Modern leases and legacy profiles are not
inspected, and owner exclusion is always **not proven**. A future recovery
transaction must independently validate mappings, preserve original evidence,
and obtain the existing lifecycle authorities. Preserving history must never
implicitly reactivate sessions, scheduled jobs, grants, or account selection.

## Packages

| Package | Path | Distribution | Purpose |
| --- | --- | --- | --- |
| `@kontourai/station-contracts` | `packages/contracts/` | Published (npm, Apache-2.0) | Canonical cross-package API, runtime, provider, catalog, and orchestration types |
| `@kontourai/station-sdk` | `packages/sdk/` | Published (npm, Apache-2.0) | Plugin SDK hooks, components, query domains, and client helpers |
| `@kontourai/station-shared` | `packages/shared/` | Published (npm, Apache-2.0) | Shared runtime helpers and compatibility re-exports |
| `@kontourai/station-connect` | `packages/connect/` | Private in this checkout (`private: true`) | Standalone bidirectional pairing library |
| `@kontourai/station-cli` | `packages/cli/` | Published (npm, Apache-2.0) | Client CLI package; checkout-only host commands remain behind `./station` |

The contracts, SDK, and shared packages ship raw TypeScript source, so their
consumers need a bundler or a TS-aware loader; each README documents that
constraint. The CLI ships a bundled executable. Connect is marked `private: true` in this checkout; that does not imply it was
never published historically. The repo-root `./station` launcher
remains the checkout entry point for host and contributor commands.

New cross-package types should live in the owning `@kontourai/station-contracts/*` module. Keep compatibility re-exports in `shared` only when needed for older callers.

Root `npm run dependencies:ci` also provisions development examples that depend on Station
workspace packages. Those examples are declared in the root `workspaces` list
and `pnpm-workspace.yaml`, so the managed pnpm install links workspace dependencies locally — which is required for private
workspace packages that cannot be resolved from the registry, and keeps the
published ones pinned to the in-repo source rather than the last release. Add a
new example there when its tests are part of the root verification corpus and
it owns dependencies that the root install must provide. Root-managed examples
use the repository's `pnpm-lock.yaml`; do not add a second lock inside the
example.

### Dependency install deadline

The dependency bootstrap gives the inert pnpm install step a finite
deadline — twenty minutes on Windows, ten minutes elsewhere — so a wedged
install fails instead of hanging forever. That default is not a claim about the
slowest supported machine. A historical cold 1552-package install on an ARM64 handset took about eleven
minutes and exceeded its then-fixed bound. That observation, including the
reported `npm error signal SIGTERM`, is retained as sizing rationale; it is
not a current pnpm install benchmark.

Raise it on a host that is slow rather than stuck:

```bash
STATION_DEPENDENCY_INSTALL_TIMEOUT_MS=1800000 npm run dependencies:ci
```

The value is whole milliseconds and must be positive; a malformed value fails
loudly rather than silently restoring the default. Lifecycle hooks keep their
separate two-minute bound — the earlier `node-pty` compile measurement was about 27 seconds on that
handset. Re-measure the current graph and host rather than treating it as a
present build-time guarantee.

## Project Structure

See [Repository layout](repository-layout.md) for directory ownership, naming,
generated files, and where to put a new module or document.

```text
src-server/       Node backend, Hono routes, services, runtime adapters
src-ui/           React frontend
src-desktop/      Tauri desktop shell
packages/         Contracts, SDK, connect package, shared helpers, CLI
examples/         Plugin and provider examples
docs/             Strategy, guides, reference, design docs, Pages source
tests/            Playwright E2E specs and manifest
monitoring/       OTel collector, Prometheus, Grafana, Jaeger stack
```

## CLI Reference

Common commands:

```bash
./station start
./station stop
./station doctor
./station upgrade
./station config get <key>
./station config set <key> <value>
./station agents <action>
./station projects <action>
./station skills <action>
./station connections <action>
./station registry <catalog> <action>
./station acp <action>
```

See [../reference/cli.md](../reference/cli.md) for the complete command reference.

## Plugin Development

Use the [plugin guide](plugins.md) for scaffold templates, package formats,
build, preview and installation. The scaffold's `npm run build` calls the
public `@kontourai/station-shared/build` helper; it is distinct from rebuilding
Station's application bundles. A build does not install or grant the plugin.
Preview effects and approve the current installation before expecting runtime
contributions to become active.

Inside this checkout, use the managed root dependency lifecycle and declared
workspace packages. Do not use `npm link` or raw installs to replace pinned
SDK/CLI dependencies; a global link hides which checkout supplies the running
code. A standalone plugin outside this repository follows its own package and
lockfile contract. For SDK development, use the existing workspace build and
its consumer tests, then restart any consumer whose bundle must be rebuilt.
Do not assume a rebuilt SDK silently refreshes an already loaded plugin.

For an npm-owned standalone plugin outside this repository and its managed
workspaces, the plugin's own workflow can be:

```bash
cd my-plugin
npm install
npm run build
```

That example is not a root-checkout install command or a way to replace
Station's pinned workspace dependencies.

## Commit Messages

Commit subjects follow the Conventional Commits grammar enforced by the
repository hooks:

```text
type(scope)?: subject
```

- **Types** (the whole vocabulary): `build`, `chore`, `ci`, `docs`, `feat`,
  `fix`, `perf`, `refactor`, `style`, `test`.
- **Scope** is optional, lowercase (hyphens allowed), and may be a comma
  list: `fix(ui,test): …`. There is no approved-scope list; name the area
  the change touches.
- `!` before the colon marks a breaking change: `feat(plugins)!: …`.
- One space after the colon, non-empty subject. No length cap — the repo's
  history runs p99=153 characters, and subjects routinely carry issue
  references.

**Exempt** (no format required): merge commits — capital-M `Merge …`
(git/GitHub generated) and this repo's hand-written lowercase `merge …`
subjects (`merge main`, `merge origin/main …`, `merge: …`) — plus
`Revert "…"` subjects and `fixup!` / `squash!` autosquash markers. Changesets
release commits already conform (`chore: version packages`).

Enforcement is **forward-only** — new commits, never history:

- `.githooks/commit-msg` refuses a non-conforming subject at `git commit`
  time with a message that teaches the format. Git has a technical bypass,
  but it is not the normal repair path or permission to bypass repository
  verification.
- `.githooks/pre-push` validates exactly the commits a push introduces (the
  push range), quoting each offending subject.

Both ride the repo's single hook mechanism (`npm run dependencies:ci` or
`npm run hooks:install` arms `.githooks/` via `core.hooksPath`). The
vocabulary constant and validator live in
`scripts/commit-message-gate.mjs`; its tests include corpus checks that the
last 100 non-merge `origin/main` subjects still pass and that every merge
subject in the last 3000 commits is exempt or conforming, so a vocabulary
that stops fitting the repo fails a gate rather than its contributors.

## Verification

Before editing, route the intended paths with `gate:for`. Use the changed
selector when choosing affected evidence, then run the smallest named proof:

```bash
npm run gate:for -- <paths...>
npm run test:changed -- --base=origin/main --explain
npm run test:focused -- <selected-test-file>
npm run typecheck:<affected-lane>
npm exec -- biome check <affected-paths>
```

The changed selector prints a bounded summary of selected targets and lanes;
the complete explanation is retained in
`.kontourai/test-impact/changed-selection.json`. It is diagnostic: with
`--explain`, exit 0 only means the explanation was emitted; without it, exit 0 is a completed focused result.
Exit 3 is provisional/deferred and names the broader lane to run next. Its
receipt does not certify completion. Do not repeatedly launch `npm test`,
`test:full`, `verify:static`, `verify:local`, or full E2E while editing; those
host-coordinated lanes consume shared CPU and mutable-output leases.

Use `npm run ci:fast` for bounded per-push feedback: it runs affected tests
against `STATION_CI_FAST_BASE` first, then fixed runtime, lockfile, workflow,
evidence-check registration, generated-output, documentation,
verification-policy, lint, governance and typecheck invariants. It is not
the full static/build chain or full Vitest corpus.
Hosted CI splits that work: `fast-checks-plan` selects once, four
`fast-checks-shard` jobs run the affected tests, and `fast-checks-statics` runs
the fixed invariants plus browser/performance smoke and the UI bundle budget.
The required `fast-checks` result combines job outcomes with exact-plan shard
receipts. Local `ci:fast` remains unsharded; see the
[testing guide](testing.md#what-counts-as-tested) for evidence interpretation.
Ordinary pull requests use focused evidence plus `npm run ci:fast`.
GitHub's merge queue verifies the synthesized latest-main candidate.
Do not run `npm run full:regression`
locally merely because `main` moved.

The reusable hosted workflow `.github/workflows/full-regression.yml` owns the
canonical receipt. Nightly and tagged preview and stable promotions bind it to
one exact source SHA before any artifact build or publication.
A manual `workflow_dispatch` of CI remains the explicit diagnostic escape hatch.
Escalate to public native or full E2E lanes only when selector/policy output
names them or the final risk surface requires them.

When recording a promotion-level Builder `tests-evidence` claim, use the
hosted exact-SHA receipt whose command is `npm run full:regression`. Keep
focused test commands in ordinary delivery evidence; they remain useful
diagnostics but are not canonical promotion receipts.

Useful focused commands:

```bash
npm run build:sdk
npm run build:connect
npm run basis:mcp:generate   # git-ignored Basis MCP app bundles; dependencies:ci and station build also run it
npm run build:server
npm run build:ui
npm run test:connected-agents
npm run test:e2e:product -- --spec=tests/<owned-product-spec>.spec.ts
```

Every Playwright spec must be assigned to exactly one bucket in `tests/e2e-manifest.mjs`.

Dependency updates must also pass the workspace advisory floor. See
[Dependency security](dependency-security.md) for the root, SDK, and shared lock
workflow, production-reachability interpretation, and exception contract.

Pushes that touch orchestration transfer inputs run the transfer gate from
`.githooks/pre-push`. It reads its baseline from
`STATION_TRANSFER_BASELINE_ROOT` and its capture liveness bound from
`STATION_TRANSFER_CAPTURE_TIMEOUT_MS`; see
[Pre-push orchestration transfer gate](testing.md#pre-push-orchestration-transfer-gate)
for baseline preparation and the slow-hardware override. Do not `--no-verify`
past it: no required CI check re-runs it.

## Observability

Every runtime feature should include OpenTelemetry instrumentation unless the plan explicitly explains why telemetry is not applicable. Add instruments in `src-server/telemetry/metrics.ts` using the existing `station.<domain>.<metric>` naming pattern.

Choose bounded, privacy-reviewed attributes such as provider, operation or
outcome; do not emit credentials, arbitrary paths or unbounded identifiers.
Instrumentation is observation, not a durable product receipt or proof of
collector delivery. [Monitoring](monitoring.md) owns the current export limits.

## Docs And Pages

Public positioning belongs in `README.md` and the hand-authored Pages home.
Only Markdown listed in `docs/pages/public-docs.json` is published. Publication also follows the reader's public source/disclosure policy; tracked
bytes alone are not authority to expose arbitrary filesystem content. Source
review and Pages admission are separate decisions. Follow the
[documentation guide](documentation.md) before adding a public page.

Build the public site locally with:

```bash
npm run docs:pages:build
```

The generated `dist-pages/` directory is disposable and should not be edited by hand.
