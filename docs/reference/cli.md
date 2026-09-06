# CLI Reference

The Station CLI manages the application lifecycle, plugin system, and plugin development workflow.

## Invocation

There are three entry points, and they are not the same program surface.

### The operator entry point: `npx @kontourai/station-cli@<version-or-published-tag>`

`@kontourai/station-cli` is published on npm. Check the live version and
available dist-tags before scripting an install:

```bash
npm view @kontourai/station-cli version dist-tags
```

Run the published stable client against a Station you did not build:

```bash
npx @kontourai/station-cli@latest --help
```

`npx` resolves and runs the selected published version per invocation. For
latency-sensitive or scripted use, an explicit global install pins one version
instead: `npm install -g
@kontourai/station-cli@<version-or-published-tag>`. Use a channel dist-tag only
after `npm view` reports it.

Only the **Client** tier (see the table below) is reachable this way. A
host-local or contributor verb invoked through the published CLI fails with
the exact command to run instead — never a stack trace.

### The contributor entry point: `./station`

From the repo root, use the `./station` shell script:

```bash
./station <command> [args]
```

On first run, `./station` bootstraps by running `npm install` if `node_modules` is missing, installs the repo-local Playwright Chromium bundle, then delegates to `scripts/station-cli.ts` (which imports `packages/cli/src/cli.ts`) via `tsx`. It additionally injects `EnvironmentSecurityService` from `src-server/`, which is why the host-local `station environment` subcommands answer here and nowhere else.

**Every command in this reference works from `./station`.** This is also the
*local invocation way* when the registry isn't the point — developing the CLI
itself, or deliberately not depending on a published channel tag.

### The global dev shim: `station-dev`

A `npm run station-dev:install` script (see `scripts/station-dev.mjs`) copies a
small, dependency-free launcher onto `PATH`. Unlike `npm link`, it is not a
fixed pointer into one checkout: every invocation walks up from the current
working directory to find the enclosing Station checkout and runs *that
tree's* built bundle (`packages/cli/dist/station.mjs`, the same artifact `npx`
runs), so it behaves correctly across many worktrees on the same machine. It
refuses to run against a stale `packages/cli/dist` rather than silently
executing old code, naming `npm run build:cli` as the remedy. Outside any
checkout it names the `npx` form above instead of failing silently.

```bash
npm run station-dev:install   # once, from any Station checkout
cd ~/dev/some-other-station-worktree
station-dev agents list       # runs THAT worktree's build, not the one installed from
```

Because it runs the *bundle*, not `scripts/station-cli.ts`, `station-dev`
follows the bundle's own tier support below (Client tier only) — the
host-local and contributor tiers still need `./station` directly, from the
checkout that has them.

### The published entry point: the bundled `station` binary

`packages/cli` builds to a single executable ESM file, `packages/cli/dist/station.mjs`, which is what the package's `bin` points at — this is what `npx`/`npm install -g` and `station-dev` all ultimately run:

```bash
npm run build:cli          # from the repo root
node packages/cli/dist/station.mjs --help
```

The bundle inlines every `@kontourai/station-*` workspace package, so it needs no `tsx`, no repo checkout, and no raw-TypeScript resolution at runtime. Its one declared runtime dependency is `esbuild`, which `station plugin build` and `station plugin dev` drive through its native binary. `packages/cli`'s `prepack` hook rebuilds the bundle on `npm pack`/`publish` — EXCEPT when run from inside this checkout, where the repo-root `.npmrc`'s `ignore-scripts=true` silently suppresses it, so a bare `npm publish` from `packages/cli` here would pack whatever `dist/station.mjs` already exists (stale or missing) at exit 0. CI never depends on the hook — `publish-packages.yml` builds this package as its own explicit workflow step — and a human publishing from this checkout must run `npm run build:cli` first (see `publish-packages.yml`'s bootstrap note).

The bundle is the *published* path; `./station` is the *contributor* path. Both stay supported. There is deliberately no `npm link`-based way to develop the CLI itself: a machine-global symlink into one checkout would silently run whatever branch that tree happens to be on, with no staleness gate in front of it — `station-dev` above gives the same on-`PATH` ergonomics without either failure mode.

## Release artifact commands (contributors)

Release artifact assembly is deliberately a repository script surface, not a
runtime `station` verb. `node scripts/generate-release-sboms.mjs` writes the
four schema-v2 SBOM assets from an explicit release context plus canonical npm,
Rust, and container fragments:

```bash
node scripts/generate-release-sboms.mjs \
  --assets-dir release-assets \
  --fragments-dir release-sbom-fragments \
  --context release-context.json \
  --npm-fragment release-sbom-fragments/npm.fragment.json \
  --rust-fragment release-sbom-fragments/rust.fragment.json \
  --container-fragment release-sbom-fragments/container.fragment.json
```

It accepts only regular fragment files below `--fragments-dir`, separate from
the publishable `--assets-dir`; source and predicate are fixed to npm/runtime,
Rust/native, and container/image. The container fragment is derived only from
`scripts/release-container-sbom-source.mjs`: a pinned Syft CycloneDX scan of
the immutable `image@sha256:digest`, bound to the exact descriptor/source SHA
and platform envelope. The scanner source remains a scratch workflow artifact,
not a release asset. Then assemble the one inventory authority with
`node scripts/release-artifacts.mjs assemble ...`. The inventory records every
SBOM digest and `validate` recomputes every asset digest and validates all four
SBOM bindings. The Stage workflow runs this generation and validation before it
can create a draft; Publish runs the same asset/predicate validation before
provenance verification and image promotion.

### Which verbs answer from which entry point

Three tiers, per [the CLI product design](../design/cli-product.md):

| Tier | Verbs | Bundled `station` | `./station` |
|------|-------|-------------------|-------------|
| Client | `chat`, `agents`, `sessions`, `approvals`, `operate`, `projects`, `tasks`, `skills`, every surface verb, `registry`, `stations`, `target`, `triage`, `setup existing`/`hosted`, `config`, `checkpoints`, `export`/`import`, `plugin`, `environment access request` | yes | yes |
| Host-local | `environment show`/`credential`/`reset`/`offer`/`access list`/`approve`/`deny`, `environment peers` | fails, naming `./station` | yes |
| Contributor | `build`, `dev`, `doctor`, `fresh`, `home`, `link`, `service`, `shortcut`, `start`, `stop`, `upgrade` | fails, naming `./station <command>` | yes |

A contributor-tier verb invoked from the bundle exits non-zero with the exact command to run instead — never a stack trace and never a partial run against whatever directory you were standing in:

```console
$ station start
Error: `station start` runs against a Station repository checkout, so it is not part of the published CLI.
Run it from the root of a Station checkout with the bundled launcher:
    ./station start
The published CLI drives Stations that are already running — see `station stations`, `station setup hosted`, and `--api-base`.
```

`station --help` from the bundle names the same set in a closing note, so the printed reference never claims a verb it cannot run. `station <verb> --help` still answers for those verbs from either entry point.

`stop` is contributor-only. Its instance state is checkout-local, so a global
client could silently target the wrong instance; use `./station stop` from the
host checkout instead.

## Getting help

```bash
station --help                 # grouped, one line per command
station <command> --help       # actions and flags for one command
station help <command>         # the same per-command help
station --version              # CLI version and build provenance (-v, `station version`)
```

`--help`/`-h` is recognised at any depth — `station agents get my-agent --help`
prints the `agents` help rather than being read as an argument. The top-level
summary is deliberately short; per-command help carries the flag detail, and
this reference carries the prose.

Unknown input is a failure, never a help request: the process exits non-zero,
names the nearest real command or action, and points at the relevant help
instead of reprinting the whole manual.

```console
$ station agnts
Unknown command: agnts
Did you mean 'agents'? Run `station --help` for the command list.

$ station agents lst
Error: Unknown agents action: lst. Did you mean 'list'? Use 'list', 'get', 'create', 'update', 'delete', 'chat', 'conversations', 'messages', 'workflows'.

$ station plugin bogus
Unknown command: plugin bogus
Valid plugin actions: install, preview, list, remove, info, update, registry, init, create, build, dev.
Run `station --help` for the command list.
```

### `version`

Print the CLI version and build provenance.

```
station --version    # also: -v, `station version`
```

## The `station` launcher

Run the **checkout launcher** (`./station`) with no verb (optionally a project
directory) and it behaves like a launcher rather than printing usage — in an
interactive terminal:

```bash
station                 # open the Station running here
station ./my-project    # same, resolving the registry against a directory
```

What it does, in order:

1. Finds a running Station through the instance registry
   (`@kontourai/station-shared/instance-registry`) and confirms it with a
   `GET /api/system/instance` probe.
2. Mints a **one-time local UI-bootstrap token** (station#1991) and opens your
   browser at `http://localhost:<ui-port>#station-ui-bootstrap=<token>`.
   The page redeems the token for a device-session cookie and strips it from
   the URL immediately — see
   [local-bootstrap-token.md](../design/local-bootstrap-token.md). The token
   never appears in any log line; only the bare address is printed.
3. If nothing is running, it offers to start one — **inline** (this terminal),
   as a background **service**, or against a throwaway **temp home**.

Flags skip the prompt and name the path directly:

| Flag | Effect when nothing is running |
|------|--------------------------------|
| `--inline` | Start inline in this terminal |
| `--service` | Install and start a background service |
| `--temp-home` | Start against a throwaway temp home |
| `--port=<n>` / `--ui-port=<n>` | Ports for the started instance |
| `--consent-port=<n>` | Consent-listener port (default: server port + 3, station#3677) |

The launcher is **TTY-gated**: with no terminal (a script, a pipe, CI) and no
action flag, `station` prints usage and starts nothing, exactly as it always
has. A first token that is neither a known verb, a launcher flag, nor a real
directory (a typo like `agnts`) is still an unknown-command error, not a
launch.

The packaged client does not expose this launcher path. Bare invocation and
`--inline`, `--service`, or `--temp-home` refuse before profile/keyring access,
network probing, or service work, and point to `station setup existing <name>
<host-url> --pair` or `./station start`. Its version output is the immutable
artifact's version, CLI build channel, and source SHA — never a nearby checkout
or backend build manifest. A source checkout remains `development` regardless
of `STATION_CHANNEL`.

## Interactive `station service` menu

`station service` with no action, in a terminal, presents a menu of the service
actions (status, install, start, stop, uninstall) and dispatches your choice
through the ordinary `station service <action>` path — so the setup receipt and
rollback behaviour are identical to naming the action outright. With no TTY it
prints the usual `Usage: station service <install|start|status|stop|uninstall>`
error and does nothing, so scripts see the same deterministic failure as before.

## Native installation

When #818 publishes a required signed ring manifest, this no-clone macOS/Linux
path can install that exact portable GitHub release and start Station. Until
then it is protocol documentation, not a currently available installer claim:

```bash
sh -c 'set -eu; file=$(mktemp "${TMPDIR:-/tmp}/station-install.XXXXXX"); trap '\''rm -f "$file"'\'' EXIT HUP INT TERM; token=$(gh auth token); GH_TOKEN="$token" gh api repos/kontourai/station/contents/install.sh -H "Accept: application/vnd.github.raw+json" >"$file"; chmod 600 "$file"; GH_TOKEN="$token" sh "$file"'
```

When a signed stable ring manifest is published, this authenticated one-liner
uses the existing GitHub CLI login while the Station repository is private. It verifies its
stable-ring manifest,
checksum, and archive attestations before parsing or using them; there is no
anonymous or unsigned fallback. Set `STATION_CHANNEL=beta` for the beta runtime
channel, whose signed release ring is preview. See [release rings](../guides/release-rings.md) for recovery and
revocation guidance.

The checksum-addressed releases live under `~/.station/installs/stable/releases`,
`current` points atomically to the active release, and `~/.local/bin/station`
is the stable launcher. Runtime data remains isolated under
`~/.station/instances/stable` and survives an ordinary uninstall.

```bash
# Pin a release; rerun the ordinary command later to upgrade.
STATION_VERSION=v0.2.0 \
  sh -c 'set -eu; file=$(mktemp "${TMPDIR:-/tmp}/station-install.XXXXXX"); trap '\''rm -f "$file"'\'' EXIT HUP INT TERM; token=$(gh auth token); GH_TOKEN="$token" gh api repos/kontourai/station/contents/install.sh -H "Accept: application/vnd.github.raw+json" >"$file"; chmod 600 "$file"; GH_TOKEN="$token" sh "$file"'

# Remove program files and stop the installed instance, preserving data.
STATION_CHANNEL=stable "${STATION_ROOT:-$HOME/.station}/installs/stable/current/install.sh" uninstall

# Explicitly remove program files and the selected runtime instance data.
STATION_CHANNEL=stable "${STATION_ROOT:-$HOME/.station}/installs/stable/current/install.sh" uninstall --purge-data
```

The installer does not create a launchd or systemd service. Service lifecycle
is an independent, explicit Station command surface. Recursive removal is
fail-closed: the program root must carry the installer's ownership marker, the
program and data roots cannot overlap, and `--purge-data` refuses to delete a
pre-existing data directory the installer did not create and mark.

`station link` symlinks `station` into `~/.local/bin` (see [`link`](#link)). The launcher resolves that symlink to the real script location before locating the repo, so `station <command>` works from any directory once it's on `PATH` — it isn't limited to `./station` from the repo root.

## Choosing which Station a command talks to

Core workspace commands talk to a running Station's API server. The target
resolves in this order — first match wins:

| # | Source | Example |
|---|--------|---------|
| 1 | `--api-base=<origin>` | direct bootstrap or diagnostic request |
| 2 | `--station=<name>` | `--station=box-b` |
| 3 | `STATION_TARGET` | `STATION_TARGET=kontour` |
| 4 | Project Station selection | owner-controlled mapping selected by `station stations project use` |
| 5 | Explicit default Station | selected by `station setup` or `station stations use` |
| 6 | Active local Station | owner-safe local service record |
| 7 | Loopback default target | the selected channel's runtime-resolver server port (or `STATION_PORT`) |

Saved Stations live in the versioned, secret-free
`~/.station/config/profiles.json` store shared with native Desktop. The file
name is a persisted internal detail, not the user-facing noun.
`--api-base` accepts only a full HTTP(S) origin and deliberately bypasses
saved Station persistence for bootstrap and diagnostics; it never changes the
default. A named override or merely viewing a Station also never changes the
default.

Project selection is an explicit, secret-free pointer to a saved Station:
`station stations project use <name>` maps the canonical invoked directory in
the owner-controlled store, `show` reports it, and `clear` removes it.
Repository files cannot redirect the target, and resolution does not walk
parent directories or infer a target from repository contents.

The default Station applies to every command that talks to a Station API,
including `environment` verbs. Host-side verbs that must run against the local
Station (`environment access list|approve|deny`) still require a loopback
target — pass the selected channel's loopback `--api-base` explicitly when a
remote Station is your default. `--station=<name>` also works for these
verbs, but only for a saved Station whose endpoint is loopback AND that
records a local home (`localService.baseDir`, set by `station setup local`);
a Station saved by pairing has no recorded home for these verbs to read its
operator credential from, and still needs the explicit `STATION_HOME=<home>
--api-base=<loopback-url>` form (station#4515).

When a Station is selected, its credential reference is resolved through the
operating-system keyring. Bearer material is absent from saved Station metadata,
exports, status output, and ordinary app-data files. Unavailable keyrings fail
closed without a plaintext fallback.

`--api-base` accepts either the bare server origin
or that origin with a trailing `/api` (e.g. copied from a browser Network-tab request
URL) — both normalize to the same value. The CLI's own resource paths already
include `/api`, so a `--api-base` you supply should describe only the server
origin (plus any real, non-`api`, mount path); a base path whose final
segment happens to be `api` is treated the same as the bare-origin form and
that segment is stripped.

### Scripted / non-interactive use

Every client-tier command requires a bearer credential — even against a
`--temp-home` instance you just started yourself on loopback. TCP loopback is
a **transport position, not an authority**: an SSH local forward or a
container port-map is indistinguishable from a direct same-host process at
that layer, so an unauthenticated `station acp status
--api-base=http://127.0.0.1:<port>` fails with `authentication_required` even
though nothing but this OS user could plausibly have reached that port. This
is expected authentication enforcement. The supported non-interactive
local-grant exchange is documented below.

Local setup, remote pairing, and browser bootstrap issue device-session
credentials through distinct authority paths. `station setup local` uses
**local grant**; `station setup existing <name> <endpoint> --pair` uses pairing,
and the launcher’s browser bootstrap retains its separate `ui-bootstrap` mint
kind. These paths do not confer interchangeable approval authority. A per-boot, owner-only secret file under the Station home is proof of
authority, because whoever can already read that file has unconfined access to
everything the exchange grants — same-user code execution is already
unauthenticated with respect to the filesystem. See
`PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH` in
`packages/contracts/src/environment-security.ts` for the route path and the
mint-time contract, and `configureDevicePairingPublicRoutes` in
`src-server/runtime/routes/runtime-routes.ts` (search `local-grant` /
`writeLocalGrantSecretFile`) for the route implementation and its threat-model
comment.

The CLI performs this exchange itself (#1098,
`packages/cli/src/commands/local-self-auth.ts`): `station setup local` runs it
right after a successful service install and stores the credential through the
OS keyring exactly as pairing does, so the saved default works with no further
pairing step; and when a command finds a saved Station with an installed local
service, an IP-literal loopback endpoint, and no materialized credential, it
performs the exchange once before the first request (a machine left
credential-less by an older `setup local` heals without a reinstall). A
non-loopback endpoint is never self-authorized — network position must not
stand in for filesystem possession — and if the exchange fails, `setup local`
keeps the healthy install and prints exactly what is and is not set up.

For a script or agent driving `./station` non-interactively against an
instance it just started, exchange that secret directly instead of opening a
browser. This is the exact sequence proven live against a real instance
(station#1860):

```bash
# 1. Start an instance on unique, non-default ports (never 3141/3000).
./station start --instance=<instance-name> --temp-home --clean --force \
  --port=<port> --ui-port=<ui-port>
# ...
#   ✓ Home:   <station-home> (--temp-home)   <- printed by `start` for every home,
#                                             with what chose it; the secret lives under here

# 2. Read the per-boot local-grant secret off disk.
SECRET=$(cat <station-home>/runtime/local-grant.secret)

# 3. Exchange it for a device-session bearer credential. The route requires a
#    direct loopback connection carrying none of the UI proxy's internal
#    headers (their absence is positive proof no proxy hop is in the loop).
#    A tunnel terminating on loopback is indistinguishable at this layer —
#    which is exactly why possession of the secret bytes, not network
#    position, is what the route trusts.
curl -s -X POST "http://127.0.0.1:<port>/.well-known/station/v1/pairing/local-grant" \
  -H "Content-Type: application/json" \
  -d "{\"secret\":\"$SECRET\",\"deviceName\":\"my-script\"}"
# -> {"environmentId":"...","device":{...},"credential":"<bearer-token>"}

# 4. Supply the returned credential to every following call, either via
#    STATION_API_CREDENTIAL (whole-session) or one-shot --credential=<token>.
export STATION_API_CREDENTIAL=<bearer-token>
./station acp connections create --data='{"id":"...", "command":"...", "args":["acp"], "enabled":true}' \
  --api-base=http://127.0.0.1:<port>
./station agents list --api-base=http://127.0.0.1:<port>
./station agents create --data='{"name":"...", "slug":"...", "execution":{"agentConnectionId":"..."}}' \
  --api-base=http://127.0.0.1:<port>
./station chat <agent-slug> "<message>" --api-base=http://127.0.0.1:<port>
```

Security posture, plainly:

- **Loopback is a transport position, not authority.** The route never trusts
  the socket's address; only possession of the exact secret bytes counts.
- **The grant file is per-boot.** `local-grant.secret` is regenerated fresh on
  every Station start (mode `0600`, owner-only) and stops working the instant
  that process exits — a secret copied from a previous run, or from a
  different instance, is inert.
- **This mechanizes existing authority; it does not add any.** Anything able
  to read the Station home already has unconfined access to what this
  exchange grants. The route turns that pre-existing fact into an ordinary,
  scoped, revocable paired device credential (with its own `deviceName` and
  device-session lifecycle) rather than leaving every command with a
  filesystem-read-shaped authentication bypass.
- Treat the exchanged credential like any other paired-device bearer: do not
  commit, log, or echo it outside the process that consumes it.

This is the same primitive the CLI's own launcher uses internally to mint its
one-time UI-bootstrap fragment (`mintBootstrapTokenForOpener` in
`packages/cli/src/cli.ts`) — the sequence above uses it directly instead of
through a browser redirect. There is currently no `station credential mint`
convenience verb wrapping steps 2–4; that remains an open follow-up decision
(station#4085).

### Request deadlines and unreachable Stations

Every Station request the CLI makes has a **30 second deadline**. Without one, a
Station that accepts the connection but never answers left commands printing
nothing at all, indefinitely — the worst failure mode for a command inside a
script. Set `STATION_REQUEST_TIMEOUT_MS=<ms>` to change it, or `0` to disable
the deadline entirely.

Deliberately exempt, because their responses are open-ended by design and a
deadline would abandon healthy work:

| Exempt | Why |
|--------|-----|
| `chat` / `sessions` streaming turns | The POST response *is* the token stream; it lasts as long as the agent takes. |
| Orchestration and approval SSE streams (`operate`, `approvals`, `sessions`) | Long-lived event streams; they carry their own `AbortSignal`. |
| `monitoring events` (live form) | Same — a live stream, ended by interrupting it. |
| `knowledge reindex` / `knowledge migrate` | Duration scales with your corpus, not with Station's health. |
| `flow attach-command` | Runs a gate command server-side; bounded by its own `--timeout-ms`. |
| `start`/`build` readiness probes | Already enforce their own startup deadlines. |

Transport failures name the Station that was targeted *and where that address
came from*, so a wrong-target mistake is visible without re-deriving the
resolution order:

```console
$ station agents list
Error: Can't reach the channel-resolved loopback Station (default). Is it running? Start it with ./station start, or target another Station with --station=<name> or --api-base=<url>.

$ station agents list --station=laptop
Error: Station at http://192.168.1.9:3141 (from --station=laptop) did not respond within 30s. Check it with ./station doctor, raise the limit with STATION_REQUEST_TIMEOUT_MS=<ms>, or target another Station with --station=<name> or --api-base=<url>.

$ station agents list --api-base=https://typo.example.invalid
Error: Can't resolve the host in https://typo.example.invalid (from --api-base). Check the address, or list your Stations with `station stations list`.
```

A deadline miss on a **write** gets a different sentence, because it is a
different fact. The client stopped waiting; it never observed a failure, and
Station may have applied the change after it stopped listening — so the message
neither reports a failure nor invites a retry:

```console
$ station agents create --file=./reviewer.json
Error: Gave up waiting for the channel-resolved loopback Station (default) after 30s. The request was a write and may still have been applied — the client stopped waiting before Station answered, so it cannot tell. Check whether it took effect before retrying. If Station is simply slow, STATION_REQUEST_TIMEOUT_MS=<ms> raises the deadline for the next attempt.
```

Which sentence you get is decided by the *operation*, not by its HTTP verb.
Several reads are POSTs because they carry a body — `knowledge search`,
`connections test`, `runs output`, `plugins preview` — and those declare
themselves read-only, so a timeout on one keeps the read message above rather
than claiming your state may have changed.

---

## Stations

### `stations`, `target`, and `setup`

Saved Stations are the single named target contract used by the CLI and native
Desktop. They contain endpoint and Environment association metadata plus an
opaque credential reference, never bearer material. Forgetting one only removes
it from this device; it does not stop or delete that Station.

```text
station stations list
station stations show <name>
station stations add <name> <endpoint> [--pair] [--default] [--force]
station stations edit <name> <endpoint> [--pair] [--default] [--force]
station stations pair <name> [--force]
station stations use <name>
station stations forget <name>
station stations project show|use <name>|clear
station stations export
station target [--station=<name>|--api-base=<url>]
station triage [--context-only] [--agent=codex|claude] [--problem=<text>] [--search-issues] [--station=<name>|--api-base=<url>] [--credential=<token>]
```

Adding, showing, exporting, or targeting a Station does not change the
default. Only `stations use`, `--default` on an add/edit action, or one of the
setup flows deliberately selects it. Add and edit are metadata-only unless
`--pair` is supplied, and explicitly report that their Station is unauthenticated.
`stations pair <name>` obtains a new OS-keyring credential through the same
approval flow; it preserves the old binding until approval, keyring storage,
and one metadata commit complete. `target` reports the exact resolution
source, endpoint, Environment, credential state, reachability, and local
service state when applicable. It never starts a Station or falls through from
an unreachable remote Station to local state.

```text
./station setup local [--name=kontour] [service flags]
station setup existing <name> <endpoint> [--pair] [--device-name=<name>]
station setup hosted [--name=station.kontourai.io] [--device-name=<name>]
station setup import detect|preview|review-targets|apply|receipt|rollback [target flags]
```

Local setup is checkout-only because it installs Station under launchd,
systemd, or Windows Task Scheduler before creating the default Station. A
failed install saves no Station. Existing setup can select an unpaired
Station deliberately or reuse the ordinary pairing pipeline with `--pair`.
Hosted setup pairs with `https://station.kontourai.io` and selects it only after
authentication succeeds; a denied or interrupted request preserves any prior
saved Station, default selection, and credential reference for an honest retry.

### `triage`

`station triage` creates an opaque owner-only run under
`$STATION_ROOT/cache/triage/<uuid>`. Each run has schema-v1 `context.json`,
readable `summary.md`, the versioned Station-owned `playbook.md`, bounded
`problem.md`, and `related-issues.json`. Successful agent runs also retain a
redacted `diagnosis.md` and complete local `issue-draft.md`. The
context contains only bounded, redacted CLI provenance, selected Station facts,
and source-doctor facts when the checkout launcher injects that callback. When
an existing credential is available, it uses the authenticated raw
`/api/diagnostics/bundle` seam and retains only allowlisted app
version/platform/build facts, a summarized doctor report, and a re-sanitized,
bounded log tail. It drops bundle config and every other field. It does not
read keyring values directly, pairing/local-grant secrets, databases, arbitrary
environment values, provider payloads, or unbounded logs; absent authentication
or an unreachable Station is recorded as unavailable, never fatal.

```bash
station triage --context-only
station triage --agent=codex
station triage --agent=claude
station triage --problem='Beta stopped opening' --search-issues --agent=codex
```

`--context-only` skips agent probing and launch while still collecting the same
read-only source-doctor and authenticated remote facts available to a normal
run. Without an explicit agent,
Station selects the only detected supported agent. When both are detected in a
TTY it asks the owner to choose; in a non-interactive shell it preserves
artifacts and tells the caller to choose `--agent=codex` or `--agent=claude`.
No installed agent is a successful portable-artifacts result.

`--problem` stores a bounded, redacted symptom. Triage never transmits it by
default. `--search-issues` is explicit non-interactive consent to send that
text only to `gh issue list --repo kontourai/station`; an interactive run asks
the same yes/no question immediately before searching. Results retain only
bounded issue number/title/state fields. No GitHub write command exists here.

Codex is launched only with approval disabled, its read-only sandbox, an
ephemeral session, and user config ignored; Claude is launched in safe plan
mode with session persistence, Chrome, and slash commands disabled and only
Read/Glob/Grep tools available. Both receive a short argument pointing at the run-local playbook,
not a multiline prompt argument; processes use argv arrays with no shell. The
playbook consumes only Station's consented related-issue artifact. Station
captures the agent's bounded final stdout, redacts it, and writes
`diagnosis.md` plus `issue-draft.md` with model/agent and harness attribution;
it forbids repairs, service commands, state/database writes,
source patches, and every GitHub write. Posting or repair remains an explicit later
Station action. The packaged client states that local host filesystem and the
source doctor are unavailable.

---

## Configuration

### `config`

Read and write Station's own application config
(`$STATION_HOME/config/app.json`, default
`~/.station/instances/<channel>/config/app.json`). A bare
`station config` prints every value as JSON.

```
station config
station config get <key>
station config set <key> <value> [--offline]
```

| Argument | Description |
|----------|-------------|
| `<key>` | A top-level configuration field, e.g. `registryUrl`. |
| `<value>` | The new value. `true`/`false` are stored as booleans, all-digit values as numbers, the literal `null` unsets the key, and everything else is stored as a string. |
| `--offline` | Skip the live Station route and write `config/app.json` directly. |

`config get <key>` prints `(not set)` for an absent key.

```bash
station config
station config get registryUrl
station config set registryUrl https://example.com/registry.json
station config set registryUrl null      # unset
```

**`config set` writes through Station's live `PUT /config/app` route by
default** (archive#175): when a Station is reachable at the resolved
`--api-base`/`--station`/`STATION_TARGET`, the write goes through the same
sanitize/validate/reload path the Settings UI uses, so a running Station never
silently diverges from the file on disk. A typed violation exits non-zero with
the server's message; a key the server ignores (unknown, or runtime-derived
like `mcpUiFrameOrigin`) is printed as a warning, not silently dropped. If no
Station is reachable, the command errors and names both ways forward: retry
once Station is reachable, or pass `--offline` to write `config/app.json`
directly — that offline path still runs the same registry validation
locally, it just cannot apply a running Station's live reload/event-emit
side effects. `config get` has no such divergence risk: it reads through the
live route when reachable (showing an env-override provenance note where one
applies) and falls back to the file quietly when it isn't.

A mistyped action is a failure, not a listing: `station config sett` exits
non-zero and names the valid actions.

### `export`

Export Station's configured agents and tool servers into another tool's format.
Writes to stdout unless `--output=<path>` is given.

```
station export --format=<agents-md|claude-desktop> [--output=<path>]
```

| Flag | Description |
|------|-------------|
| `--format=agents-md` | An `AGENTS.md`-style Markdown description of the configured agents. |
| `--format=claude-desktop` | A Claude Desktop MCP server configuration block. |
| `--output=<path>` | Write to a file instead of stdout. |

`--format` is required; omitting it is an error rather than a default.

Environment-backed secret bindings are local runtime authority, not portable
configuration. Exports carry only required environment-name hints for them:
never a binding id, Datum reference, or materialized value. `--include-secrets`
can still export an ordinary legacy environment entry for compatibility, but it
never exports a binding-backed entry (including a temporary legacy overlap).
Imports reject `secretEnvRefs` outright.

> **Warning:** `--include-secrets` writes ordinary legacy credentials as
> plaintext to the export. Binding material and binding references are never
> exported.

```bash
station export --format=agents-md
station export --format=claude-desktop --output=~/claude_desktop_config.json
```

### `secret-bindings migrate-stored-env`

Migrate stored legacy credentials for one saved MCP integration only after its
Datum bindings have been created. The positional argument is an **integration
id**, never a binding id. New clients use
`/api/secret-bindings/integrations/:integrationId/migrate-stored-env`; the
previous unqualified route remains a compatibility alias.

```bash
station secret-bindings migrate-stored-env github --data='{"bindings":{"GITHUB_TOKEN":{"bindingId":"github-token","expectedRevision":2}}}'
```

### `import`

Import a previously exported configuration file back into this Station home.
The file extension selects the parser: `.json` is read as a Claude Desktop MCP
configuration (importing tool servers), anything else is read as an
`AGENTS.md`-style document (importing agents, and writing app-config guidance
rather than silently overwriting settings).

Every import writes a ledger under the Station home recording the source path,
format, what was applied, and any fields that could not be represented, so a
lossy import is visible after the fact rather than assumed.

```
station import <file>
```

```bash
station import ./AGENTS.md
station import ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

---

## Core Workspace

These commands expose the same agent/project/skill surfaces used by
the UI and REST API. Payload-bearing commands accept JSON via:

- `--data='{"key":"value"}'`
- `--file=/absolute/or/relative/path.json`
- piped stdin

### `agents`

```
station agents list [--api-base=<url>]
station agents get <slug> [--api-base=<url>]
station agents create --data=<json> [--api-base=<url>]
station agents update <slug> --data=<json> [--api-base=<url>]
station agents delete <slug> [--api-base=<url>]
station agents conversations <slug> [--api-base=<url>]
station agents messages <slug> <conversationId> [--api-base=<url>]
station agents workflows <list|get|create|update|delete> ... [--api-base=<url>]
station agents chat <slug> <message> [--project=<project-slug>] [--conversation=<id>] [--model=<id>] [--api-base=<url>]
```

`station agents get <slug>` includes that Agent's delegated-child denial
catalog. Built-in Station denials and operator-configured denial patterns are
separate, and every entry explains the refusal rather than only showing a
pattern.

Examples:

```bash
station agents list
station agents create --data='{"name":"Planner","slug":"planner","prompt":"Plan carefully."}'
station agents update planner --file=./planner-update.json
station agents workflows list planner
station agents chat planner "Summarize the open work"
```

`--project=<project-slug>` on both `agents chat` and `chat` (below) binds a
**new** orchestration session's `cwd`/`metadata.projectSlug` to that
project's configured `workingDirectory` when the target agent is
bound to an external engine — this is a no-op for Station-engine Agents, which
are already project-scoped server-side. If the project has no `workingDirectory`
configured, the command fails with an actionable error instead of silently
starting an unscoped session. If `--project` is passed while continuing an
already-loaded session (`--conversation=<id>` on an active thread), the CLI
prints a stderr warning that the flag has no effect rather than silently
dropping it.

### `chat`

Shortcut for chatting with a configured agent. Use `--conversation=<id>` to
continue an existing managed conversation or orchestration-backed runtime
session.

`--title` is currently rejected on this canonical foreground path; Station
does not silently discard it. Conversation naming will return when it is part
of the shared execution contract.

```
station chat <agent> <message> [--on=<environment>] [--project=<project-slug>|--cwd=<path>] [--conversation=<id>] [--model=<id>] [--approval-mode=<ask|auto|never|connection-default>] [--effort=<level>] [--thinking=<true|false>] [--model-option key=value]... [--on-request=<wait|fail>] [--api-base=<url>]
```

Examples:

```bash
station chat station "What changed in this repo?"
printf 'Review the latest project state' | station chat planner
station chat ollama "Reply with exactly: OK" --conversation=runtime-demo --model=llama3.2:latest
station chat codex "Summarize the open work" --project=launchpad
station chat codex "Probe the media host" --on=env-media-host --project=my-project
station chat codex "Fix the failing test" --cwd=/repos/launchpad --approval-mode=auto --effort=high
station chat codex "Continue" --conversation=runtime-demo --approval-mode=never
```

`--on=<environment>` selects a saved Environment; omitting it means the current
Environment. The controlling Station sends the canonical Environment + Agent
target to that Environment for resolution. The CLI never selects an engine,
connection, provider, tunnel, or remote API URL for execution.

`--approval-mode`/`--effort`/`--thinking`/`--model-option` (station#978) set
per-invocation settings on an Agent whose resolved engine supports them. A Station-engine Agent has no
per-invocation engine settings surface and the CLI rejects these flags for
one rather than silently dropping them. `--approval-mode` accepts exactly
`ask`, `auto`, `never`, or `connection-default` (an invalid value is a usage
error, exit 1, before any request); `--effort` and `--thinking` are
otherwise engine-specific. `--model-option key=value` is a repeatable
escape hatch for any `modelOptions` key not covered by a named flag — named
flags always win a key collision. An option key the target engine's adapter
doesn't actually read is rejected with an explicit 400 naming the option
and target (nothing is silently dropped); see
`packages/contracts/src/provider.ts`'s `PROVIDER_MODEL_OPTION_SUPPORT` for
the authoritative per-engine list. Resuming with `--session=<id>` retains the
original model and workspace binding. Model/workspace flags on a resume are
rejected; start a new Agent-targeted chat to request different launch controls.

`--model` is capability-gated at the same shared orchestration dispatch seam as
the API. Omission may deliberately be engine-selected (Codex does not receive a
fabricated default id); Bedrock and Ollama require a catalog-backed selector at
session start, then retain the accepted selector for an omitted resume or turn.
An explicit replacement is catalog-validated before execution.
Claude and Codex accept only lifecycle points their adapters declare. ACP model
overrides are rejected before readiness, model discovery, or the engine process
is invoked with the stable
`model-override-unsupported` error; Station does not claim an effective model
for that rejected request.

`--cwd=<path>` binds a **new** runtime session's `cwd` to an explicit
directory, independent of any registered project (unlike `--project`, no
Project needs to exist) — use `--project` or `--cwd`, not both. The path is
validated fail-closed server-side (mirrors the `--project` behavior above):
a `cwd` that doesn't exist on the target Station's filesystem fails the
canonical execution request rather than silently spawning the adapter somewhere else.

`--on-request=<wait|fail>` (station#979, default `wait`) governs what
happens when the target opens a pending request (approval/permission/
confirmation/input) mid-turn — on both the orchestration (runtime) and
managed (Station-agent) dispatch paths. Previously this hung the CLI
silently until the request was resolved out-of-band or a ~60s auto-deny
elapsed, with no indication. Now a notice always prints to stderr naming
the `requestType`, `title`, `requestId`, `threadId`, and (on the runtime
path) the ready-to-run command to answer it:

```bash
station approvals respond <thread-id> <request-id> <accept|acceptForSession|decline|cancel>
```

`--on-request=wait` keeps waiting for the request to be resolved
out-of-band (the notice just makes the wait legible). `--on-request=fail`
stops waiting and exits **4** instead, leaving the session alive and
resumable — it is never torn down (no `stopSession`) just because a
request opened. `--json` carries a typed `pendingRequest` field
(`requestId`/`requestType`/`title`/`respondCommand` on the runtime path;
the managed path's `tool-approval-request` chunk has no CLI responder yet,
so its `pendingRequest` omits `respondCommand` rather than naming a command
that doesn't exist) plus `lifecycleState` (the session's
`SessionLifecycleState`, e.g. `needs_input`/`review_pending`) whenever
either is present — distinguishing a stalled turn from a merely slow one.

**Managed-chat orchestration — landed, and not behind a flag.** A managed
Station-agent `station chat <slug>` starts a private `station-agent`
orchestration session (mirroring `station delegate`) rather than calling the
managed chat route directly, so the chat lands an orchestration event-store
row and appears in `station runs` with agent + model metadata, and
`--on-request`/approvals ride the same canonical `request.opened` vocabulary
as any other engine. **This is unconditional.** station#1418/#1415 cut every
interactive caller over and `STATION_FEATURES=managed-chat-orchestration` was
never flipped — it is inert and switches nothing, so do not reason about it
as a toggle.

`--title` is rejected on this path regardless (explicitly, not silently
dropped). See
`docs/adr/0014-the-chat-convergence-landed-unconditionally-not-behind-the-flag.md`,
which supersedes ADR-0010's cutover-mechanism clause only; ADR-0010 remains
the record for the Option A decision and the New-Chat privacy constraint.

### `sessions`

Unified session management for managed conversations and orchestration-backed runtime sessions.

```
station sessions list <agent> [--api-base=<url>]
station sessions read <agent> <session-id> [--api-base=<url>]
station sessions inspect <agent> <session-id> <event-id> [--json] [--api-base=<url>]
station sessions interrupt <agent> <session-id> [--turn=<turn-id>] [--api-base=<url>]
```

Examples:

```bash
station sessions list station
station sessions read station conv-123
station sessions inspect station conv-123 tool-result-event-1
station sessions list codex
station sessions interrupt codex runtime-thread --turn=turn-1
```

### `conversation`

Export a conversation as a portable thread, or in a provider-native format.

```
station conversation export <agent> <conversationId>
```

- `--format=<fmt>` — `thread` (default), `anthropic-messages`, `openai-chat`, `gemini`, `markdown`
- `--output=<path>` — write to a file instead of stdout

Accepts the shared target flags (`--api-base`, saved Stations); the exported
`thread` format is the portable conversation envelope, and the provider
formats are one-way projections of it.

### `delegate`

Hand Station a Task (create) to an Agent, get back a durable Conversation identity, and headlessly supervise
its current Session (status, events, respond, interrupt) or discover ready targets
(targets) — a scriptable path to the same delegation lifecycle a UI-launched
delegation uses, over `station-control-delegation.ts`'s service functions
(`GET /delegations`, `GET /delegations/:taskId`, `GET
/delegations/:taskId/events`, `POST /delegations/:taskId/continue`, `POST
/delegations/:taskId/respond`, `POST /delegations/:taskId/interrupt`, plus
the already-wired `POST /delegations` and `POST /delegations/options`).

```
station delegate --agent=<slug> [--on=<environment>] [--model=<id>] [--project=<slug>|--project-path=<path>|--cwd=<path>] [--parent-task=<task-id>] [--approval-mode=<ask|auto|never|connection-default>] [--effort=<level>] [--thinking=<true|false>] [--model-option key=value]... [--on-request=<wait|fail>] [--json] <prompt|--data=<text>|--file=<path>|stdin>
station delegate --session=<conversation-id> [--on=<environment>] [--model=<id>] [--approval-mode=<ask|auto|never|connection-default>] [--effort=<level>] [--thinking=<true|false>] [--model-option key=value]... [--on-request=<wait|fail>] [--json] <message>
station delegate status <task-id> [--on=<environment>] [--json]
station delegate events <task-id> [--after=<cursor>] [--on=<environment>] [--json]
station delegate continue <legacy-id> <message> [--on=<environment>] [--model=<id>] [--approval-mode=<ask|auto|never|connection-default>] [--effort=<level>] [--thinking=<true|false>] [--model-option key=value]... [--on-request=<wait|fail>] [--json] # deprecated compatibility alias
station delegate respond <task-id> <request-id> <accept|acceptForSession|decline|cancel> [--on=<environment>] [--json]
station delegate interrupt <task-id> [--on=<environment>] [--json]
station delegate targets [--on=<environment>] [--project=<slug>|--project-path=<path>] [--json]
```

`--session=<conversation-id>` is the one continuation selector across
foreground chat and delegation. It resolves the Conversation's current child
Session at the serving Station; callers do not choose a Session just to send a
follow-up. `task:` and `cli:` identifiers remain accepted as legacy
conversation identities. `delegate continue <legacy-id> <message>` routes to
the same continuation implementation, but is deprecated for at least this
release and emits a migration notice. Supervision verbs keep their deliberately
different scope: `status`, `events`, `respond`, and `interrupt` operate on the
resolved current Session/task and their output identifies both the durable
`conversationId` and `currentSessionId`. `taskId` remains a compatibility alias
where it was already present.

Creation accepts only the authored prompt, target, and optional parent Task.
The serving Station produces the resulting Conversation and Session identities;
they are response handles, never caller-selected create fields.

This does not add named saved-Station, credential, home, or port setup;
that concern remains separate from conversation selection.

Examples — delegating to a Station agent, then supervising it headlessly:

```bash
station delegate --agent=station --json "Summarize the open work" --api-base=http://your-tailnet.ts.net:3141
# {"ok":true,"kind":"delegate.create","data":{"taskId":"task:...","status":"dispatched",...}}

station delegate status task:0f3c... --json
station delegate events task:0f3c... --json
station delegate --session=task:0f3c... "Also check the failing test" --json
station delegate interrupt task:0f3c... --json
```

Delegating to an External agent by its Agent ID on a saved Environment:

```bash
station delegate --agent=codex --on=env-media-host --model=gpt-5.6-sol "Review the diff" --json
station delegate respond task:0f3c... req-1 accept --json
```

Discovering ready targets before delegating:

```bash
station delegate targets --json
```

Setting per-invocation engine settings (station#978) — an External agent
target only; a Station agent target rejects these
flags rather than silently dropping them:

```bash
station delegate --agent=codex --approval-mode=auto --effort=high "Fix the failing test" --json
station delegate --session=task:0f3c... "Keep going" --approval-mode=never --json
station delegate --agent=codex --model-option=fastMode=true "Quick check" --json
```

`--approval-mode` accepts exactly `ask`, `auto`, `never`, or
`connection-default` (an invalid value is a usage error, exit 1, before any
request). `--model-option key=value` is a repeatable escape hatch for any
`modelOptions` key not covered by a named flag; named flags always win a
key collision. An option key the target's adapter doesn't actually read is
rejected with an explicit exit-3 error naming the option and target —
including a Station agent target, whose `modelOptions` are inert (never
read by the managed chat path), so accepting one there would silently do
nothing. `--cwd=<path>` (create only) binds to an explicit directory
instead of a project — use `--project`/`--project-path` or `--cwd`, not
both; a follow-up selected by `--session` reuses the workspace bound at
creation and rejects `--cwd`.

`--on=<environment>` is accepted on every sub-verb (not just `create`/
`targets`) so a task living on a non-current SSH environment can still be
supervised remotely — omitting it would silently restrict `status`/
`events`/conversation continuation/`respond`/`interrupt` to the current environment only.

`--after=<cursor>` (on `events`) takes the **opaque** `nextCursor` string a
previous page returned (`station-task-events:v1:<n>`) — never a raw
sequence number. Read it from the prior page's own `--json` output and pass
it back verbatim to resume without replaying history.

`--json` on every `delegate` verb emits one stable shape from a single
shared helper: `{"ok": true, "kind": "delegate.<verb>", "data": {...}}` —
e.g. `delegate.create`, `delegate.status`, `delegate.events`,
`delegate.continue`, `delegate.respond`, `delegate.interrupt`,
`delegate.targets`.

`--on-request=<wait|fail>` (station#979, default `wait`, `create`/
conversation continuation only) — `delegate` dispatch is fire-and-forget (the server
returns a `status: 'dispatched'` handle immediately; there is no live
event stream open at the CLI call site to react to mid-turn, unlike
`chat`). `--on-request=fail` makes exactly one follow-up status check
(`observeDelegatedTask`) right after dispatch: if the task already shows a
`pendingRequest`, it prints the request and the exact
`station delegate respond <task-id> <request-id> <decision>` command and
exits **4** instead of the ordinary success output, leaving the Conversation
alive. `--on-request=wait` skips that check entirely (today's behavior,
unchanged). Independent of `--on-request`, `station delegate status`
always prints the respond-command hint alongside an existing
`pendingRequest`.

Exit codes, scoped to `delegate` only (every other command's exit behavior
is unchanged):

- `0` — success
- `1` — usage error (a missing/invalid argument, before any request is attempted) — the same as every other CLI command
- `2` — transport failure (the target Station is unreachable or timed out)
- `3` — delegation rejection (a received-but-unsuccessful response: bad target, not ready, or a deps-unavailable/business-rejection response)
- `4` — `--on-request=fail` found a request already pending right after dispatch/continue (the task is left alive, not torn down)

### `tasks`

List, read, create, and attach exact completed assistant answers to durable
Project Tasks. Task creation requires an existing Project. Station derives the authoritative working directory and any Git
top-level, worktree, and branch from server-side Project state; optional values
in `workspaceBinding` are corroborating assertions and contradictory values are
rejected.

```
station tasks list [--api-base=<url>]
station tasks get <task-id> [--api-base=<url>]
station tasks create --json='<task-json>' [--api-base=<url>]
station tasks attach-turn <task-id> --session=<session-id> --turn=<turn-id> [--api-base=<url>]
station tasks show-turn <task-id> [--api-base=<url>]
station tasks attach-result <task-id> --session=<session-id> --event=<event-id> [--api-base=<url>]
station tasks show-results <task-id> [--json] [--api-base=<url>]
```

Examples:

```bash
station tasks list
station tasks get 61cc19c7-3b56-46e2-b0d4-9ff6ce7c2b4b
station tasks create --json='{"projectId":"station","title":"Document durable Task recovery","workspaceBinding":{"sourceSurface":"cli"}}'
station tasks attach-turn 61cc19c7-3b56-46e2-b0d4-9ff6ce7c2b4b --session=session-1 --turn=turn-1
station tasks show-turn 61cc19c7-3b56-46e2-b0d4-9ff6ce7c2b4b
station tasks attach-result 61cc19c7-3b56-46e2-b0d4-9ff6ce7c2b4b --session=session-1 --event=tool-result-event-1
station tasks show-results 61cc19c7-3b56-46e2-b0d4-9ff6ce7c2b4b
```

`attach-turn` persists only the exact Session/turn identity. Station
reauthorizes the Session and confirms a completed assistant answer before it
creates the relation; execution provenance does not imply semantic support.
`show-turn` reauthorizes every stored answer reference and returns the current
available answer/provenance projections plus typed unavailable entries.
`attach-result` stores only the exact Session/tool-result event identity;
Station reauthorizes its terminal result before it creates the relation.
`show-results` reauthorizes every stored tool-result reference and returns only
the bounded safe result projection. Missing, denied, malformed, and revoked
results remain generic; resolver outages are retryable.

`get` returns the binding's current `availability`: `available`, `ambiguous`,
or `unavailable`. Only `available` means Station can safely use the binding for
local inspection. Task identity and references persist even when optional
Builder, Knowledge, Flow, or Console capabilities are absent.

### `approvals`

List and resolve orchestration approval requests (`request.opened` events awaiting
a `request.resolved`) for an external-engine Agent, without raw `curl` against
`/api/orchestration/commands`. Adds no new server routes: `list` reads
`GET /api/orchestration/sessions/:threadId` (or `.../sessions/read-model` to scan
every thread for `--agent`'s provider when `--thread` is omitted) and derives
"pending" the way the server does; `respond` calls the existing
`POST /api/orchestration/commands {type:'respondToRequest'}` route.

```
station approvals list --agent=<slug> [--thread=<id>] [--watch] [--json] [--api-base=<url>]
station approvals respond <thread-id> <request-id> <accept|acceptForSession|decline|cancel> [--json] [--api-base=<url>]
```

`--agent` must be a persisted Agent ID whose execution binds to an external
engine (for example `codex` or `kiro`) — approvals are an
orchestration-session concept, and the provider is resolved from that binding.
Station#979 AC5: resolution reads the connection's own
`config.provider` (or `'acp'` for an ACP-transported connection), so an
ACP connection (Kiro, OpenCode) or a Bedrock connection is listable and
respondable exactly like a `claude`/`codex`/`ollama` binding. No provider
is inferred from Agent ID text. `--watch` is
thread-scoped only: it attaches to
`GET /api/orchestration/events?threadId=<id>` (the one SSE endpoint that
supports a `threadId` filter), reprints on every `request.opened`/
`request.resolved`, and exits once the session reports `session.exited`;
`--watch` without `--thread` is a documented error, not a multi-thread
capability. `--json` (both verbs) prints compact single-line JSON instead of
the default pretty-printed output — an approvals-local opt-in, not a
repo-wide default change.

Examples:

```bash
station approvals list --agent=codex --thread=runtime-thread
station approvals list --agent=codex --json
station approvals list --agent=kiro --thread=kiro-thread
station approvals respond runtime-thread req-1 accept
```

### `operate`

One-screen terminal operator view for supervising a hosted run — a session
board, a live transcript for one focused session, that session's pending
approvals (tool name **and** input, answerable by a single keypress), and its
Flow gate verdicts — with no `curl` and no browser. The whole screen is
reduced from one global `GET /api/orchestration/events` connection (the same
route `approvals --watch` uses, opened once and unfiltered — board,
transcript, approvals, and gates all derive from this single stream) plus
three on-demand, non-continuous pulls when focus changes or on manual
refresh: `GET /api/orchestration/sessions/:threadId` (seeds a session's full
history), `GET /api/orchestration/sessions/:threadId/flow-run`
(`getSessionFlowRun`), and `GET
/api/orchestration/sessions/:threadId/builder-run` (`getSessionBuilderRun`,
archive#189 S4).

The GATES pane renders the Builder run as its own row, never merged into the
Flow-run lines above it: they are two different runs with independent
lifecycles, and a session commonly has one and not the other. The row states
which task was joined, HOW it was joined (`match=started-by-station` when
Station started the session against that task slug, `match=correlation-matched`
when the sidecar's `run_correlation.identities.runtime_session` exactly equals
this session's thread id), and whether that runtime identity is present at
all. Anything short of a unique exact match renders `builder run: unavailable`
with the reason — a near match is never presented as a join.

The projected step/status are labelled with the sidecar file's own
`updated_at` ("per sidecar write at …") and carry no freshness claim beyond
it, because `flow_run` has no currency stamp upstream. Two states that look
alike are kept apart: a task whose sidecar was read but has published no run
prints "no run projection published for this task yet", while a binding whose
sidecar could not be read at all prints only its reason — claiming the former
for the latter would assert a currency nobody has.

```
station operate [--session=<id>] [--api-base=<url>]
```

`--session=<id>` sets the initially-focused session; when omitted, `operate`
focuses the first row of the session board once it arrives. `operate`
refuses to start when stdout is not an interactive TTY (e.g. piped/redirected
output) with a clear error pointing at `station sessions`/`station
approvals`/`station chat` for scripting instead of half-rendering a terminal
UI into a non-terminal stream.

Keybindings:

| Key(s) | Action |
| --- | --- |
| `Tab` | cycle session focus forward |
| `Shift+Tab` | cycle session focus backward |
| `Up` | move approval selection up |
| `Down` | move approval selection down |
| `a` | accept selected approval |
| `s` | accept selected approval for the rest of the session |
| `d` | decline selected approval |
| `x` | cancel selected approval |
| `r` | manual refresh: re-seed the focused session history + flow-run/builder-run pulls |
| `q` / `Ctrl+C` | quit `operate` |

(This table is transcribed from `packages/cli/src/commands/operate/keys.ts`'s
`OPERATE_KEYBINDINGS` — the canonical source; the two must not drift.)

Examples:

```bash
station operate
station operate --session=runtime-thread
station operate --api-base=http://127.0.0.1:3242
```

**Verification-lane decision:** the pure reducer/render/keypress-intent core
(`reduce()`, `render()`, `classifyKey()`) is fully unit-tested (table-driven,
TTY-free, part of `npm test`), and the SSE-lifecycle/keypress-wiring shell is
covered by an integration test using a real `node:http` mock server plus a
non-TTY `PassThrough`-fed keypress stream (`operate-shell.test.ts`) — no PTY
is required for either lane. What is **not** covered by an automated lane in
this delivery is the actual raw-mode terminal repaint loop end-to-end (real
terminal, real cursor movement, real visual output); building a PTY-driven
harness for a terminal screen was judged out of scope for this delivery.
Instead, run the **manual verification protocol** below once per delivery
that touches `operate`, and record the results (a post-merge dogfood run,
`run-004` or successor, closes this loop with a real self-hosted delivery
session as evidence):

1. Start an instance, run `station operate`, and confirm the session board
   renders and updates live as a session starts (`station sessions list`
   or a chat session against an external-engine Agent is a good driver).
2. Trigger an approval (e.g. a tool-permission prompt from an external-engine
   agent). Confirm it appears in the approvals pane with both the tool name
   **and** its input, answer it with a keypress (`a`/`s`/`d`/`x`), confirm it
   clears from the pane, and cross-check with `station approvals list` that
   the underlying request was actually resolved.
3. Confirm the gate-verdicts pane shows the honest "not Flow-bound"
   placeholder for a session with no Flow run attached, and real
   `current_step`/`status`/verdict/`openGates` for a Flow-bound one.
4. Quit with `q`; confirm the terminal returns to normal — cursor visible,
   not stuck in raw mode, shell prompt usable. Repeat, quitting with
   `Ctrl+C` instead.
5. Note any friction (the same way `run-003`'s operator log did) and feed it
   forward into the next dogfood run's operator log.

**Windows caveat:** `operate`'s repaint uses raw ANSI escape sequences
(cursor-home + clear-to-end) and Node core `readline` keypress events, both
of which work cross-platform with no new dependency. Windows Terminal,
PowerShell 7+, VS Code's integrated terminal, and mintty/Git Bash all process
these escapes correctly by default. Legacy `cmd.exe`/old `conhost` without
VT100 processing enabled may display raw escape bytes instead of a clean
repaint — a documented, accepted risk, not a blocker.

### `projects`

```
station projects list [--api-base=<url>]
station projects get <slug> [--api-base=<url>]
station projects create (--data=<json>|--file=<path>) [--station=<name>|--api-base=<url>]
station projects update <slug> --data=<json> [--api-base=<url>]
station projects delete <slug> [--api-base=<url>]
station projects layouts available [--api-base=<url>]
station projects layouts list <project> [--api-base=<url>]
station projects layouts get <project> <layout> [--api-base=<url>]
station projects layouts create <project> --data=<json> [--api-base=<url>]
station projects layouts update <project> <layout> --data=<json> [--api-base=<url>]
station projects layouts delete <project> <layout> [--api-base=<url>]
station projects layouts from-plugin <project> <plugin> [--api-base=<url>]
```

Example:

```bash
station projects create --data='{"name":"Launchpad","slug":"launchpad"}'
station projects layouts available
station projects layouts create launchpad --data='{"name":"Code","slug":"code","type":"coding"}'
```

For an imported checkout, follow [target Project registration](../guides/workspace-packages.md#register-the-restored-checkout-as-a-target-project). Use a target-visible path and an explicit enrolled Station; creation allocates a fresh Project identity.

### `skills`

```
station skills list [--api-base=<url>]
station skills get <name> [--api-base=<url>]
station skills create --data=<json> [--api-base=<url>]
station skills update <name> --data=<json> [--api-base=<url>]
station skills delete <name> [--api-base=<url>]
station skills install <name> [--api-base=<url>]
```

Example:

```bash
station skills create --data='{"name":"ship-it","body":"Execute the task."}'
station skills install code-review
```

### `connections`

```
station connections list [--api-base=<url>]
station connections models [--api-base=<url>]
station connections runtimes [--api-base=<url>]
station connections get <id> [--api-base=<url>]
station connections create --data=<json> [--api-base=<url>]
station connections update <id> --data=<json> [--api-base=<url>]
station connections delete <id> [--api-base=<url>]
station connections test <id> [--api-base=<url>]
```

### `flow`

Drive project-scoped Flow gate-engine runs (`/api/projects/:slug/flow`).

```
station flow definitions <project> [--api-base=<url>]
station flow runs <project> [--api-base=<url>]
station flow start <project> --definition=<id> [--run-id=<id>] [--api-base=<url>]
station flow get <project> <runId> [--api-base=<url>]
station flow attach-command <project> <runId> --gate=<id> --command=<cmd> --claim-type=<type> [--producer=<id>] [--label=<text>] [--expectation-ids=<csv>] [--supersede=<csv>] [--timeout-ms=<n>] [--api-base=<url>]
station flow evaluate <project> <runId> [--gate=<id>] [--api-base=<url>]
station flow report <project> <runId> [--api-base=<url>]
```

`attach-command` runs the command **server-side in the project workspace**
(same trust level as scheduler jobs and tool servers) and attaches the output
tail as claim evidence: exit 0 attaches the claim with status `assumed` — a
passing command is a claim, not verification, and Surface downgrades
`verified` without backing evidence; a non-zero exit or timeout attaches
failed evidence with `route_reason: implementation_defect` so the next
`evaluate` routes back.

### `tools`

```
station tools list [--api-base=<url>]
station tools get <id> [--api-base=<url>]
station tools create --data=<json> [--api-base=<url>]
station tools update <id> --data=<json> [--api-base=<url>]
station tools delete <id> [--api-base=<url>]
station tools reconnect <id> [--api-base=<url>]
```

### `notifications`

```
station notifications list [--status=<csv>] [--category=<csv>] [--api-base=<url>]
station notifications create --data=<json> [--api-base=<url>]
station notifications delete <id> [--api-base=<url>]
station notifications dismiss <id> [--api-base=<url>]
station notifications clear [--api-base=<url>]
station notifications providers [--api-base=<url>]
station notifications action <id> <actionId> [--api-base=<url>]
station notifications snooze <id> --until=<iso> [--api-base=<url>]
```

### `monitoring`

```
station monitoring stats [--api-base=<url>]
station monitoring metrics [--range=<today|week|month|all>] [--api-base=<url>]
station monitoring events [--start=<epoch-ms|iso>] [--end=<epoch-ms|iso>] [--user-id=<id>] [--limit=<n>] [--api-base=<url>]
```

Without `--start`/`--end`, `station monitoring events` streams live monitoring
events as JSON lines. `--limit` applies to a bounded read only — passing it
alone does not turn the live stream into a historical query.

### `schedule`

```
station schedule jobs [--api-base=<url>]
station schedule list [--api-base=<url>]
station schedule providers [--api-base=<url>]
station schedule stats [--api-base=<url>]
station schedule status [--api-base=<url>]
station schedule preview "<cron>" [count] [--api-base=<url>]
station schedule logs <job> [count] [--api-base=<url>]
station schedule create --data=<json> [--api-base=<url>]
station schedule update <job> --data=<json> [--api-base=<url>]
station schedule run <job> [--api-base=<url>]
station schedule enable <job> [--api-base=<url>]
station schedule disable <job> [--api-base=<url>]
station schedule delete <job> [--api-base=<url>]
```

`create` and `update` accept either the compatible `cron` field or a canonical
schedule object: `{kind:"cron",expr,timezone?}`,
`{kind:"every",everyMs}`, or `{kind:"at",timeMs,deleteAfterRun?}`. The same
operator lifecycle is exposed by the HTTP API, React-free SDK client, and
station-control MCP; only scheduler SSE/webhook transport plumbing is
intentionally API-only.

### `runs`

Read global run history through the neutral runs API (`/api/runs`) — every run
Station has recorded, regardless of which agent or engine produced it.

```
station runs list [--api-base=<url>]
station runs read <run-id> [--api-base=<url>]
station runs output --data=<json> [--api-base=<url>]
```

| Argument/Flag | Description |
|---------------|-------------|
| `list` | Every recorded run. Takes no filter flags today; filter the JSON downstream. |
| `read <run-id>` | One run's full record. `404` becomes `Run not found`. |
| `output` | Reads one output artifact. Takes a `RunOutputRef` JSON body via `--data=<json>`, `--file=<path>`, or piped stdin — not a positional run id. |

The `RunOutputRef` body is `{ source, providerId, runId, artifactId, kind }`,
where `kind` is `log`, `artifact`, or `output`; the fields come from the
`outputs` entries of a `station runs read` record.

```bash
station runs list
station runs read 01JB2C3D4E5F
station runs output --data='{"source":"orchestration","providerId":"volt","runId":"01JB2C3D4E5F","artifactId":"stdout","kind":"log"}'
```

### `knowledge`

```
station knowledge status [--api-base=<url>]
station knowledge search <query> [--root=<id> ...] [--top-k=<n>] [--json] [--api-base=<url>]
station knowledge namespaces list <project> [--api-base=<url>]
station knowledge namespaces create <project> --data=<json> [--api-base=<url>]
station knowledge namespaces update <project> <namespace> --data=<json> [--api-base=<url>]
station knowledge namespaces delete <project> <namespace> [--api-base=<url>]
station knowledge docs list <project> [--namespace=<id>] [--api-base=<url>]
station knowledge docs status <project> [--namespace=<id>] [--api-base=<url>]
station knowledge docs upload <project> [--namespace=<id>] --data=<json> [--api-base=<url>]
station knowledge docs scan <project> [--namespace=<id>] --data=<json> [--api-base=<url>]
station knowledge docs search <project> [--namespace=<id>] --data=<json> [--api-base=<url>]
station knowledge docs bulk-delete <project> [--namespace=<id>] --data=<json> [--api-base=<url>]
station knowledge docs content <project> <docId> [--namespace=<id>] [--api-base=<url>]
station knowledge docs tree <project> --namespace=<id> [--api-base=<url>]
station knowledge docs update <project> <docId> [--namespace=<id>] --data=<json> [--api-base=<url>]
station knowledge docs delete <project> <docId> [--namespace=<id>] [--api-base=<url>]
station knowledge docs clear <project> [--namespace=<id>] [--api-base=<url>]
```

### `auth`

```
station auth status [--api-base=<url>]
station auth renew [--api-base=<url>]
station auth terminal [--api-base=<url>]
station auth users search <query> [--api-base=<url>]
station auth users get <alias> [--api-base=<url>]
```

### `branding`

```
station branding get [--api-base=<url>]
```

### `feedback`

```
station feedback rate --data=<json> [--api-base=<url>]
station feedback delete --data=<json> [--api-base=<url>]
station feedback unrate --data=<json> [--api-base=<url>]
station feedback ratings [--api-base=<url>]
station feedback guidelines [--api-base=<url>]
station feedback analyze [--data=<json>] [--api-base=<url>]
station feedback clear-analysis [--api-base=<url>]
station feedback status [--api-base=<url>]
station feedback test [--api-base=<url>]
```

### `insights`

```
station insights get [--days=<n>] [--agent=<slug>] [--tool=<name>]
                     [--engine=<provider>] [--limit=<n>] [--api-base=<url>]
station insights events [--days=<n>] [--start=<epoch-ms|iso>] [--end=<...>] [--agent=<slug>]
                        [--tool=<name>] [--engine=<provider>]
                        [--conversation=<id>] [--tools] [--limit=<n>]
                        [--api-base=<url>]
```

`get` returns the rollup; `events` returns the rows behind it via
`/monitoring/events`, which owns the per-user and tenant authorization those
rows require. The window is always bounded — `--days` (default 14) unless you
pass `--start` or `--end` — because an unbounded request reaches that
endpoint's live SSE branch and never returns. `--limit` has **no default**:
omit it and you get every row in the window. It takes the most recent N by
timestamp (the endpoint orders rows by their own timestamp, so "most recent"
does not depend on the order the log files happened to be read), it caps at
5000, and `truncated` is reported only when rows were actually dropped.
Content is redacted on read. A `--start`/`--end` that cannot be parsed is an
error rather than a wider window. `--engine` reads the engine attribution added in
station#3074, so events written before it are excluded by that filter rather
than guessed at. The rollup also reports `totalOutcomeUnknown` — tool results
whose producer reported no terminal status, which are neither successes nor
failures and would otherwise flatter the error rate.

### `acp`

```
station acp status [--api-base=<url>]
station acp commands [--api-base=<url>]
station acp command-options [--q=<partial>] [--api-base=<url>]
station acp connections list [--api-base=<url>]
station acp connections create --data=<json> [--api-base=<url>]
station acp connections update <id> --data=<json> [--api-base=<url>]
station acp connections delete <id> [--api-base=<url>]
station acp connections reconnect <id> [--api-base=<url>]
```

`commands`/`command-options` read the ACP provider's slash-command list via
`GET /api/orchestration/providers/acp/commands` — a provider-keyed route
(one ACP adapter aggregates every ACP connection), not a per-agent-slug
lookup, so neither verb takes an `<agent-slug>` positional. There is no
server-side filtered-search route for `command-options`; `--q=<partial>` is
a client-side, case-insensitive substring filter over the fetched list's
`name`/`description` fields.

### `voice`

```
station voice status [--api-base=<url>]
station voice agent [--api-base=<url>]
station voice create-session [--data=<json>] [--api-base=<url>]
station voice delete-session <id> [--api-base=<url>]
```

---

## Application Lifecycle

### `service`

Install Station as a per-user background service, start or stop its installed
registration, inspect its health layers, or remove the service registration:

```bash
station service install [--instance=<name>] [--home=<dir>] [--base=<dir>] [--port=<n>] [--ui-port=<n>] [--host=<address>] [--features=<flags>] [--allowed-origin=<origin>]... [--clear-allowed-origins]
station service start [--instance=<name>] [--home=<dir>] [--base=<dir>] [--port=<n>] [--ui-port=<n>] [--json]
station service status [--instance=<name>] [--home=<dir>] [--base=<dir>] [--port=<n>] [--ui-port=<n>] [--json]
station service stop [--instance=<name>] [--home=<dir>] [--base=<dir>] [--port=<n>] [--ui-port=<n>] [--json]
station service uninstall [--instance=<name>] [--home=<dir>] [--base=<dir>] [--port=<n>] [--ui-port=<n>]
station service run [--instance=<name>] [--home=<dir>] [--base=<dir>] [--port=<n>] [--ui-port=<n>] [--host=<address>] [--features=<flags>] [--allowed-origin=<origin>]...
```

`run` is the foreground supervisor. It runs the server and UI in the current
process and does not return, so it is the process an external supervisor
wraps rather than a command that registers one: the installed systemd unit,
the launchd plist, and this repository's container image all invoke it. Use it
directly when the host has no service manager to register with — a container,
or any Linux without a systemd user session — where `service install` fails by
design (see the backend table below). It is not a replacement for
`station start`, which builds if needed and launches both processes detached;
`run` deliberately stays in the foreground so its supervisor owns the
lifecycle.

The default service uses the selected channel's runtime home and generated
server/UI ports (`~/.station/instances/stable`, `18141`, and `18000` for
Stable), with loopback host `127.0.0.1`. `STATION_HOME`, `--home`, and `--base`
override only that runtime leaf; shared saved-Station metadata remains under
`STATION_ROOT`. `--temp-home` is rejected because a service needs a durable
home. Every backend is per-user and requires no elevation.

`--allowed-origin=<origin>` (repeatable) adds a browser origin the runtime's
pairing gate trusts — required when Station is reached through a reverse
proxy such as `tailscale serve`, where the server itself only sees
`127.0.0.1` and cannot infer its public name. Values must be bare http(s)
origins (`https://host.example.ts.net`); anything else fails closed. The set
persists in the service manifest: a reinstall **without** the flag preserves
the stored origins into the regenerated unit (so proxy pairing no longer
regresses on reinstall), explicit flags replace the set, and
`--clear-allowed-origins` empties it. `service status` prints the stored
origins on an `origins` line.

| Platform | Backend | Starts when | Logs |
| --- | --- | --- | --- |
| macOS | LaunchAgent in `~/Library/LaunchAgents/` | after reboot and login | `<STATION_HOME>/logs/*-service.{out,err}.log` |
| Linux | systemd user unit in `~/.config/systemd/user/` | user-manager startup, including reboot without login | `journalctl --user -u station-<instance>.service` |
| Windows | Task Scheduler task, `ONLOGON`, `LIMITED` | installing user's logon | `<STATION_HOME>\logs\*-service.{out,err}.log` |
| No service manager (container, or Linux without a systemd user session) | none — supervise `station service run` yourself | whenever its supervisor starts it | the supervisor's own stdout/stderr |

`service status` reports the OS unit, lifecycle instance/processes, and both
server/UI identity endpoints. `--json` emits the same data for automation. An
installed but inactive or unreachable service exits non-zero.

`service start` and `service stop` require the private service manifest that
`service install` creates; they never infer a service registration from a
matching name. Both print the post-action status (or its JSON form). On macOS,
start bootstraps an unloaded LaunchAgent then uses `launchctl kickstart -k`;
stop uses `launchctl bootout`, which is required to prevent `KeepAlive` from
immediately relaunching it. Reinstall boundedly waits for the old label to
disappear before bootstrap. On Linux they use `systemctl --user start|stop`.
On Windows Station verifies the scheduled task owner, wrapper command, and
limited run level before start, stop, replacement, or deletion; a conflicting
task fails closed.

On Linux, installation requires a working systemd user manager and verified
linger. Station runs `loginctl enable-linger <uid>` when needed and fails the
install if the command is unavailable, denied by administrator policy, or does
not actually enable linger. Without linger a user service stops at logout and
cannot satisfy Station's reboot-without-login contract. On macOS this is a GUI
LaunchAgent, not a root LaunchDaemon, so the acceptance boundary is “after
reboot + login,” not before login.

Manual reboot checklist:

1. Run `station service install`, then `station service status`.
2. On Linux, run `loginctl show-user "$UID" -p Linger --value`, confirm `yes`,
   log out fully, and verify the service remains active from another login or
   an administrator session. This linger/logout walk is intentionally manual.
3. Reboot. On macOS, log in to the installing account and verify the
   LaunchAgent starts; on Linux, verify the user unit starts before an
   interactive login; on Windows, log in to the installing user and verify the
   limited task starts. These platform reboot walks are intentionally manual.
4. Run `station service status --json`; confirm `installed`, unit `active`,
   and instance `healthy` are true.
5. Inspect the platform log location above if any layer is unhealthy.
6. Run `station service uninstall`; confirm status reports not installed.

### `build`

Build the server and UI for a named instance without stopping or starting it.
This is the staging primitive used by the dogfood reconciler: a candidate can
be fully built while the active release remains healthy.

```
station build [--instance=<name>] [--home=<dir>] [--base=<dir>] [--port=<n>] [--ui-port=<n>]
```

The build records immutable source provenance with the staged output. Use an
external absolute `--base`/`STATION_HOME` for persistent data; build output is
release-specific and must not contain the Station home.

### `start`

Start the application server and UI. Builds automatically on first run if `dist-server/` or `dist-ui/` are missing.

```
station start [--port=<n>] [--ui-port=<n>] [--host=<address>] [--clean] [--force] [--allow-default-home-clean] [--build] [--home=<dir>] [--base=<dir>] [--temp-home] [--instance=<name>] [--features=<flags>] [--log[=<path>]] [--allowed-origin=<origin>]...
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port=<n>` | worktree-derived development port (or explicit release channel port) | API server port |
| `--ui-port=<n>` | worktree-derived development port (or explicit release channel port) | UI static file server port |
| `--host=<address>` | existing lifecycle default | Explicit bind address for all four Station listeners: API, terminal, voice, and UI. Dogfood uses `127.0.0.1`. |
| `--clean` | — | Clean the selected Station home before starting |
| `--force` | — | Skip the confirmation prompt for destructive cleanup |
| `--allow-default-home-clean` | — | Required together with `--force` to delete the selected default runtime home |
| `--build` | — | Force rebuild before starting (even if dist exists) |
| `--home=<dir>` | current `STATION_HOME` or `<STATION_ROOT>/instances/<channel>` | Runtime home for this instance — isolated **and** persistent. It never changes shared profiles; cannot be combined with `--temp-home` or `--base` |
| `--base=<dir>` | current `STATION_HOME` or `<STATION_ROOT>/instances/<channel>` | The same runtime-only setting as `--home` |
| `--temp-home` | — | Create and use a temporary home under the system temp directory |
| `--instance=<name>` | derived from `{cwd, base, ports}` | Stable instance name for targeted stop/restart flows |
| `--features=<flags>` | — | Comma-separated feature flags (e.g. `strands-runtime`) |
| `--log[=<path>]` | `/tmp/station-server.log` | Redirect server stdout/stderr to a log file |

Detached processes are tracked per instance in `.station/instances/<instance-id>.json` (see [Instance State Mechanism](#instance-state-mechanism)). During migration, the prior `.station.pids` state file is still recognized when present.

```bash
station start
station start --instance=smoke-a --temp-home --clean --force --port=3242 --ui-port=5274
station start --home=/tmp/station-a --port=8080 --ui-port=4000
station start --log=/var/log/station.log
```

Routine smoke and agent runs should prefer `--temp-home`; a run that must
survive restarts (verifying restart behaviour, for instance) wants `--home`.
Shared-build actions (`--clean`, `fresh`, `--build`, and self-update) refuse to
run while sibling instances from the same checkout are still live.

**Every start names the home it resolved, and what chose it** (station#4299):

```
  ✓ Home:   ~/.station/instances/stable (default)
  ✓ Home:   /tmp/station-a (--home)
  ✓ Home:   /var/folders/.../station/dev-home-xyz (--temp-home)
```

The parenthesised source is the input that decided the directory — `--home`,
`--base`, `--temp-home`, `STATION_HOME`, or `default` when nothing selected
one and the command is therefore acting on the selected channel's default
runtime home. Getting
isolation wrong does not produce an error or an unusable instance; it produces
a working instance pointed at your own data, so this line is the only place
the mistake is visible.

#### Accessing Station remotely (#198)

The UI server's own origin is a genuine reverse proxy for backend HTTP + SSE
calls (`/api/*` and the bare backend mounts — `/agents`, `/acp`, `/events`,
`/integrations`, `/config`, `/bedrock`, `/monitoring`, `/scheduler`,
`/notifications`, `/tools`, `/observability`), and by default the UI client
talks to **its own origin** (`window.location.origin`) — no configuration is
required to reach Station from:

- `localhost` (the default),
- a LAN or tailnet IP/hostname (e.g. `http://192.168.1.42:3010` or a Tailscale
  MagicDNS name), or
- a single-origin HTTPS reverse proxy that only forwards the UI port.

`STATION_API_BASE` (set before `station start`) is the explicit override: when
set, it is the **only** case where the UI server injects an absolute
`window.__API_BASE__` value into `index.html`, and that override always wins
over the same-origin default. Leave it unset for the common case above.

**Voice and Terminal** connect directly to their own dedicated WS ports
(`GET /api/system/voice-port` and `GET /api/system/terminal-port` return the
real, backend-authoritative port — the UI client queries these rather than
assuming a fixed offset from its own resolved API base), not through the
UI-server's HTTP/SSE reverse proxy. This resolves correctly on `localhost`, a
LAN/tailnet host, and any setup where the dedicated WS port itself is
reachable from the client. It remains a real, pre-existing limitation only
under a single-origin HTTPS reverse proxy that forwards *just* the UI port
and does not also separately expose the dedicated Voice/Terminal ports —
in that specific case, Voice/Terminal will not be reachable.

The **MCP Apps** sandbox proxy uses an ephemeral `127.0.0.1` port by default.
`MCP_UI_FRAME_PORT` pins a nonzero port when a deployment needs a stable value.
The proxy is a different browser origin used only for app isolation; it does
not expose MCP resources, credentials, or tool execution.

Remote reachability does not authorize protected Station APIs. See the
[remote access threat model](../security/remote-access-threat-model.md) for the
exact public/protected surface matrix, Station-owned proxy attestation, and
credential bootstrap procedure.

### `dev`

Launch a bleeding-edge dev instance from any git worktree on a
**deterministic**, stable, non-colliding port pair and an isolated home, so it
coexists with the legacy/ad-hoc dogfood pair (`3141`/`3000`, not a release-channel default) and a shared URL
stays valid across restarts. It does not fork the start logic — it derives the
ports/instance/home, then runs the same path as [`start`](#start).

```
station dev [--port-offset=<n>] [--host=<address>] [--build] [--clean] [--force] [--features=<flags>] [--dry-run]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port-offset=<n>` | derived | Force an exact offset (`0`-`500`), overriding the derivation. `--port-offset=0` is valid and yields the base ports `39140`/`40140` (just below the derived `39141`-`39640` band). |
| `--host=<address>` | `0.0.0.0` | Bind address; the default is a wildcard so a phone or LAN/tailnet client can reach the stable URL |
| `--build` | — | Force a rebuild before starting |
| `--clean` | — | Wipe this dev instance's isolated home before starting (with `--force` to skip the prompt) |
| `--force` | — | Skip the cleanup prompt / force a restart of an already-running dev instance |
| `--allow-shared-home` | — | Start even though another live instance owns this home. Default: refuse — the stores are not multi-writer safe, so concurrent writers silently lose conversation data (station#2904) |
| `--features=<flags>` | — | Comma-separated feature flags |
| `--dry-run` | — | Print the resolved ports/instance/home and exit without starting |

**Ports.** The dev band is `server 39140 + offset` and `ui 40140 + offset`,
with `offset` in `1..500` (server `39141`-`39640`, ui `40141`-`40640`). The band
is deliberately UNCOMMON: well clear of the legacy/ad-hoc `3141`/`3000` dogfood pair and
every common dev port, below the OS ephemeral range (`49152+`), and the
`1000`-wide gap between the two bases (larger than the max offset) guarantees
one worktree's server port can never equal another's ui port.

**Determinism.** The offset is derived so the same worktree always resolves to
the same ports across restarts (precedence, high to low):

1. `--port-offset=<n>` / `STATION_PORT_OFFSET` — an exact numeric offset.
2. `STATION_DEV_INSTANCE` — a numeric seed is that exact offset; a non-numeric
   seed is hashed (FNV-1a) into `1..500`. The seed also names the instance/home.
3. Otherwise the linked-worktree path is hashed into `1..500`.
4. Outside a worktree, offset `0` (base ports), keyed off the cwd basename.

If the derived pair is already busy (a rare hash collision between two
worktrees), the allocator scans forward to the next free pair and reports the
move.

**Isolated home.** Each instance runs against `~/.station/instances/dev/<instance>`,
where `<instance>` is `dev-<worktree-basename>` (or `dev-<STATION_DEV_INSTANCE>`
when the seed is set). The home is EXTERNAL to the worktree, so it survives a
worktree cleanup and a recreated worktree at the same path reuses it.

```bash
station dev                       # deterministic ports from this worktree's path
station dev --dry-run             # inspect the resolved ports/home, start nothing
station dev --port-offset=7       # pin server 39147 / ui 40147
STATION_DEV_INSTANCE=alpha station dev
station stop --instance=dev-<worktree-basename>
```

`station start` resolves its channel ports through the shared runtime context.
The legacy/ad-hoc `3141`/`3000` pair remains user-testing territory; `dev` is a separate opt-in command.

### `environment`

Inspect and maintain Station's stable local identity and connect to saved
Station backends through system OpenSSH. Local identity commands operate on the
selected Station home. SSH commands call the selected local Station API, which
owns the tunnel so it remains available after the CLI command exits.

```text
station environment show
station environment credential show
station environment credential rotate [--force]
station environment reset [--force]
station environment offer [--tailscale] [--tailscale-serve-port=<port>]
station environment access list [--api-base=<loopback-url>|--station=<name>]
station environment access approve [<request-id-or-offer-id>|--latest] [--force] [--api-base=<loopback-url>|--station=<name>]
station environment access deny [<request-id-or-offer-id>|--latest] [--force] [--api-base=<loopback-url>|--station=<name>]
station environment access request --api-base=<host-url> [--station=<name>] [--device-name=<name>] [--timeout=<seconds>] [--force]
station environment hosts [--api-base=<url>]
station environment list [--api-base=<url>]
station environment show <id> [--api-base=<url>]
station environment add --ssh=<host-alias> --project=<remote-path> [--name=<name>] [--remote-port=<n>] [--managed] [--api-base=<url>]
station environment connect <id> [--api-base=<url>]
station environment stop <id> [--api-base=<url>]
station environment remove <id> [--api-base=<url>]
station environment peers list
station environment peers add --environment-id=<id> --api-base=<peer-url> --credential=<token> --scope=<space-delimited-scope> [--label=<name>]
station environment peers remove <environment-id>
```

- `environment show` prints the schema version, stable environment ID, and the
  non-secret marker `"credential":"configured"`.
- `environment credential show` is the only reveal command. It prints the raw
  credential so it can be entered in Station Connect's masked field. Do not
  redirect, log, screenshot, or paste this output into a URL.
- `environment credential rotate` preserves the environment ID, invalidates all
  saved remote credentials immediately, and prints the replacement after
  confirmation.
- `environment reset` rotates both the environment ID and credential. It prints
  only non-secret reset metadata; run the explicit credential show command to
  bootstrap a client afterward.
- `environment offer` discovers the active local Station through its
  owner-validated local service record, verifies the loopback listener's identity and
  proof before sending the operator credential, then creates the existing
  device-pairing offer and prints its expiry, plaintext
  `station-pairing:v1:` payload, and terminal QR. A loopback offer is explicitly
  not reachable from a phone; it does not guess or advertise a LAN address.
  `--tailscale` reads the active machine's MagicDNS name and HTTPS Serve status,
  refuses a foreign or unrecognized HTTPS mapping, and then publishes only
  the already-validated loopback listener origin as `https://<magicdns>`.
  `--tailscale-serve-port` selects a strict port from 1 through 65535 (default
  443) and requires `--tailscale`; the selected port is used for the endpoint,
  mapping, and manual teardown guidance. Offer expiry
  never changes Serve and Station never enables Funnel.
- `environment access request` is the requester side of device pairing: it asks a
  remote Station for access, waits for an operator to approve it there, then
  stores the issued bearer credential in the OS keyring and registers a
  secret-free saved Station (`--station=<name>` chooses the name). Afterwards
  `station chat --station=<name>` authenticates with no further flags.
  `--force` re-pairs an already-paired endpoint instead of reporting it
  already paired.
- `access list`/`approve`/`deny` are the host side and always require a
  loopback target — pass either an explicit loopback `--api-base`, or
  `--station=<name>` for a saved Station whose endpoint is loopback AND that
  records a local home (`localService.baseDir`, set by `station setup
  local`). A Station saved by pairing has no such home for these verbs to
  read its operator credential from and is refused with that reason; use
  `STATION_HOME=<home> --api-base=<loopback-url>` for it instead
  (station#4515). `approve`/`deny` accept either id printed by `access list`
  — the request id or the offer id — or `--latest`.
- `environment peers` manages the **outbound** peer-credential store: the
  credentials this Station presents when it delegates to another Station, as
  opposed to the inbound device credentials `access`/pairing issues. `peers add`
  records a credential for a peer `environmentId`; `peers list` shows what is
  stored (never the secret); `peers remove` drops one. See
  [station-peer-pairing.md](../design/station-peer-pairing.md) §5 — and note
  that doc's supersession header before reading its "current state" section.
- `environment hosts` discovers concrete aliases from the user's OpenSSH
  configuration and reports the effective host facts returned by `ssh -G`.
- `environment add` saves a host alias and requested remote project directory;
  it never copies SSH keys, agent sockets, passwords, or private SSH options.
  `--managed` (station#1133) opts the environment into managed launch: on
  `connect`, if nothing answers on the configured remote port, Station runs a
  POSIX bootstrap over the same SSH connection to reuse a previously managed
  Station, attach to an already-running unmanaged one, or start one detached
  from the remote checkout. The default (`attach`, omit `--managed`) is
  unchanged — connect only ever probes an already-running remote Station.
- `environment connect` starts a loopback-only forward, verifies a small remote
  Station worker, and binds the saved Station to the effective host, canonical
  project path, and remote Station identity. Later mismatches fail closed.
  For a managed environment, `connect` never stops a Station it starts or
  finds already running; only an explicit stop action would (not yet
  implemented — see the SSH launch bootstrap design notes).
- `environment stop` closes the Station-owned tunnel without forgetting the
  saved Station. `environment remove` closes it and forgets the saved Station.
- Chat and delegation target a saved Environment with `--on=<environment>`.
  Continuation stays on `station chat --session=<id>` or
  `station delegate --session=<id>`; environment management never executes an Agent.

Examples:

```bash
station environment hosts
station environment add --ssh=media-host --project='~/dev/my-project' --name='Media Host'
station environment list
station environment connect <id>
station chat codex --on=<id> --session=issue-434 'Continue the implementation'
station environment stop <id>
```

SSH host-key confirmation, passwords, passphrases, and security-key prompts are
handled by the user's OpenSSH configuration and agent. Station does not store
them. The remote host needs Node.js 24 or newer and a running Station backend
on the explicitly configured or channel-resolved port.

Rotation and reset require interactive confirmation, or `--force` when stdin
is non-interactive. Before either operation, retain local shell access. After
rotation, update and test at least one client before ending maintenance. After
reset, reconcile the public handshake and treat the Station as a new saved
environment. Rotation invalidates every credential paired through
`environment access request`, so re-pair each device afterwards.

### `stop`

Stop the matching Station instance.

```
station stop [--instance=<name>] [--home=<dir>] [--base=<dir>] [--port=<n>] [--ui-port=<n>]
```

If multiple instances are live from the same checkout, bare `station stop` refuses and tells you how to disambiguate.

```bash
station stop
station stop --instance=smoke-a
station stop --home=/tmp/station-a
```

### `upgrade`

In a source checkout, pull the latest code, reinstall dependencies, and rebuild.
In a signed portable install, reuse the persisted release ring and delegate to
the installer without a Git checkout or pre-stop action. Installed plugins are preserved.

```
station upgrade
```

```bash
station upgrade
# then: station start
```

### `fresh`

Clean the selected Station home without starting the app.

```
station fresh [--force] [--allow-default-home-clean] [--home=<dir>] [--base=<dir>] [--temp-home] [--instance=<name>] [--port=<n>] [--ui-port=<n>]
```

| Flag | Description |
|------|-------------|
| `--force` | Skip the confirmation prompt |
| `--allow-default-home-clean` | Required together with `--force` to delete the selected channel's default runtime home; it never authorizes deleting `STATION_ROOT` |
| `--home=<dir>` | Clean a specific home directory |
| `--base=<dir>` | The same setting as `--home`, under the name it shipped with |
| `--temp-home` | Create and clean a temporary home under the system temp directory |
| `--instance=<name>` / `--port=<n>` / `--ui-port=<n>` | Match the instance identity used for shared-build safety checks |

```bash
station fresh --temp-home --force
station fresh --home=/tmp/station-a --force
station fresh --force --allow-default-home-clean
```

### `home verify`

Run an integrity check over the SQLite stores this home owns
(`data/orchestration.sqlite` and `scheduler/scheduler.sqlite`) and report each
one. The stores are opened read-only, so this is safe to run while Station is
up -- it is the only `home` action that does not require the home to be idle.

```
station home verify [--home=<dir>] [--base=<dir>] [--instance=<name>] [--port=<n>] [--ui-port=<n>] [--json]
```

| Exit | Meaning |
| --- | --- |
| `0` | Every store checked came back healthy |
| `1` | A store is corrupt -- the bytes are bad |
| `2` | A store could not be read (locked, unreadable, not a file). This is a statement about the check, not about the data |
| `3` | Nothing was verified -- the home path does not exist, or no store in it exists yet. Check the path |

A store this home has never created reports `absent` and does not affect the
exit code, as long as something else was verified: a home that has never
scheduled anything has no scheduler ledger, and that is not a finding. If
*every* store is absent the command exits `3`, because a report with no
findings in it is not a report of no problems.

`ok` means the b-tree structure was intact when it was checked. It does not
mean no data was lost -- a truncated write-ahead log leaves a perfectly
consistent database with less in it.

The runtime runs the same check on a schedule against the **orchestration
store only** -- the store the removed per-boot check covered -- and records a
corruption marker beside it when it finds damage. The scheduler ledger above
is covered by this command, not by that schedule.

### `home backup`

Create an offline, content-hashed backup of one Station home. Every Station
using that home must be stopped. SQLite stores are checkpointed and integrity
checked before copy; symlinks, corrupt databases, active instances, and
configured size/count limits fail closed. Volatile logs, monitoring output,
service state, temporary files, and live instance records are excluded.

```
station home backup [--output=<directory>] [--home=<dir>] [--base=<dir>] [--json]
```

If `--output` is omitted, Station creates a timestamped sibling of the home.
The destination must not already exist or be inside the home.

### `home restore`

Validate every manifest entry and content hash, then atomically restore a
Station home while retaining the replaced home as a timestamped sibling.
Restore never runs while a matching Station instance is live.

```
station home restore --from=<backup-directory> --confirm [--home=<dir>] [--base=<dir>] [--json]
```

| Flag | Description |
|------|-------------|
| `--from=<directory>` | Required validated Station-home backup |
| `--confirm` | Required before replacing the selected home |
| `--home=<dir>` | Target a specific home directory (`--base=<dir>` is the same setting under its original name) |
| `--json` | Print the validated restore receipt as JSON |

### `home reset`

Archive (never delete) an incompatible Station home so a fresh one is
scaffolded on next start. The command the `STATION_HOME_RESET_REQUIRED`
error names (station#1913) -- the supported bridge for a home an older
Station release wrote before the current schema marker existed.

```
station home reset --confirm [--if-incompatible] [--home=<dir>] [--base=<dir>] [--instance=<name>] [--port=<n>] [--ui-port=<n>] [--json]
```

| Flag | Description |
|------|-------------|
| `--confirm` | Required to actually archive the home (data is kept, never deleted). Not required on an `--if-incompatible` run where the home already satisfies the schema gate -- that path returns a no-op before the confirmation check |
| `--if-incompatible` | No-op instead of archiving when the home already satisfies the current schema gate |
| `--home=<dir>` | Target a specific home directory (`--base=<dir>` is the same setting under its original name) |
| `--instance=<name>` / `--port=<n>` / `--ui-port=<n>` | Match the instance identity used for the running-instance refusal |
| `--json` | Print the result (`{"archived":..., "archivePath"?:..., "projectHome":...}`) as JSON |

Refuses while a Station instance for the target home is running, naming it;
stop it first with `station stop`.

```bash
station home reset --confirm --home=/tmp/station-a
station home reset --confirm --if-incompatible --base="$HOME/.station/instances/stable"
```

### `checkpoints`

Local diagnostics for workspace checkpoints (station#2802). Checkpoint
commits are pinned inside a project's own `.git` object database by their
reflogs, and `git gc` deliberately cannot reclaim them for
`gc.reflogExpire` days (default 90) — without this command a `.git` grown
to gigabytes has no discoverable cause (`git fsck`/`git count-objects` name
no culprit) and no supported remedy.

`status`, `prune`, `history`, and `retention` read the **local** Station
home's own index/audit files and shell out to `git` directly — no running
Station required, and they act on the machine the command runs on, not
necessarily wherever `--api-base` points. `restore` is the one subcommand
that calls a running Station instead.

```
station checkpoints [status] [--json]
station checkpoints prune (--thread=<threadId> | --all) [--gc] [--json]
station checkpoints history --thread=<threadId> [--json]
station checkpoints retention --thread=<threadId> [--json]
station checkpoints restore --thread=<threadId> --turn=<turnId> [--phase=baseline|settle] --confirm [--api-base=<url>] [--json]
```

| Action | Description |
|--------|-------------|
| `status` (default) | Reports per-thread disk usage across every project the Station home has checkpointed: indexed turns, checkpoint refs and reclaimable bytes per repository, and a total. Reads the discovery index only — a thread with no repos listed still exists in the index, and this is not a statement that its refs are gone. |
| `prune` | Removes a thread's checkpoint refs and reflogs (and the index/archive records naming it). Requires `--thread=<id>` or `--all`. `--gc` additionally runs `git gc --prune=now --quiet` in each affected repo so the space is actually freed, not just eligible for the next `gc.reflogExpire` window. |
| `history` | Lists recorded checkpoint-restore events for one thread from `checkpoint-restores.json`. |
| `retention` | Lists recorded checkpoint-retention sweep events for one thread from `checkpoint-retention.json`. |
| `restore` | Destructive — requires `--confirm`. POSTs to `/api/orchestration/sessions/:threadId/checkpoints/:turnId/restore` on a **running** Station (`--api-base`, defaulting through the selected channel runtime resolver) to restore a session to an earlier turn's `baseline` (pre-turn) or `settle` (post-turn, the default) checkpoint. |

`--json` on every action prints one JSON document instead of the
human-readable form.

```bash
station checkpoints
station checkpoints prune --thread=abc123 --gc
station checkpoints prune --all --gc
station checkpoints restore --thread=abc123 --turn=turn-7 --confirm
```

Checkpoint capture itself only runs when the `workspaceCheckpoints` setting
is on (off by default) — `status` reporting no threads does not mean the
feature is broken, it means nothing has been captured.

### `doctor`

Check that all required prerequisites are installed: Node.js, npm, git, and
tsx. Doctor also compares every exact-pinned `@kontourai/*` dependency in the
Station manifest with its installed package version. A mismatch or missing
installation is a fail-level check with an `npm install` repair suggestion.
Optional tools and whether chat and External-agent paths are ready are checked
separately.

The `Terminal PTY (node-pty)` check reports whether the `node-pty` native
module loads from the checkout. When it does not — typically a Linux host that
installed without a C++ toolchain — the check is a **warn**, not a fail:
Station runs, but interactive terminal panes are unavailable until the module
builds. The line carries the load failure's cause, and the fix-commands
section suggests `npm run dependencies:install` (which needs `g++`, `make`,
and `python3`); restart Station afterwards. That command is the reviewed
lifecycle runner — it re-runs the approved build through preflight, path
confinement, and Station's own artifact verification. Do not substitute
`npm rebuild node-pty`: it executes the package's lifecycle scripts directly,
skipping every one of those checks. Agent execution does not use
`node-pty` and is unaffected either way.

```
station doctor [--json]
```

```bash
station doctor
station doctor --json > station-doctor.json
```

`--json` writes exactly one JSON document to stdout and applies Station's
diagnostic secret redaction to every string in the report. It uses the same
readiness rules and exit status as the human-readable form: exit `1` when a
required check fails or either chat/runtime readiness is false; otherwise exit
`0`.

The JSON document has this top-level schema:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-20T12:34:56.000Z",
  "report": {
    "checks": [
      {
        "label": "Node.js",
        "status": "pass",
        "detail": "v24.4.0"
      }
    ],
    "recommendation": "...",
    "chatReady": true,
    "runtimeReady": true,
    "providerState": {
      "configured": ["ollama-local (ollama)"],
      "detected": ["ollama"],
      "effective": "ollama-local (ollama)"
    },
    "runtimeState": {
      "configured": ["codex-local"],
      "detected": ["codex-cli"],
      "effective": "codex-local"
    },
    "dependencyState": {
      "exactPins": [
        {
          "name": "@kontourai/flow-agents",
          "pinned": "5.2.0",
          "installed": "5.2.0"
        }
      ],
      "mismatches": []
    },
    "fixCommands": [
      {
        "label": "Install project dependencies",
        "command": "npm install",
        "reason": "tsx is provided by the project dependency set."
      }
    ]
  },
  "exitReady": {
    "chatReady": true,
    "runtimeReady": true
  }
}
```

The nested shapes mirror the CLI contract exactly:

```ts
type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  label: string;
  status: DoctorCheckStatus;
  detail: string;
}

interface DoctorFixCommand {
  label: string;
  command: string;
  reason: string;
}

interface DoctorState {
  configured: string[];
  detected: string[];
  effective: string | null;
}

interface KontourDependencyVersion {
  name: string;
  pinned: string;
  installed: string | null;
}

interface DoctorReport {
  checks: DoctorCheck[];
  recommendation: string;
  chatReady: boolean;
  runtimeReady: boolean;
  providerState: DoctorState;
  runtimeState: DoctorState;
  dependencyState: {
    exactPins: KontourDependencyVersion[];
    mismatches: KontourDependencyVersion[];
  };
  fixCommands: DoctorFixCommand[];
}

interface DoctorJsonDocument {
  schemaVersion: 1;
  generatedAt: string;
  report: DoctorReport;
  exitReady: {
    chatReady: boolean;
    runtimeReady: boolean;
  };
}
```

Within a `schemaVersion`, fields are additive-only: consumers must tolerate
new keys. Removing or changing the meaning or type of an existing field is a
breaking change and requires incrementing `schemaVersion`.

The Settings **Download diagnostics bundle** action calls
`GET /api/diagnostics/bundle`. Its versioned payload includes this doctor
report plus app version/platform data, any independently available build
provenance (`fullSha`, `shortSha`, `branch`, `builtAt`, `ageSeconds`,
`instanceId`, `bootId`, `channel`, and `dirty`), redacted app configuration,
and up to 256 KiB from the end of the current server log. Build provenance is
additive within schema version 1 and omitted only when none is available.
When logging is not enabled,
the payload explicitly contains:

```json
{
  "logs": null,
  "logsUnavailableReason": "no log file configured (start with --log or service mode)"
}
```

Start Station with `--log` (optionally `--log=<path>`) to include recent server
logs in the bundle. Log text and JSON-encoded configuration values pass through
the same diagnostic redaction boundary.

### `link`

Create a symlink at `${STATION_BIN_DIR:-~/.local/bin}/station` pointing to the `./station` script in the current directory. Does not use `sudo` — `~/.local/bin` (or `STATION_BIN_DIR`) is user-writable. Warns if that directory isn't on `PATH` yet.

```
station link
```

```bash
station link
# Invoking the symlinked `station` command from any directory works: the
# launcher resolves `$0` through the symlink chain to the real repo-rooted
# script before locating node_modules/scripts, and it also records the
# directory you invoked it from so `plugin create`/`plugin build`/`plugin dev`
# operate on your current directory rather than the Station repo.
station --help
```

### `--link` (launcher flag)

Not to be confused with `station link` above. `./station --link` is a flag on
the repo-root launcher script, handled before any Station command runs: it
registers this checkout's `@kontourai/station-sdk` and `@kontourai/station-cli`
as global npm links so a plugin repo elsewhere on the machine can develop
against your working tree.

```bash
./station --link
```

Then, in the plugin repo:

```bash
npm link @kontourai/station-sdk @kontourai/station-cli
npx station plugin dev
```

Both packages must be linked into the plugin repo. `npm link` here points the
plugin repo at *this checkout's* build — including uncommitted changes —
rather than a published channel tag, which is the point when developing
against a Station working tree: `npx @kontourai/station-cli@<channel> dev`
would resolve, but only to a released version, never to local changes.

| | `station link` | `./station --link` |
|---|---|---|
| What it is | A Station command | A launcher-script flag |
| What it does | Symlinks the launcher into `~/.local/bin` so `station` is on your `PATH` | `npm link`s the SDK + CLI packages for plugin development |
| Who it is for | Anyone using Station | Plugin developers working against a local checkout |

### `shortcut`

Create a macOS `.app` bundle at `~/Applications/Station.app`. Double-clicking it runs `station start` and opens the UI port from the selected runtime context (Stable defaults to `http://localhost:18000`).

```
station shortcut
```

```bash
station shortcut
```

### `registry`

Unified catalog and plugin registry behavior for the Registry surface:

```bash
station registry
station registry <url>
station registry install <plugin-id>

station registry agents list [--api-base=<url>]
station registry agents installed [--api-base=<url>]
station registry agents install <id> [--api-base=<url>]
station registry agents uninstall <id> [--api-base=<url>]

station registry skills list [--api-base=<url>]
station registry skills installed [--api-base=<url>]
station registry skills install <id> [--api-base=<url>]
station registry skills uninstall <id> [--api-base=<url>]

station registry integrations list [--api-base=<url>]
station registry integrations installed [--api-base=<url>]
station registry integrations install <id> [--api-base=<url>]
station registry integrations uninstall <id> [--api-base=<url>]

station registry plugins list [--api-base=<url>]
station registry plugins installed [--api-base=<url>]
station registry plugins install <id> [--api-base=<url>]
station registry plugins uninstall <id> [--api-base=<url>]
```

Without a URL argument, fetches and displays the registry. The URL is read from
`<STATION_HOME>/config/app.json` (`registryUrl` field). A legacy
`<STATION_HOME>/config.json` value is read only to migrate it into the owned
file.

With a URL argument, saves it to `<STATION_HOME>/config/app.json` and exits.

```bash
# Set registry URL
station registry https://registry.example.com/plugins.json

# Use the checked-in local fixture
station registry ./examples/registry/manifest.json

# Browse registry
station registry

# Install from the configured registry
station registry install demo-layout
```

`examples/registry/manifest.json` is the reproducible local fixture used by
`npm run proof:registry-manifest`. It is not a hosted registry proof by itself:
Phase 2 was closed on local-fixture scope, while any hosted registry remains
separate publication/distribution work requiring its own stable-URL evidence.

---

## Plugin

### `plugin install <source>`

Install a plugin from a git URL or local path through the configured, running Station server. The server owns the filesystem transaction, registry identities, runtime activation, and rollback. A local path is resolved from the directory where the CLI was invoked and therefore applies only when the CLI and Station server share that filesystem; use a git URL for a remote Station.

Dependencies declared in `plugin.json` are resolved and installed automatically.

```
station plugin install <source> [--skip=<components>]
```

| Argument/Flag | Description |
|---------------|-------------|
| `<source>` | Git URL (https or ssh) or local path. Append `#<branch>` to target a specific branch. |
| `--skip=<components>` | Comma-separated list of components to skip, e.g. `agent:myplugin:chat,layout:main` |

```bash
station plugin install https://github.com/org/my-plugin.git
station plugin install https://github.com/org/my-plugin.git#develop
station plugin install git@github.com:org/my-plugin.git
station plugin install ./path/to/local-plugin
station plugin install https://github.com/org/plugin.git --skip=agent:plugin:chat
```

### `plugin preview <source>`

Validate a plugin and display its contents without installing it. Shows components, permissions, dependencies, and any conflicts with already-installed plugins.

```
station plugin preview <source>
```

```bash
station plugin preview https://github.com/org/my-plugin.git
station plugin preview ./path/to/local-plugin
```

Output includes suggested `--skip` flags if conflicts are detected.

### `plugin list`

List all installed plugins with their agents, layouts, providers, and dependencies.
The CLI, SDK hook, and station-control MCP tool share the canonical authenticated
`GET /api/plugins` collection operation; no trailing-slash compatibility route
is required.

```
station plugin list
```

```bash
station plugin list
```

### `plugin remove <name>`

Remove an installed plugin by its manifest name. Also removes its registered agents and layout.

```
station plugin remove <name>
```

```bash
station plugin remove my-plugin
```

### `plugin info <name>`

Show details for an installed plugin: version, agents, and layout.

```
station plugin info <name>
```

```bash
station plugin info my-plugin
```

### `plugin update <name>`

Update an installed plugin through the running Station server. The server resolves its source, rebuilds it, and applies registry and runtime changes as one lifecycle operation.

```
station plugin update <name>
```

```bash
station plugin update my-plugin
```

### `plugin init [name]`

Scaffold a new plugin project in the current directory (or a named subdirectory).

```
station plugin init [name]
```

```bash
station plugin init
station plugin init my-plugin
```

`init` scaffolds a new plugin (full template).

### `plugin create [name]`

Scaffold a new plugin project using a specific template.

```
station plugin create [name] [--template=<full|layout|provider>]
```

| Template | Description |
|----------|-------------|
| `full` | Layout + agent + build config starter |
| `layout` | UI-focused starter with layout manifest and entrypoint |
| `provider` | Server-side starter with `serverModule`, provider files, and request hooks |

```bash
station plugin create my-plugin --template=full
station plugin create my-layout --template=layout
station plugin create my-provider --template=provider
```

### `plugin build`

Build the plugin bundle in the current directory. Outputs to `dist/`.

```
station plugin build
```

```bash
station plugin build
```

### `plugin dev [port]`

Start a local development server for the plugin in the current directory. Builds the plugin in dev mode, watches `src/` for changes and hot-reloads, and connects to MCP tool servers if configured.

The server listens only on `127.0.0.1`; direct `--host` and non-loopback binding are intentionally unavailable. For a plugin running on a remote development host, preserve the loopback boundary with `ssh -N -L 4300:127.0.0.1:4300 user@dev-host`, run `station plugin dev 4300` remotely, then open `http://127.0.0.1:4300` locally.

```
station plugin dev [--port=<n>] [port] [--no-mcp] [--mcp] [--tools-dir=<path>]
```

| Argument/Flag | Default | Description |
|---------------|---------|-------------|
| `--port=<n>` | `4200` | Port for the dev server — the same flag shape every other Station command uses |
| `[port]` | `4200` | Bare positional port. Still supported; `--port=` is preferred. Naming the port twice is an error |
| `--no-mcp` | — | Disable MCP tool server connections |
| `--mcp` | — | Explicitly enable MCP (default when agents are present) |
| `--tools-dir=<path>` | `./tools` | Directory containing tool config files |

The dev server exposes:
- `GET /` — plugin UI preview
- `GET /agents/:slug/tools` — list available tools
- `POST /agents/:slug/tools/:toolName` — call a tool via MCP
- `POST /api/plugins/fetch` — public HTTP(S)-only development fetch proxy
- `GET /api/reload` — SSE endpoint for hot reload

```bash
station plugin dev
station plugin dev --port=3333
station plugin dev 3333                 # positional form, still supported
station plugin dev --no-mcp
station plugin dev --port=3333 --tools-dir=./my-tools
```

The file, MCP, fetch, and reload routes require the exact live loopback Host and same-origin browser boundary. The fetch proxy validates every DNS answer and redirect, strips cookies, authorization, proxy, and hop-by-hop headers, forces `Accept-Encoding: identity` (encoded upstream responses are rejected), and does not permit private, loopback, link-local, or metadata destinations. JSON requests are limited to 1 MiB; identity fetch responses to 10 MiB; each fetch hop (DNS through response) to 10 seconds and five redirects; reload streams to 32 clients.

---

## Independent review evidence

### `review`

Run an exact initial or delta review from the same canonical request used by the API, SDK, Review Queue, and station-control MCP:

```bash
station review run <project-slug> --file=review-request.json
station review run <project-slug> --data='{...}'
station review status <project-slug> <request-id>
station review list <project-slug>
station review read <project-slug> <receipt-id>
```

`review run` requires a caller-generated `requestId` and implementing Agent slug. Explicit mode carries distinct reviewer Agent slugs; Repo Map mode carries `"reviewers":[]` plus `"selection":{"kind":"repo-map"}` and Station resolves trusted policy, eligible read-only reviewers, and pins the exact resolved Git SHAs. Unavailable routing or reviewers becomes durable `not-verified` with a server-owned reason; no reviewer is invoked and no clean receipt is fabricated. Station resolves actor identities; clients cannot declare attribution. Each HTTP operation retains the ordinary 30-second transport bound. The SDK safely recovers ambiguous submission by request ID, polls durable status, and prints the attributable completed result; `review status` performs the same exact recovery directly. Findings are evidence input only and do not approve, reject, satisfy a gate, or replace the completion gate. The station-control MCP exposes the same shared operations as `run_independent_review`, `get_review_request`, `list_review_receipts`, and `get_review_receipt`.

## Instance State Mechanism

When `station start` launches the server and UI processes, it writes per-instance state to `.station/instances/<instance-id>.json` in the current working directory. Each record includes the instance id, home directory, ports, and current server/UI PIDs.

`station stop` resolves the matching instance from `--instance`, `--home`/`--base`, `--port`, or `--ui-port`, then terminates only that instance. If multiple instances are live and the selector is ambiguous, the CLI refuses and prints the matching records so you can choose the intended one.

During rollout, Station still recognizes the prior `<cwd>/.station.pids` file when present and migrates away from it as new-format state is written.

The CLI requires `.station/instances` to be an owned, non-symlinked directory with mode `0700`; if it isn't (e.g. a checkout that predates this check, or a directory created with a looser umask), `station start`/`station build` fails with `Unsafe Station instance-state directory (expected owned mode 0700): <path>`. Fix it with:

```bash
chmod 700 .station/instances
```

**Not the same thing as `<STATION_HOME>/instances.json`.** That is a
separate, home-scoped (not CWD-scoped) cross-process instance registry
(station#1985) — see [`docs/design/instance-registry.md`](../design/instance-registry.md)
for the schema and the reasoning for keeping the two mechanisms distinct. As of
station#1983/#1672, `station service install` is the registry's first producer:
it writes `<STATION_HOME>/instances.json` as the durable authority for a user
service's operator env (including `ALLOWED_ORIGINS`) and migrates the origins
recorded in the pre-registry `<home>/service/*.json` manifest on first install.

---

## Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `PORT` | `start` | Overridden by `--port=<n>`. Sets the API server listen port. |
| `STATION_ROOT` | shared app data | App-owned root for saved-Station metadata, cache, channel installs, and runtime containers. Defaults to `~/.station`; never a runtime cleanup target. |
| `STATION_HOME` | lifecycle + server runtime | One runtime home. Defaults to `<STATION_ROOT>/instances/<channel>`. Lifecycle commands also accept `--home=<dir>` (which wins over this variable), its original name `--base=<dir>`, and `--temp-home`. |
| `STATION_INSTANCE_ID` | server runtime | Stable instance identity injected by the CLI for targeted restart/update flows. |
| `STATION_INSTANCE_STATE_PATH` | server runtime | Path to the per-instance state record that restart/update rewrites in place. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | server runtime | OpenTelemetry collector endpoint for tracing/metrics export. |
| `VITE_API_BASE` | UI build | Base URL for API calls from the UI. Set at build time. |
| `STATION_TARGET` | commands that talk to a Station | Saved Station override when no `--api-base` or `--station` is passed. See [choosing a target](#choosing-which-station-a-command-talks-to). |
| `STATION_API_BASE` | lifecycle/server bootstrap | Explicit UI/API base injected by `station start`; it is not a saved Station selector. |
| `STATION_API_CREDENTIAL` | commands that talk to a Station | Bearer credential, equivalent to `--credential=<token>`. |
| `STATION_PORT` | loopback override | Overrides the selected channel runtime context's server port for the loopback default target. |
| `STATION_REQUEST_TIMEOUT_MS` | commands that talk to a Station | Request deadline in milliseconds (default `30000`). `0` disables it. See [request deadlines](#request-deadlines-and-unreachable-stations). |

Environment variables are station-only (`STATION_*`). Shared app data resolves
from `STATION_ROOT` → `~/.station`; runtime state resolves independently from
`STATION_HOME` → `<STATION_ROOT>/instances/<channel>`. The source launcher is
`./station`.


### `cloud` — cloud move preparation

`station cloud` currently offers read-only preparation, not a live move.
Preview supports `aws-ec2` and `gcp-compute`; template generation is AWS-only:

```sh
station cloud preview --home=/absolute/path/to/station-home --provider=aws-ec2 --region=us-east-1 --instance-type=t3.micro --json
station cloud preview --home=/absolute/path/to/station-home --provider=gcp-compute --region=us-central1 --instance-type=e2-micro --json
station cloud verify-target --station=cloud-dev --json
station cloud template --provider=aws-ec2 --region=us-east-1 --instance-type=t3.micro --image=REGISTRY/IMAGE@sha256:DIGEST --output=station-cloud.json
```

`verify-target` requires exactly one explicitly enrolled `--station` or
`--api-base` target. Complete owner-approved Station pairing first. It uses
that connection's bearer credential and observes environment discovery between
two matching boot-identity reads. Redirects, missing or wrong-origin
credentials, malformed identities, responses over 4 KiB, and a boot change
fail verification. The entire observation has a 15-second deadline.

JSON output contains the target origin, environment ID, instance ID, boot ID,
build SHA and observation time. It contains no credential and grants no
execution authority. A saved observation cannot authorize activation: verify
the target again when the future transfer coordinator reaches that boundary.
The command does not provision, transfer files, or continue agents.


Replace the image placeholder with a verified, publicly readable Linux/x86 image
and its 64-character SHA-256 digest. The template command refuses existing output
files. Use `./station` when running from a source checkout. Neither command
creates AWS resources, exports credential stores, copies workspaces, stops a local
instance, or resumes an agent. Unknown actions/options and unsupported target
profiles fail rather than triggering implicit provisioning.

The preview requires an explicit existing home with the current schema. It lists
selected Agent/Project metadata, leaves plugin inventory unverified pending its
lifecycle owner, and reports required
credential enrollment and ownership checks, and omits configuration contents and
secret payloads from its output. Selected configuration bytes may themselves contain
sensitive fields; dedicated credential stores are not accessed. Corrupt, linked, oversized, or incompatible
selected configuration fails the preview. This is not an atomic backup, a complete
compatibility scan, or a credential portability guarantee. Exit zero means a
preview/template was produced; inspect `transferAvailable` and
`executionResumeAvailable`, which are currently false.

The AWS template requires VPC/subnet inputs at deployment and IAM creation
acknowledgement. Deploy in the selected region only after reviewing the resources
and budget. It has no inbound security-group rules, uses SSM access and an
encrypted retained EBS root/data volume, and requires a later application-health
check. Retention does not imply automatic recovery on a replacement instance.
The [cloud-move design](../design/cloud-move.md) records provider boundaries,
credential handling, execution ownership, and the remaining implementation.


### Encrypted workspace copies

```bash
station cloud keygen --output=/private/keys/workspace.key
station cloud pack-workspace --workspace=/work/project --key-file=/private/keys/workspace.key --output=/private/exports/workspace.enc --source-paused --json
station cloud inspect-workspace --archive=/private/exports/workspace.enc --key-file=/private/keys/workspace.key --json
station cloud unpack-workspace --archive=/private/exports/workspace.enc --key-file=/private/keys/workspace.key --destination=/work/imported --json
```

These provider-independent commands require no `--home` or provider flags.
Package operations emit JSON receipts; key generation emits a confirmation without
printing the key. `--source-paused` is required and is the operator's assertion,
not an automatic process stop. All output paths must be new. Import creates the
checkout at `<destination>/workspace`. See [Workspace packages](../guides/workspace-packages.md)
for prerequisites, encryption/key handling, exact preserved content, resource
limits, and recovery. They copy workspace data, not credentials or running agents.


### Import and register a target Project

```bash
station cloud import-project --archive=/private/import/workspace.enc --key-file=/private/keys/workspace.key --destination=/work/imported --target-workspace=/work/imported/workspace --name="Imported project" --slug=imported-project --station=cloud-dev
```

Requires an explicit already enrolled `--station` or authenticated `--api-base`,
a fresh import destination, a target-visible absolute workspace path, and an
unused lowercase hyphenated slug. It imports locally, creates a fresh target
Project through the existing API, and reads back its identity. Failed or uncertain
registration retains the checkout and durable request for explicit reconciliation.
See [combined import and registration](../guides/workspace-packages.md#import-and-register-in-one-command)
for the exact lifecycle and limits. This does not upload files, enroll credentials,
verify the target filesystem, or transfer execution authority.


### Verify a restored workspace

```bash
station cloud verify-workspace --archive=/private/import/workspace.enc --key-file=/private/keys/workspace.key --workspace=/work/imported/workspace --workspace-paused --json
```

Compares the paused local checkout with the authenticated package and emits a
receipt bound to the package SHA-256. It checks HEAD/branch, staged state, content
policy and working files through the existing bounded codecs. Physical executable
bits are checked on POSIX and explicitly unavailable on Windows. It does not
repair files or transfer authority. See [restored-checkout verification](../guides/workspace-packages.md#verify-the-restored-checkout)
for scratch storage, exclusions and non-atomic capture limits. `import-project`
performs this local check before sending Project creation, and retains the import
without attempting creation when verification fails.
