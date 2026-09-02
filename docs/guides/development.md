# Developer Guide

This guide keeps contributor and operator detail out of the public README while preserving the commands and conventions needed to work on Station.

## Source Prerequisites

Working from source needs Node.js 24.x, npm 10 or newer, and git. On Linux,
`npm run dependencies:install` additionally needs a C++ toolchain (`g++`,
`make`, `python3`) to compile the `node-pty` terminal module — the only
source-built native addon; macOS and Windows use upstream prebuilds. When
`packaging/node-pty-prebuilds/manifest.json` pins attested Linux artifacts
(#1245), the dependency lifecycle stages those instead and the Linux
toolchain requirement disappears; `npm_config_build_from_source=true` opts
back into compiling. Rust is optional and only needed for desktop builds.

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

## Packages

| Package | Path | Distribution | Purpose |
| --- | --- | --- | --- |
| `@kontourai/station-contracts` | `packages/contracts/` | Published (npm, Apache-2.0) | Canonical cross-package API, runtime, provider, catalog, and orchestration types |
| `@kontourai/station-sdk` | `packages/sdk/` | Published (npm, Apache-2.0) | Plugin SDK hooks, components, query domains, and client helpers |
| `@kontourai/station-shared` | `packages/shared/` | Published (npm, Apache-2.0) | Shared runtime helpers and compatibility re-exports |
| `@kontourai/station-connect` | `packages/connect/` | Private (`private: true`) | Standalone bidirectional pairing library |
| `@kontourai/station-cli` | `packages/cli/` | Published (npm, Apache-2.0) | Client CLI package; checkout-only host commands remain behind `./station` |

The contracts, SDK, and shared packages ship raw TypeScript source, so their
consumers need a bundler or a TS-aware loader; each README documents that
constraint. The CLI ships a bundled executable. Connect remains private and is
marked `private: true` in its `package.json`. The repo-root `./station` launcher
remains the checkout entry point for host and contributor commands.

New cross-package types should live in the owning `@kontourai/station-contracts/*` module. Keep compatibility re-exports in `shared` only when needed for older callers.

Root `npm run dependencies:ci` also provisions development examples that depend on Station
workspace packages. Those examples are declared in the root `workspaces` list
so npm links host-provided peers locally — which is required for private
workspace packages that cannot be resolved from the registry, and keeps the
published ones pinned to the in-repo source rather than the last release. Add a
new example there when its tests are part of the root verification corpus and
it owns dependencies that the root install must provide. Root-managed examples
use the repository's `package-lock.json`; do not add a second lock inside the
example.

### Dependency install deadline

The dependency bootstrap gives the inert `npm ci`/`npm install` step a finite
deadline — twenty minutes on Windows, ten minutes elsewhere — so a wedged
install fails instead of hanging forever. That default is not a claim about the
slowest supported machine. A cold 1552-package install takes about eleven
minutes on an ARM64 handset, which the fixed bound killed outright with
`npm error signal SIGTERM` and an already-emptied `node_modules/`.

Raise it on a host that is slow rather than stuck:

```bash
STATION_DEPENDENCY_INSTALL_TIMEOUT_MS=1800000 npm run dependencies:ci
```

The value is whole milliseconds and must be positive; a malformed value fails
loudly rather than silently restoring the default. Lifecycle hooks keep their
separate two-minute bound — the `node-pty` compile, the only one that builds
native code, takes about 27 seconds on that same handset.

## Project Structure

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

Create a plugin:

```bash
./station plugin create my-plugin --template=full
cd my-plugin
npm install
npm run build            # tsx build.ts — what the scaffold emits
./station plugin build   # equivalent wrapper, needs this checkout
```

Both call `buildPlugin()` from `@kontourai/station-shared`. The scaffold uses
the `npm run build` form so a plugin stays buildable without a Station
checkout.

Install or preview a plugin:

```bash
./station plugin preview git@github.com:org/my-plugin.git
./station plugin install git@github.com:org/my-plugin.git
./station plugin list
./station plugin remove my-plugin
```

For local SDK development:

```bash
cd packages/sdk && npm link && cd ../..
cd packages/cli && npm link && cd ../..
cd /path/to/my-plugin
npm link @kontourai/station-sdk
```

If the SDK changes, rebuild it and restart the plugin dev server:

```bash
npm run build:sdk
```

## Commit Messages

Commit subjects follow the Conventional Commits grammar because the
forthcoming deploy ledger (station#4572) will generate its changelog from
them — a free-form subject is a broken release artifact, not a style nit:

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
  time with a message that teaches the format. Deliberate exception:
  `git commit --no-verify`.
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

Start every implementation loop with the selector, then run the smallest named
proof:

```bash
npm run test:changed -- --base=origin/main --explain
npx vitest run <selected-test-file>
npx tsc -p <affected-tsconfig> --noEmit
npx biome check <affected-paths>
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
and verification-policy invariants—never broad static verification or the full
corpus.
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
npm run build:server
npm run build:ui
npm run test:connected-agents
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright test tests/<spec>.spec.ts
```

Every Playwright spec must be assigned to exactly one bucket in `tests/e2e-manifest.mjs`.

Dependency updates must also pass the multi-lock advisory floor. See
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

Meaningful attributes include provider, runtime type, connection type, source, outcome, reason, fallback source, freshness, and project scope.

## Docs And Pages

Public positioning belongs in `README.md` and the hand-authored Pages home.
Only Markdown listed in `docs/pages/public-docs.json` is published. Contributor,
API, architecture, design, strategy, plan, audit, and historical evidence
documents remain repository documentation unless intentionally reviewed and
added to that manifest.

Build the public site locally with:

```bash
npm run docs:pages:build
```

The generated `dist-pages/` directory is disposable and should not be edited by hand.
