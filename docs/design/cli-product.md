# Design: the Station CLI as a published product

Status: superseded. The bundled client, tier boundary, and package build are
implemented; current behaviour is owned by [the CLI reference](../reference/cli.md),
`packages/cli/package.json`, and `packages/cli/esbuild.config.mjs`. This record
is retained only as historical rationale and must not be used as release or
publication evidence.

## The premise was wrong

The working assumption behind marking `packages/cli` `private: true` was that
"most CLI verbs assume a git checkout," so publishing would hand a stranger a
`station` whose main commands fail. A verb-by-verb audit says otherwise.

**Of ~39 top-level verbs, ~28 are already checkout-free HTTP clients.** They
route through `resolveApiBase` (`packages/cli/src/commands/core-api.ts:66`) to a
running Station server and touch neither `CWD`, nor `git`, nor any build:
`chat`, `agents`, `sessions`, `approvals`, `operate`, `projects`, `tasks`,
`skills`, plus every surface verb (`connections`, `flow`, `tools`,
`notifications`, `monitoring`, `schedule`, `runs`, `knowledge`, `auth`,
`branding`, `feedback`, `insights`, `acp`, `voice`) and `registry`.

Only 9 lifecycle/setup verbs genuinely need a repo, and they are exactly the
ones you would expect: `start`, `build`, `upgrade`, `fresh`, `stop`, `service*`,
`doctor`, `link`, `shortcut`.

So the decision to keep the package private was right, but **the reason was
wrong**, and the fix is much smaller than "rewrite the CLI." The blocker is the
packaging shell, not the command surface.

## What actually blocks publication

Five concrete, mechanical problems — none of which are "the verbs assume a
checkout":

1. **`bin` points at TypeScript.** `packages/cli/package.json` declares
   `"bin": {"station": "./src/cli.ts"}`, and `src/cli.ts:1` is
   `#!/usr/bin/env tsx`. `tsx` is a **devDependency**, so on a clean machine
   `npx @kontourai/station-cli` cannot resolve its own interpreter.
2. **There is no build step for the CLI.** `esbuild.config.mjs` has exactly two
   entry points, both server-side. `npm run build` never touches
   `packages/cli`, and `packages/cli/tsconfig.json` is `noEmit`.
3. **The real entry point lives outside the package.** The `./station` launcher
   execs `scripts/station-cli.ts`, which imports
   `../src-server/services/ssh/environment-security-service.js`
   (`scripts/station-cli.ts:5`) — server source that would never ship in a CLI
   tarball.
4. **An undeclared dependency on a private package.** `commands/environment.ts:6`
   imports `@kontourai/station-connect/device-pairing`, which is absent from
   `dependencies` (it resolves only via workspace hoisting) and is itself
   `private: true` with an export map pointing at raw `.ts`.
5. **`CWD` is a module-level constant** (`commands/helpers.ts:36`) consumed by
   ~30 sites across `lifecycle.ts` and `service.ts`. Only the checkout-required
   verbs care, but it makes the boundary implicit rather than enforced.

## The shape: ship the client first

The product is a **client CLI**: something you install globally to drive Station
hosts you already run — locally, on a home server, across a tailnet. That is
also the fleet story this codebase has been building toward, and it is
publishable without solving the hard problem.

The hard problem is `station start` **without a checkout**. Reusing the desktop
app's runtime means shipping `dist-server/command-station.js` plus a staged
`node_modules` of 7 unbundleable externals (budgeted at ≤600 MB / 25 000 files
in `scripts/lib/desktop-server-runtime.mjs`), plus `dist-ui`, `seed`, and
`schemas` — and it still requires a host Node 24, because the desktop app does
not ship a runtime either (`src-desktop/src/lib.rs:791`). That is a real
distribution project. It should not gate a client release.

### Three tiers

| Tier | Verbs | Ships in the npm package? |
| --- | --- | --- |
| **Client** | `chat`, `agents`, `sessions`, `approvals`, `operate`, `projects`, `tasks`, `skills`, all surface verbs, `registry`, `stations`, `target`, `setup existing`/`hosted`, `config`, `export`/`import`, `plugin` (user-dir subset), `environment access request` | **Yes** |
| **Host-local** | `environment show`/`credential`/`reset`/`access list`/`approve`/`deny` | Yes, but must fail with a clear "run this on the host" message |
| **Contributor** | `start`, `stop`, `build`, `upgrade`, `fresh`, `service*`, `doctor`, `link`, `shortcut` | **No** — stay behind the repo-root `./station` |

`station environment` is the one verb family that genuinely splits: `access
request` is a pure client (it polls a remote host's public pairing endpoints and
stores a credential), while the rest hard-fail today with a message that
literally names `./station` (`commands/environment.ts:825`). The split is
already latent in the code; publication just makes it explicit.

## The multi-Station contract

Every client verb accepts an explicit `--api-base`, so direct bootstrap and
diagnostic requests remain possible:

```
station environment access request --api-base=https://box-b.tailnet.ts.net
station chat --api-base=https://box-b.tailnet.ts.net
```

Named targets use the shared saved-Station contract, not a separate CLI host
registry. A saved Station selects the API endpoint; an Environment selects
where an Agent executes; an engine connection selects how it executes. CLI and
native Desktop read the same versioned `profiles.json`, while credentials live
only in the OS keyring behind opaque references. Setup and `stations use` are
the deliberate default-selection boundaries; one-off overrides never mutate
the default.

## Bundling decision

Bundle the CLI with esbuild into a single ESM file with a shebang, inlining its
`@kontourai/station-*` dependencies.

- **No runtime `tsx`.** This removes the interpreter-resolution failure, the
  ~190–320 ms per-invocation transpile cost, and esbuild-in-a-global-install.
- **It sidesteps the raw-TS family constraint.** `sdk`/`shared`/`contracts`
  publish TypeScript source deliberately (their consumer is a bundler). A CLI is
  not a bundler consumer — it is an executable, so it should be bundled at
  publish time rather than transpiled on every run.
- **It resolves the `station-connect` problem without publishing it.** Inlining
  `device-pairing` at build time means the private package never needs to go
  public just to satisfy an import.

Node stays a runtime requirement (`engines: 24.x`); this is a bundle, not a
binary.

### What the install is allowed to weigh

A client CLI that costs 13 MB to install is not "small, public, no auth" in any
sense a user recognises. The rule this package holds to: **an install that only
ever runs client verbs downloads nothing that exists to serve the
plugin-authoring verbs.** Measured on 0.4.0, first bundled shape → current:

| | before | after |
| --- | --- | --- |
| `dist/station.mjs` | 1,194,717 B | 638,874 B |
| tarball (packed) | 737,738 B | 193,112 B |
| installed (`npm i <tgz>`, `du -sk node_modules`) | 13,180 kB | 632 kB |

Three decisions get it there, and the order matters — the first is worth more
than the other two combined:

1. **esbuild is an optional peer, loaded lazily.** It is the only external, it
   exists solely for `plugin build`/`dev`/`install`, and it resolves a
   per-platform native binary from its own package: 9,712 kB of a 13,180 kB
   install, 4.19 MB of a 5.03 MB download. `@kontourai/station-shared/build`
   reaches it through `await import('esbuild')` — which esbuild preserves as a
   real runtime `import()` for an *external* package — so the client verbs never
   touch it and npm never fetches it. Plugin authors run `npm i -g esbuild`
   once, prompted by a named error rather than a stack trace.
2. **The sourcemap does not ship.** 2.2 MB, larger than everything else in the
   tarball put together, for a CLI that catches its own errors. Still written
   next to the bundle for local debugging; `files` lists `dist/station.mjs`.
3. **The bundle is minified with `keepNames`.** 1,194,642 → 638,384 bytes; the
   34 kB `keepNames` costs over a bare `minify` keeps function and class names
   in stack traces.

Three things that look like wins and are not, all measured rather than assumed:

- **Making the MCP tree lazy.** `@modelcontextprotocol/sdk` and its `ajv`/`zod`
  subtree are 644 kB of the unminified bundle — 54% — and reach it through one
  import in `packages/cli/src/dev/mcp.ts`. But esbuild *inlines* a dynamic
  import when it emits a single output file: measured at 717,639 bytes either
  way. Lazy-loading it changes when the code is evaluated, not what is
  downloaded.
- **Code-splitting it into a chunk.** That does move it out of the entry file
  (220 B entry + 660,613 B chunk), but the chunk still ships in the same
  tarball. It buys startup parse time, not install weight, and costs a
  multi-file `bin`.
- **Externalising the MCP tree as real dependencies.** `npm i
  @modelcontextprotocol/sdk` installs **24.5 MB** — it pulls express and hono —
  against 644 kB inlined. 38× worse for the number users feel.

## Relationship to the portable tarball

`scripts/package-portable-release.sh` + `install.sh` already produce a
distributable Station: a `.git`-less source checkout plus `npm ci`, installed
under `$STATION_ROOT/installs/<channel>/releases/<checksum>` (default
`~/.station/installs/<channel>/releases/<checksum>`). It preserves every
checkout-required verb *by construction*, and it is how `station upgrade` works
for non-git installs (`commands/lifecycle.ts:2690`).

These are complementary, not competing, and the doc states the split explicitly:

- **Portable tarball** = "run a Station host on this machine." Heavy (~1 GB),
  currently gated on `gh auth` because the repo is private.
- **npm CLI** = "drive Station hosts from this machine." Small, public, no auth.

A published `station start` would eventually collapse the distinction. That is
the end state, not the first release.

## Slices

Each slice is independently shippable and reviewable.

1. **Verb tiering + host-only errors.** Formalize the three tiers; make
   host-local and contributor verbs fail with actionable messages naming what to
   run instead. No packaging change. Establishes the boundary in code.
2. **Bundle the CLI.** esbuild entry for `packages/cli/src/cli.ts` → single ESM
   file with shebang; `bin` points at the bundle; declare the missing
   `station-connect` dependency (or inline it); drop the `scripts/station-cli.ts`
   indirection for the published path. Acceptance: `npm pack` the tarball,
   install it globally **outside the repo**, run `station --help` and
   `station chat --api-base=<host>` against a live host. This is the receipt that
   the whole publish-surface effort taught us to demand — the same
   install-the-tarball-in-a-clean-fixture test that caught two publish-breaking
   import bugs in `sdk`/`shared`.
3. **Shared saved Stations.** `stations` / `target` / `setup`, one explicit
   default shared with native Desktop, and OS-keyring credential references so
   `--api-base` becomes optional without creating a second address book.
4. **Publish `@kontourai/station-cli`** — client tier only, with a README that
   states plainly which verbs require a host checkout.
5. **(Deferred, separate project) `station start` without a checkout.** Ship or
   fetch the server runtime; reuse the desktop supervisor contract, which is
   small and already proven: `{"event":"listening","port":N,"host":"H"}` on
   stdout under `STATION_STDOUT_HANDSHAKE=1`, with `PORT=0` /
   `STATION_PORT_MODE=auto` and a contiguous 3-port block
   (`src-server/runtime/bootstrap/`).

## Open questions

- **`stop` remains contributor-only.** Instance state is cwd-anchored
  (`INSTANCE_STATE_DIR = join(CWD,'.station','instances')` in
  `commands/helpers.ts`), so a globally installed client could silently target
  the wrong instance. A future home-anchoring design can reconsider that
  boundary without weakening the packaged-client refusal.
- **Version alignment.** `cli` currently sits at 0.4.0 alongside the published
  family but outside the `fixed` changeset group. If it publishes, decide
  whether it joins that group or versions independently.

## Test gap this must close

Nothing in the suite exercises the CLI as an **installed npm package** — no
smoke test of the packed tarball, no test that it works outside the monorepo.
Every checkout assumption is currently enforced only by tests that mock the
entire helpers module (`packages/cli/src/__tests__/lifecycle.test.ts:173`).
Slice 2 must add an install-the-tarball test, or the first external user is the
test.
