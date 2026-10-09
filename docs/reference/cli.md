# CLI Reference

The Station CLI controls running Stations and supports selected local and
checkout operations. Availability depends on how it was launched.

## Invocation

There are three entry points, and they are not the same program surface.

Examples use `station` as the command name. Use `./station` in a checkout or
the full `npx @kontourai/station-cli@<version-or-published-tag>` prefix when
you have not installed a global command. The package does not add itself to
your PATH merely because an earlier `npx` command ran.

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

The Client tier and selected host-local operations are available in the packaged CLI. Local approval reads an existing owner-only Station home and verifies the loopback listener before sending authorization; it never initializes a missing home. Source-building operations remain repository-only.

### The contributor entry point: `./station`

From the repo root, use the `./station` shell script:

```bash
./station <command> [args]
```

If `node_modules` is missing, `./station` runs `npm run dependencies:ci` using
the pinned package manager, then installs the repo-local Playwright browser
bundle. It executes `scripts/station-cli.ts` through `tsx`; that wrapper loads
the CLI sources and supplies source-only server capabilities. Selected local
operations also work in the packaged client, as listed below.

`./station` admits the checkout command surface, subject to each command's
platform, configuration, and authorization requirements. This is also the
*local invocation way* when the registry isn't the point — developing the CLI
itself, or deliberately not depending on a published channel tag.

### The global dev shim: `station-dev`

A `npm run station-dev:install` script (see `scripts/station-dev.mjs`) copies a
small, dependency-free launcher onto `PATH`. Unlike `npm link`, it is not a
fixed pointer into one checkout: every invocation walks up from the current
working directory to find the enclosing Station checkout and runs *that
tree's* built bundle (`packages/cli/dist/station.mjs`, the same artifact `npx`
runs), so it behaves correctly across many worktrees on the same machine. It
refuses a missing bundle or one older than the source timestamps it inspects,
naming `npm run build:cli` as the remedy. This is an approximate mtime check,
not the content-based dist-freshness gate; preserved or skewed timestamps can
miss drift. Outside a checkout it names the `npx` form instead.

```bash
npm run station-dev:install   # once, from any Station checkout
cd ~/dev/some-other-station-worktree
station-dev agents list       # runs THAT worktree's build, not the one installed from
```

Because it runs the *bundle*, not `scripts/station-cli.ts`, `station-dev`
follows the bundle's Client and selected host-local support below. Building,
installing a backend, and other checkout-only operations still need `./station`.

### The published entry point: the bundled `station` binary

`packages/cli` builds to a single executable ESM file, `packages/cli/dist/station.mjs`, which is what the package's `bin` points at — this is what `npx`/`npm install -g` and `station-dev` all ultimately run:

```bash
npm run build:cli          # from the repo root
node packages/cli/dist/station.mjs --help
```

The bundle inlines the Station workspace packages, so it needs neither `tsx`
nor a checkout at runtime. The package declares `@napi-rs/keyring` and `qrcode`
dependencies. `esbuild` is an optional peer loaded for plugin-authoring builds;
client-only use does not require it. See the [package manifest](../../packages/cli/package.json)
and [bundle externals](../../packages/cli/bundle-externals.mjs).

The `prepack` hook builds the bundle, but this checkout's `ignore-scripts=true`
suppresses lifecycle scripts. Build explicitly with `npm run build:cli` before
packing here. The publication workflow builds explicitly too; neither an
existing `dist/` directory nor a successful package command proves freshness.

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

It accepts only regular fragment files below `--fragments-dir`. Keep that
directory separate from the publishable `--assets-dir`, as the workflow does;
source and predicate are fixed to npm/runtime,
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

Current command availability, with background in the [CLI product design](../design/cli-product.md):

| Tier | Verbs | Bundled `station` | `./station` |
|------|-------|-------------------|-------------|
| Client | `chat`, `agents`, `sessions`, `approvals`, `operate`, `projects`, `tasks`, `skills`, every surface verb, `registry`, `stations`, `target`, `triage`, `setup existing`/`hosted`, `config`, `checkpoints`, `export`/`import`, `plugin`, `environment access request` | yes | yes |
| Host-local | `open`, `doctor`, `environment show`, `environment credential show`, `environment offer`, `environment access list`/`approve`/`deny`, `environment operator passkeys`, `service status`/`start`/`stop` | yes, existing local installation required for local authority | yes |
| Host mutation | `environment credential rotate`, `environment reset`, `environment peers`, service install/uninstall | repository launcher required | yes |
| Contributor | `build`, `dev`, `fresh`, `home`, `link`, `shortcut`, `start`, `stop`, `upgrade` | fails, naming `./station <command>` | yes |

A contributor-tier verb invoked from the bundle exits non-zero with the exact command to run instead — never a stack trace and never a partial run against whatever directory you were standing in:

```console
$ station start
Error: `station start` runs against a Station repository checkout, so it is not part of the published CLI.
Run it from the root of a Station checkout with the bundled launcher:
    ./station start
The published CLI drives Stations that are already running — see `station stations`, `station setup hosted`, and `--api-base`.
```

`station --help` from the bundle includes a checkout-command note. It currently
lists `service` as a whole even though packaged `service status|start|stop` are
admitted. Per-command help describes the combined surface; admission remains
owned by [distribution.ts](../../packages/cli/src/distribution.ts).
`station <verb> --help` answers before that admission check.

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

Unknown commands and actions fail and point at relevant help. Flag validation
is command-specific; not every unknown or malformed flag is rejected. Use the
documented `--key=value` spelling for core commands.

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
   browser at `http://<host>:<ui-port>#station-ui-bootstrap=<token>`, where
   `<host>` is the host the instance recorded at start, or `localhost` for a
   wildcard bind or an entry with no recorded host.
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
| `--service` | Install and start a background service (from a source checkout, the checkout's development instance; see [`service`](#service)) |
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

From a checkout, `./station service` with no action, in a terminal, presents a menu of the service
actions (status, install, start, stop, uninstall) and dispatches your choice
through the ordinary `station service <action>` path — so the setup receipt and
rollback behaviour are identical to naming the action outright. With no TTY it
prints the usual `Usage: station service <install|start|status|stop|uninstall>`
error and does nothing, so scripts see the same deterministic failure as before.

## Native installation

For an available signed portable release ring, this macOS/Linux path installs
that exact release and starts Station without a manual clone. Check the
[release list](https://github.com/kontourai/station/releases) and
[release-ring guide](../guides/release-rings.md) for availability; desktop
channel tags and npm package tags are separate distribution surfaces:

```bash
sh -c 'set -eu; file=$(mktemp "${TMPDIR:-/tmp}/station-install.XXXXXX"); trap '\''rm -f "$file"'\'' EXIT HUP INT TERM; token=$(gh auth token); GH_TOKEN="$token" gh api repos/kontourai/station/contents/install.sh -H "Accept: application/vnd.github.raw+json" >"$file"; chmod 600 "$file"; GH_TOKEN="$token" sh "$file"'
```

The authenticated one-liner uses an existing GitHub CLI login for release
verification. It verifies the
stable-ring manifest,
checksum, and archive attestations before parsing or using them; there is no
anonymous or unsigned fallback. Set `STATION_CHANNEL=beta` for the beta runtime
channel, whose signed release ring is preview. See [release rings](../guides/release-rings.md) for recovery and
revocation guidance.

The checksum-addressed releases live under `~/.station/installs/stable/releases`,
`current` points atomically to the active release, and `~/.local/bin/station`
is the stable launcher. Runtime data remains isolated under
`~/.station/instances/stable` and survives an ordinary uninstall.

The separate `STATION_INSTALL_PUBLIC_MANIFEST_URL` path also accepts
platform-v2 archives on macOS/Linux. Those install under
`installs/<channel>/versions/<version>` and use bundled Node.js without a host
build. Verification can download a pinned Node.js when neither the host nor
an installed archive supplies one. See the
[archive install contract](../guides/release-channel-ports.md#prebuilt-archives-and-source-releases)
for prerequisites, retention and service limits. On Windows, `install.ps1`
installs the `station-server-win32-x64.zip` archive from a signed public
manifest the same way, with a `current` junction and a `station.cmd`
launcher; see
[Windows archive installs](../guides/release-channel-ports.md#windows-archive-installs).

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
`--api-base` accepts a full HTTP(S) URL and deliberately bypasses
saved Station persistence for bootstrap and diagnostics; it never changes the
default. A named override or merely viewing a Station also never changes the
default.

A native Desktop may save an inert broker route in this same store. It has no
CLI transport or credential reference: `--station` and `STATION_TARGET` refuse
that route instead of sending a direct request to its recorded Station origin.
The strict schema means an older CLI or Desktop build that predates the
`relayRoute` field refuses the shared profile file. Update readers sharing the
root before saving a broker route; see [#2404](https://github.com/kontourai/station/issues/2404)
for the mixed-version compatibility work. Current readers fail closed without
overwriting unknown metadata.

Project selection is an explicit, secret-free pointer to a saved Station:
`station stations project use <name>` maps the canonical invoked directory in
the owner-controlled store, `show` reports it, and `clear` removes it.
Repository files cannot redirect the target, and resolution does not walk
parent directories or infer a target from repository contents.

The default Station applies to every command that talks to a Station API,
including `environment` verbs. Host-side verbs that must run against the local
Station (`environment access list|approve|deny`, `environment operator passkeys`) still require a loopback
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

Protected API requests require a bearer credential — even against a
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

SDK-backed Station requests default to a **30 second deadline**. Without one, a
Station that accepts the connection but never answers left commands printing
nothing at all, indefinitely — the worst failure mode for a command inside a
script. Set `STATION_REQUEST_TIMEOUT_MS=<ms>` to change it, or `0` to disable
that default deadline. Helpers with explicit budgets retain them: independent
review uses 30 seconds per request, triage diagnostics use 5 seconds, and cloud
target verification has a 15-second overall observation budget.

Deliberately exempt, because their responses are open-ended by design and a
deadline would abandon healthy work:

| Exempt | Why |
|--------|-----|
| Chat observation SSE | Chat POST returns a JSON acceptance handle under the ordinary request deadline. A separate SSE connection observes the accepted turn without an overall turn deadline. |
| Orchestration and approval SSE streams (`operate`, `approvals`, `sessions`) | Long-lived event streams; they carry their own `AbortSignal`. |
| `monitoring events` (live form) | Same — a live stream, ended by interrupting it. |
| `knowledge reindex` / `knowledge migrate` | Duration scales with your corpus, not with Station's health. |
| `flow attach-command` | Runs a gate command server-side; bounded by its own `--timeout-ms`. |
| `start`/`build` readiness probes | Already enforce their own startup deadlines. |

This is the shared SDK client contract, not a guarantee for every raw network
call in the CLI. The current `checkpoints restore` and `operate` stream paths
bypass that client; their limitations are described in those sections.

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
systemd, or Windows Task Scheduler before creating the default Station.
Without `--instance` or `--base` it installs the checkout's development
instance in its home (see [`service`](#service)), and the saved Station
records that same instance, home, and ports. A
failed install saves no Station. Existing setup can select an unpaired
Station deliberately or reuse the ordinary pairing pipeline with `--pair`.
Hosted setup pairs with `https://station.kontourai.io` and selects it only after
authentication succeeds; a denied or interrupted request preserves any prior
saved Station, default selection, and credential reference for an honest retry.

### `open`

`station open` opens an authorized browser session for a Station that is
already running on this machine. Unlike the [bare launcher](#the-station-launcher),
it never starts or stops a backend: it reads the selected home's instance
registry, refuses unless exactly one live instance answers, mints a one-time
local UI-bootstrap token, and hands the browser the same redeemable URL the
launcher does (station#1991).

```text
station open [--home=<directory>] [--instance=<name>] [--print]
```

`--print` prints the one-time sign-in link instead of launching a browser, for a
browser this command cannot open, such as a simulator or another profile. Each
link is single use, and minting one replaces any earlier unspent link, including
the one `station start` printed (#2612). Without `--print`, the command never
prints the token.

The link names the host the instance's UI listener bound, as recorded in the
registry at start (`127.0.0.1` for `start --watch`, which is loopback-only). A
wildcard bind (`0.0.0.0`, `::`) or an entry that recorded no host keeps
`localhost`. The host matters because the sign-in a link completes belongs to
that origin: `localhost` and `127.0.0.1` do not share it.

It is deliberate about refusing rather than guessing: no live instance in the
home names it and points at `--home`; several live instances require
`--instance=<name>`; an instance with no recorded browser address points at
its owning app; and a host with no browser opener says so instead of hanging.
Without `--print`, success prints only the bare address.

### `triage`

`station triage` creates an opaque owner-only run under
`$STATION_ROOT/cache/triage/<uuid>`. Each run has schema-v1 `context.json`,
readable `summary.md`, the versioned Station-owned `playbook.md`, bounded
`problem.md`, and `related-issues.json`. Runs with nonempty agent output also
retain a redacted `diagnosis.md` and local `issue-draft.md`, including when the
agent exits unsuccessfully. These files retain at most the first 64 KiB of
stdout, so they are not a guarantee of a complete diagnosis. The
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
When no supported agent is installed and none was explicitly requested, the
command succeeds with artifacts only. Explicitly requesting an unavailable
agent fails after preserving those artifacts.

`--problem` stores a bounded, redacted symptom. `--search-issues` explicitly
allows sending it to `gh issue list --repo kontourai/station`; an interactive run asks
the same yes/no question before searching unless that flag already supplied
consent. `--context-only` skips prompting but still performs a search explicitly
requested by `--search-issues`. Results retain only
bounded issue number/title/state fields. No GitHub write command exists here.

An agent launch separately makes the run files available to that agent and its
configured model service; issue-search consent is not a promise of offline
model processing. Use `--context-only` to collect without launching an agent.

The launcher requests Codex's read-only sandbox, no approval prompts, an
ephemeral session, and ignored user config. For Claude it requests safe plan
mode, disabled session persistence/Chrome/slash commands, and a Read/Glob/Grep
tool set. Both receive a short argument pointing at the run-local playbook,
not a multiline prompt argument; processes use argv arrays with no shell. The
playbook consumes only Station's consented related-issue artifact. Station
captures a bounded stdout prefix, redacts it, and writes
`diagnosis.md` plus `issue-draft.md` with model/agent and harness attribution;
the playbook forbids repairs, service commands, state/database writes,
source patches, and every GitHub write. Posting or repair remains an explicit later
Station action. The packaged client states that local host filesystem and the
source doctor are unavailable.

Live stdout is forwarded to the terminal before that redaction, and child
stderr is inherited directly. The stored-artifact redaction is not a guarantee
about terminal output. The [triage owner](../../packages/cli/src/commands/triage.ts)
passes mode flags and instructions; fixture tests do not establish enforcement
by every installed agent version.

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
| `<value>` | `true`/`false` become booleans, all-digit values become numbers, and other values stay strings. `null` is retained for registry-nullable fields and clears other accepted fields. |
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
side effects. `config get` reads through the live route when reachable
(showing an env-override provenance note where one applies). On a transport
failure it prints a notice and shows the local home's file instead; that is
not a reading of the unavailable target Station's configuration.

A mistyped action is a failure, not a listing: `station config sett` exits
non-zero and names the valid actions.

### `export`

Export Station's configured agents and tool servers into another tool's format.
Writes to stdout unless `--output=<path>` is given.
This reads the CLI host's selected Station home, not a remote Station API.
An output file must be new; existing files are refused.

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
`AGENTS.md`-style document. Station's embedded export block carries its structured
Agent, integration and workspace-guidance data. Recognized workspace guidance
is merged into local `config/app.json`, replacing the same keys when present;
this is a real configuration write. Matching Agent and integration IDs can also
be replaced. The command does not ask the remote API to activate these files.

Each completed import writes a ledger under the Station home recording the source path,
format, what was applied, and any fields that could not be represented, so a
lossy import is visible after the fact rather than assumed. These writes are
sequential, not one transaction: a later failure can leave earlier changes
without a completed import ledger. See the
[import caller](../../packages/cli/src/commands/import.ts) and
[local storage owner](../../packages/cli/src/commands/portability-io.ts).

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

For a new chat, `--project=<slug>` selects Project context for either engine
kind. The current CLI also sends `process.cwd()` as that target's workspace
directory; it does not simply request the Project's configured directory. The
server requires this directory to resolve inside the selected Project's
configured directory, following symlinks and comparing whole path segments.
Run the CLI from that Project or a contained subdirectory; an outside or
unresolvable directory refuses before execution. Separately verified remote
workspace paths retain their remote-path admission. Use `--project` or `--cwd`,
not both.

The checkout launcher changes directory to the Station checkout before running
the CLI. Chat currently uses that process directory rather than the preserved
`STATION_INVOKED_CWD`; an invocation from another repository can therefore use
the Station checkout. For directory-based work, pass an explicit target-visible
`--cwd`. This is a current caller limitation, not a Project authorization grant.

With `--on=<environment>` and neither `--project` nor `--cwd`, a new chat sends
no workspace, because this machine's directory means nothing on another Station.
A directory workspace (the default for the current Station, or `--cwd`, or
`station delegate --project-path`/`--cwd`) needs the operator's credential or a
device holding the `coding:exec` grant; a paired device without it is refused with
`working-directory-not-granted` and nothing starts. `--project` needs no grant.

On continuation, the current caller omits workspace selection: `--project`
and `--cwd` have no effect and are not warned about. The Conversation keeps its
persisted workspace. Omit those flags when continuing; start a new chat to
choose another workspace. [#2733](https://github.com/kontourai/station/issues/2733)
tracks these caller limitations.

### `chat`

Shortcut for chatting with a configured agent. Use `--conversation=<id>` to
continue an existing managed conversation or orchestration-backed runtime
session.

`--title` is currently rejected on this canonical foreground path; Station
does not silently discard it. Conversation naming will return when it is part
of the shared execution contract.

```
station chat <agent> <message> [--on=<environment>] [--project=<project-slug>|--cwd=<path>] [--conversation=<id>] [--model=<id>] [--approval-mode=<ask|auto|never|connection-default>] [--effort=<level>] [--thinking=<true|false>] [--model-option=key=value]... [--on-request=<wait|fail>] [--api-base=<url>]
```

Examples:

```bash
station chat station "What changed in this repo?"
printf 'Review the latest project state' | station chat planner
station chat ollama "Reply with exactly: OK" --model=llama3.2:latest
station chat codex "Summarize the open work" --project=launchpad
station chat codex "Probe the media host" --on=env-media-host --project=my-project
station chat codex "Fix the failing test" --cwd=/repos/launchpad --approval-mode=auto --effort=high
# Use the Conversation ID returned by an earlier chat:
station chat codex "Continue" --conversation="$CONVERSATION_ID" --approval-mode=auto
```

`--on=<environment>` selects a saved Environment; omitting it means the current
Environment. The controlling Station sends the canonical Environment + Agent
target to that Environment for resolution. The CLI never selects an engine,
connection, provider, tunnel, or remote API URL for execution.

`--approval-mode`/`--effort`/`--thinking`/`--model-option` (station#978) set
per-invocation settings on an Agent whose resolved engine supports them. The
server validates option keys after resolving the target; Station's engine does
not support this engine-options bag. `--approval-mode` accepts exactly
`ask`, `auto`, `never`, or `connection-default` (an invalid value is a usage
error, exit 1, before any request); `--effort` and `--thinking` are
otherwise engine-specific. `--model-option=key=value` is a repeatable
escape hatch for any `modelOptions` key not covered by a named flag — named
flags always win a key collision. The equals form is required by the current
parser: a space-separated `--model-option key=value` is not supported and may
become prompt text instead of an option. [#2732](https://github.com/kontourai/station/issues/2732)
tracks rejection or support for that spelling. An option key the target engine's adapter
doesn't actually read is rejected with an explicit 400 naming the option
and target (nothing is silently dropped); see
`packages/contracts/src/provider.ts`'s `PROVIDER_MODEL_OPTION_SUPPORT` for
the authoritative per-engine list. `--session=<id>` (or `--conversation=<id>`)
continues the durable Conversation. Supported model overrides/options are
forwarded for that turn; omission retains the current choice. Workspace flags
are currently omitted as described above, not rejected.

`--model` is capability-gated at the same shared orchestration dispatch seam as
the API. Omission may deliberately be engine-selected (Codex does not receive a
fabricated default id); Bedrock and Ollama require a catalog-backed selector at
session start, then retain the accepted selector for an omitted resume or turn.
An explicit replacement is catalog-validated before execution.
Claude and Codex accept only lifecycle points their adapters declare. ACP can
apply a start-time selection only when the new session's option catalog offers
it and the engine confirms the exact selected value. ACP resume and per-turn
model changes remain unsupported. Requested, applied and reported model facts
remain separate; see [model launch behavior](api.md#orchestration-model-launch-behavior).

`--cwd=<path>` binds a **new** runtime session's `cwd` to an explicit
directory, independent of any registered project (unlike `--project`, no
Project needs to exist) — use `--project` or `--cwd`, not both. The path is
validated fail-closed server-side (mirrors the `--project` behavior above):
a `cwd` that doesn't exist on the target Station's filesystem fails the
canonical execution request rather than silently spawning the adapter somewhere else.

`--on-request=<wait|fail>` (station#979, default `wait`) governs what
happens when the target opens a pending request (approval/permission/
confirmation/input) mid-turn through the canonical orchestration path for
either engine kind. Previously this hung the CLI
silently until the request was resolved out-of-band or a ~60s auto-deny
elapsed, with no indication. Now a notice always prints to stderr naming
the `requestType`, `title`, `requestId`, `threadId`, and a responder command
for approval/permission decisions:

```bash
station approvals respond <thread-id> <request-id> <accept|acceptForSession|decline|cancel>
```

`--on-request=wait` keeps waiting for the request to be resolved
out-of-band (the notice just makes the wait legible). `--on-request=fail`
stops waiting and exits **4** instead, leaving the session alive and
resumable — it is never torn down (no `stopSession`) just because a
request opened. `--json` carries a typed `pendingRequest` field
(`requestId`/`requestType`/`title`/`respondCommand`) plus `lifecycleState` (the session's
`SessionLifecycleState`, e.g. `needs_input`/`review_pending`) whenever
either was observed. `pendingRequest` retains the last request-opened notice;
the CLI does not clear it on resolution. With `--on-request=fail`, it explains
why waiting stopped. With `wait`, even completed final JSON can retain that
notice. Read the current Session/request before deciding that it still needs
an answer; the field's presence alone is not current pending-state evidence.
The response-contract correction is tracked in
[#2741](https://github.com/kontourai/station/issues/2741).

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
station delegate --agent=<slug> [--on=<environment>] [--model=<id>] [--project=<slug>|--project-path=<path>|--cwd=<path>] [--parent-task=<task-id>] [--approval-mode=<ask|auto|never|connection-default>] [--effort=<level>] [--thinking=<true|false>] [--model-option=key=value]... [--on-request=<wait|fail>] [--json] <prompt|--data=<text>|--file=<path>|stdin>
station delegate --session=<conversation-id> [--on=<environment>] [--model=<id>] [--approval-mode=<ask|auto|never|connection-default>] [--effort=<level>] [--thinking=<true|false>] [--model-option=key=value]... [--on-request=<wait|fail>] [--json] <message>
station delegate status <task-id> [--on=<environment>] [--json]
station delegate events <task-id> [--after=<cursor>] [--on=<environment>] [--json]
station delegate continue <legacy-id> <message> [--on=<environment>] [--model=<id>] [--approval-mode=<ask|auto|never|connection-default>] [--effort=<level>] [--thinking=<true|false>] [--model-option=key=value]... [--on-request=<wait|fail>] [--json] # deprecated compatibility alias
station delegate respond <task-id> <request-id> <accept|acceptForSession|decline|cancel> [--on=<environment>] [--json]
station delegate interrupt <task-id> [--on=<environment>] [--json]
station delegate wait <task-id> [--on=<environment>] [--timeout=<seconds>] [--interval=<seconds>] [--json]
station delegate targets [--on=<environment>] [--project=<slug>|--project-path=<path>] [--json]
```

`--session=<conversation-id>` is the one continuation selector across
foreground chat and delegation. It resolves the Conversation's current child
Session at the serving Station; callers do not choose a Session just to send a
follow-up. `task:` and `cli:` identifiers remain accepted as legacy
conversation identities. Ordinary chats and delegated conversations both use
the canonical conversation continuation API. `delegate continue <legacy-id>
<message>` retains the legacy task-bound API and response for at least this
release and emits a migration notice. Supervision verbs keep their deliberately
different scope: `status`, `events`, `respond`, and `interrupt` operate on the
resolved current Session/task and their output identifies both the durable
`conversationId` and `currentSessionId`. A Conversation selector does not create
a Task or grant task-supervision authority.

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
station delegate wait task:0f3c... --timeout=1800 --json   # exit 0 on completed; 5 = deadline with the task last observed active
station delegate events task:0f3c... --json
station delegate --session=task:0f3c... "Also check the failing test" --json
station delegate interrupt task:0f3c... --json
```

Delegating to an External agent by its Agent ID on a saved Environment:

```bash
station delegate --agent=codex --on=env-media-host --model=gpt-5.6-sol "Review the diff" --json
station delegate respond task:0f3c... req-1 accept --json
```

#### Recorded versus acknowledged decisions

`station delegate respond` records a decision; it does not wait for the
engine. Its `resolved` result, and the `request.resolved` event, mean
"Station recorded this decision", never "the engine applied it". What the
engine reports afterwards is shown separately as `lastDecision` on
`station delegate status`, with one of these `delivery` values:

| `delivery` | Meaning |
| --- | --- |
| `awaiting-acknowledgement` | The engine acknowledges decisions and has not yet. Codex normally does within a second. |
| `acknowledged` | The engine closed the request after Station's well-formed reply. This is not proof it applied the decision as given; `engineStatus` carries the engine's own outcome when it reports one (Muse). |
| `unacknowledged` | `reason: no-acknowledgement`: nothing arrived within the adapter's window (30 s for Codex), or the session ended first. Station has not re-sent the decision. A late acknowledgement replaces this with `acknowledged`. `reason: invalid-reply`: Station refused to send a reply the engine would not accept, so the engine is still waiting. |
| `in-process` | Station's own engine consumed the decision. |
| `closed-by-engine` | Codex closed the request on its own (for example when a turn is interrupted) before Station answered. Station made no decision (`status` is `cancelled`), and a decision sent afterwards is refused, since Codex would never read it. Printed as `Request req-1: closed by the engine before Station answered`. |
| `not-reported` | The engine's protocol reports no delivery (Claude Code, ACP connections), or the decision predates delivery reporting. This is a capability, not a warning. |

One race stays open: if Codex closes a request while Station's reply is
already on its way, the close reads as `acknowledged` even though Codex
discarded the reply, because Codex's close does not say which came first.

The default output prints it as one line, for example
`Decision on req-1: approved (recorded), acknowledged by the engine after 42 ms`.
An earlier decision on the same task that is still `unacknowledged` is listed
as `earlierUnacknowledgedDecisions` and printed on its own line above it, so
a later acknowledged decision never hides it.
Codex acknowledges even a reply it cannot parse, so Station checks every
reply against the engine's decision vocabulary before sending it; that check,
not the acknowledgement, is what keeps a malformed reply from reading as
acknowledged. An unacknowledged decision also raises a `runtime.warning`
(`engine-decision-unacknowledged` or `engine-decision-not-sent`), and
`station delegate events` lists each observation as a `request` event with
status `acknowledged` or `unacknowledged`.

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
request). `--model-option=key=value` is a repeatable escape hatch for any
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

`wait` (#2264) is bounded, OBSERVATION-ONLY completion waiting: it polls the
same secret-minimized status snapshot `status` reads until the task reaches
an honest outcome or the caller's wait budget expires. It can never
redispatch, restart, approve, decline, or interrupt the delegated provider —
a wait deadline, Ctrl-C, or a polling failure leaves the delegated task
untouched and running. There is no progress-based kill policy and no
heartbeat-driven wait extension.

```
station delegate wait <task-id> [--timeout=<seconds>] [--interval=<seconds>] [--json]
```

`--timeout=<seconds>` bounds the whole wait (default 3600, max 86400);
`--interval=<seconds>` spaces consecutive polls (default 5, max 3600).
Both must be positive whole seconds — malformed (`abc`, `1.5`, `Infinity`),
zero, or out-of-range values are usage errors (exit 1) before any request.
Each HTTP status read is bounded by the REMAINING wait budget, so a hung
read cannot silently outwait the deadline. The wait budget is the caller's
observing budget only and is entirely separate from the delegated engine's
own per-turn execution budget (the `supervision` facts `status` forwards):
expiring one says nothing about the other.

Outcomes are honest and distinguishable; observation ambiguity is never
laundered into completion or failure:

- `completed` — the task finished (exit 0).
- `failed` — the server reported `failed` or `canceled` (exit 3).
- `needs-action` — a `pendingRequest` is open, or status is `needs_input`,
  `review_pending`, or `blocked` (exit 4). The task is alive and waiting on
  you; answer with `station delegate respond` or `station approvals respond`.
- `wait-timeout` — the deadline expired while the task was last observed
  `queued`/`running` (exit 5). Waiting never stops the task, and it may have
  advanced or finished since the last observation; re-run `wait` or check
  `status` to see where it is now.
- `observation-lost` — a status read failed (transport error, HTTP failure,
  or a read bounded out by the budget) (exit 2, the delegate transport-failure
  code). Output carries only a SAFE fixed error category (transport, HTTP
  status, refusal code, timeout) — never the raw error message, URL, or
  response body, which can carry peer-controlled content. The last good
  observation is reported and explicitly NOT classified as a task failure;
  after the loss the task's outcome is not known from here. Re-running
  `wait` is safe.
- `unknown` — the server reported `unknown`, or a status value this CLI
  version cannot classify (exit 6).
- `interrupted` — Ctrl-C (exit 130). The abort signal reaches the in-flight
  status read itself, so a hung read cannot keep Ctrl-C blocked; the
  listener is removed on exit. Observation stopped without cancelling the
  task, and the task's current state is not known from here.

The result reports the actually observed identifiers — the durable
`conversationId` and the CURRENT child Session (`currentSessionId`) at the
last observation. A continuation that replaced the child Session mid-wait is
observed (`sessionChanged` with `previousSessionId`), never dispatched; the
wait continues and the final envelope names the real current Session, so no
outcome ever implies a later turn already completed.

Under `--json`, exactly one envelope is written to stdout — progress text is
suppressed, so the output stays machine-clean:
`{"ok": <true only when completed>, "kind": "delegate.wait",
"data": {outcome, exitCode, taskId, conversationId, currentSessionId,
status, pendingRequest?, sessionChanged, previousSessionId?, pollCount,
elapsedMs, timeoutMs, intervalMs, lastError? (a safe fixed error
category — never a raw message, URL, or response body), lastSnapshot?}}`.
Human output shows concise progress on stderr and a final summary that
reuses `status`'s safe projection; it states explicitly that a wait timeout
leaves the task running. Raw provider logs are never printed.

Exit codes, scoped to `delegate` only (every other command's exit behavior
is unchanged):

For canonical `delegate --session`, `data` contains the foreground execution
receipt (`conversationId`, accepted `sessionId`, `providerTurnId`, `target`, and
`resolution`), plus `currentSessionId` as an alias of `sessionId` and
`status: 'dispatched'`. It does not invent a `taskId`; environment/model
provenance is in `resolution`. Consumers needing the previous task-specific
follow-up payload can use the deprecated `delegate continue` alias during
the compatibility period. Task creation and supervision payloads are unchanged.

`--on-request=<wait|fail>` (station#979, default `wait`, `create`/
conversation continuation only) — `delegate` dispatch is fire-and-forget (the server
returns a `status: 'dispatched'` handle immediately; there is no live
event stream open at the CLI call site to react to mid-turn, unlike
`chat`). `--on-request=fail` makes one best-effort observation after dispatch.
Canonical local continuation reads pending approvals on the accepted child
Session and supplies a `station approvals respond` command. Task creation,
legacy continuation, and saved-environment task probes use task supervision
and a `station delegate respond` command. A saved-environment ordinary
Conversation has no task probe; its unavailable observation is reported as a
warning, preserving the successful dispatch. Observation errors never trigger
another turn. An observed pending request exits **4**, leaving the Conversation
alive. `--on-request=wait` skips that check entirely (today's behavior,
unchanged). Independent of `--on-request`, `station delegate status`
always prints the respond-command hint alongside an existing
`pendingRequest`.

Exit codes, scoped to `delegate` only (every other command's exit behavior
is unchanged):

- `0` — success
- `1` — usage error (a missing/invalid argument, before any request is attempted) — the same as every other CLI command
- `2` — transport failure (the target Station is unreachable or timed out); for `wait`, also an observation lost while polling — never classified as a task failure
- `3` — delegation rejection (a received-but-unsuccessful response: bad target, not ready, or a deps-unavailable/business-rejection response); for `wait`, the task reached `failed`/`canceled`
- `4` — `--on-request=fail` found a request already pending right after dispatch/continue (the task is left alive, not torn down); for `wait`, the task needs your action (pending request / `needs_input` / `review_pending` / `blocked`)
- `5` — `wait` deadline expired with the task last observed active (not a failure — waiting never stops the task)
- `6` — `wait` observed a task status of `unknown` (or one this CLI cannot classify)
- `130` — `wait` interrupted by Ctrl-C (the delegated task is unaffected)

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

A request is pending when it has no `request.resolved`, was not
[settled by its turn's abort](session-api.md#respondtorequest), and, when the
session summary carries `openRequestIds`, is still listed there. Each row
carries `requestEventId`, the `request.opened` event it was read from.
`respond` looks the request up first and, for an approval or permission this
Station still lists, sends that id as `expectedRequestEventId`, so the server
answers the request that was listed and refuses one that changed. A question
(a request carrying a questionnaire) is never bound this way, so the server
still refuses to close one that was not inspected. A request the lookup does
not find is posted without the id and the server decides; nothing is refused
client-side.

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

The terminal operator view is intended to show a session
board, a live transcript for one focused session, that session's pending
approvals (tool name **and** input, answerable by a single keypress), and its
Flow gate verdicts.

**Current authentication limitation:** its
[stream caller](../../packages/cli/src/commands/operate/shell.ts) uses raw `fetch`
for `/api/orchestration/events`, so the credential configured for SDK requests
does not accompany that stream. A protected Station can return 401 even when
the same target's SDK reads succeed. The synthetic HTTP check reproduced that
caller behavior; use `sessions`, `approvals` and `chat` while this path remains
unrepaired.

When a stream is admitted, the screen is
reduced from one global `GET /api/orchestration/events` connection (the same
route `approvals --watch` uses, opened once and unfiltered — board,
transcript, approvals, and gates all derive from this single stream) plus
on-demand, non-continuous pulls when focus changes or on manual
refresh: `GET /api/orchestration/sessions/:threadId` (seeds a session's full
history), `GET /api/orchestration/sessions/:threadId/flow-run`
(`getSessionFlowRun`), and `GET
/api/orchestration/sessions/:threadId/builder-run` (`getSessionBuilderRun`,
archive#189 S4), plus a separate fleet-routing receipt read. This does not
continuously refresh every owner projection.

The approvals pane lists a `request.opened` with no `request.resolved` that
was not [settled by its turn's abort](session-api.md#respondtorequest), by the
same shared rule the server applies, over the events this screen holds. A
keypress decision on an approval or permission that is not a question is
sent with the listed request's event id as `expectedRequestEventId`.

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

Existing tests cover reducer/render/keypress behavior and the shell with a
controlled `node:http` server and `PassThrough` keypress input
([shell tests](../../packages/cli/src/__tests__/operate-shell.test.ts)). They do
not establish authenticated production streaming or a real terminal's cursor
and raw-mode behavior. After the authentication limitation is repaired, use
the following manual protocol to check a real terminal and retain its results:

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
5. Record the Station revision, terminal/platform, observed outcomes, and any
   failures separately from fixture-test results.

`operate` uses ANSI cursor-home/clear sequences and Node `readline` keypress
events. The terminal must support that input and display behavior; a Windows
console without VT processing can display raw escape bytes. Source and fixture
checks are not a terminal-specific compatibility result.

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
station connections recovery <id> [--api-base=<url>]
station connections profiles <id> [--api-base=<url>]
station connections profile-upsert <id> --data='{"ref":"...","label":"..."}' [--api-base=<url>]
station connections profile-env <id> <profile-ref> --data='{"env":{"NAME":"value"}}' [--api-base=<url>]
station connections profile-delete|profile-enroll|profile-unenroll <id> <profile-ref> [--api-base=<url>]
station connections recovery-policy <id> --automatic=<true|false> [--api-base=<url>]
station connections profile-import <id> <profile-ref> [--include-credentials] [--api-base=<url>]
station connections profile-apply <id> <profile-ref> --confirm [--timeout-ms=<ms>] [--api-base=<url>]
```

`profile-env` replaces a credential profile's non-secret env overlay
(`{"env":{}}` clears it). Credential-shaped names and values are refused by a
heuristic (names such as `*_KEY`, `*_TOKEN`, `*_AUTH`, `*_HEADERS`, `*_PAT`;
values with URL userinfo or an authorization header); set such a name to `""`
to mask an inherited value. `profile-upsert` refuses an `env` field.
`profiles` and `profile-env` print each profile's overlay, or `envInvalid`
with the offending variable names when the saved overlay breaks the rules;
`recovery` does not. See
[credential profile env overlays](../guides/connections.md#give-a-credential-profile-its-own-routing).
`create`, `update` and `delete` print the resolved target to stderr
(`Target: station=… endpoint=… source=…`) before the request, because the
default target can be a saved remote Station. `create` refuses an `id` that
already names a Model connection on that Station; use `update` instead.

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
(same trust level as scheduler jobs and tool servers, and a paired device needs the
operator's `coding:exec` grant: `command-not-granted` otherwise) and attaches the output
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

Read the run history currently projected by the neutral runs API (`/api/runs`)
from its supported owners and the caller's readable scope. It is not an
unrestricted inventory of every engine's history.

```
station runs list [--api-base=<url>]
station runs read <run-id> [--api-base=<url>]
station runs output --data=<json> [--api-base=<url>]
```

| Argument/Flag | Description |
|---------------|-------------|
| `list` | The current server projection for this caller. Takes no filter flags today; filter the JSON downstream. |
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

`run` is the foreground supervisor used by installed OS units and containers.
It takes the same atomic home claim before starting Station. With no installed
policy, it creates a service owner record with its PID and birth fingerprint;
existing installed policy is preserved. A conflicting live owner keeps the
supervisor alive without running Station. It polls at 5, 10, 20, then at most
30-second intervals, logging only refusal-reason changes, and claims and starts
when the owner is gone. Unreadable registry state exits nonzero. Lost ownership
at readiness stops Station before returning to the same wait. Install still
writes policy and a live installer reservation before starting the backend,
restoring prior policy if backend startup fails.

The container image's existing `service run` invocation self-claims a fresh
home without a policy-registration step. Direct `command-station.js` is still
unfenced and must not be described as exclusive ownership when sharing a
writable home.
`station start` remains the detached lifecycle command with its separate
shared-home checks and overrides.

The default service uses the selected channel's runtime home and generated
server/UI ports (`~/.station/instances/stable`, `18141`, and `18000` for
Stable), with loopback host `127.0.0.1`. `STATION_HOME`, `--home`, and `--base`
override only that runtime leaf; shared saved-Station metadata remains under
`STATION_ROOT`. `--temp-home` is rejected because a service needs a durable
home. Every backend is per-user and requires no elevation.

From a source checkout (the development channel), a service installed
without `--instance` and without `--home`, `--base`, or `STATION_HOME` is
the checkout's development instance: it is named with the checkout's
development instance id and runs in that instance's home and on its ports.
This covers `station service install`, `station setup local`, the launcher's
`--service` flag, and its "Install and start a background service" choice.
If that home already holds a service installed from this checkout (for
example a `default` service from an earlier `setup local`), flagless commands
address that service instead and say so; if it holds several, they refuse and
list them so you can pass `--instance`.
An explicit `--instance=<name>` other than that id, with no explicit home,
is refused: `--instance=<dev id>` names the service after its home,
`--instance=<name> --base=<dev home>` keeps an existing service where it is,
and `--instance=<name> --home=<dir>` gives it its own durable home.

Before registering, a source-checkout install checks the build stamp
(`dist-server/station-build.json`, or `dist-server-<instance>/` for a named
instance), which `station build` writes and `npm run build` does not. When the
stamp is missing or records a sha other than the checkout's `HEAD`, install
rebuilds first, as it does for a stale bundle, and refuses, naming
`station build`, only if the stamp still does not match. If git cannot read
`HEAD`, a missing stamp is refused without building, because the build could
not write one. `station service run` rebuilds on the same conditions. Packaged
installs (no `.git`) are not checked.

What the unit runs depends on where `service install` runs from. A source
checkout's unit runs its `scripts/station-cli.ts` through `tsx` with the
installing Node.js, from the checkout's physical path. A prebuilt archive's
unit runs `bin/station.mjs` with the archive's bundled Node.js. For the
version `install.sh` made active (on Linux and macOS), the unit runs the
archive's bundled Node.js through `<install root>/current` (and puts
`current/runtime/bin` on its `PATH`) with the fixed service launcher that
`service install` copies to `<install root>/runtime/station-launcher.mjs`; the
launcher runs the active version. The
service manifest records which (`kind`: `source` or `archive`) and, for such
an archive, its `installRoot`; the installer and `station upgrade` recognize
the service by that root. Installing a service from another version under
`<install root>/versions/` is refused, because the installer may remove it.
The unit keeps the ports it was installed with: an installer run that names
another port explicitly refuses rather than ignoring it. A registered unit
that is not running (stopped, or waiting to be restarted after a crash) is
stopped for the switch and left stopped, and the installer starts no separate
Station beside it; `service start` starts it on the new version. Every unit
sets `STATION_SERVICE_MANAGED=1`, and systemd waits 165 seconds
(`TimeoutStopSec`) before it kills the unit: the launcher gives `service run`
65 seconds to stop, then kills it and runs that version's own `station stop`.
A unit installed by an earlier version keeps its shorter timeout until
`station service install` is run again.

A launcher-run service updates itself (#2675). `runtime/service-state.json`
records which version it runs. An update request
(`runtime/update-request.json`) is staged by the running version with its own
`install.sh` (`STATION_INSTALL_STAGE_ONLY=1`: downloaded, verified and sealed
into `versions/<version>`, nothing else changed). The launcher then stops the
running version, backs up the home once, and starts the new version as a
trial. The backup holds Station's own state: every entry but the service
manifests, `instances.json`, logs, monitoring, quarantine and `tmp` (which the
service owns), and but the default project directories under `workspaces/`
and the browser's `browser/chromium` and `browser/profiles`: an update neither
copies nor rolls them back. For `workspaces/` this is an accepted gap, not a
claim that it holds no Station data: Station writes `.station/` stores into
each project (diff comments, trust bundles, review-evidence receipts,
survey-review sessions, flow-review evidence), and a rolled-back update leaves
them as the trial left them, as it always has for projects outside the home.
Symbolic links in the backup are kept as links; a link at the top of a state
root (for example `browser` pointing at another volume) is kept as that link,
and what it points to is neither snapshotted nor rolled back. The trial has 240 seconds to prove its
identity; if it does, the update commits and `current` follows it. If it does
not, the launcher restores the backup, including `.station-home-schema.json`,
and restarts the previous version. A trial gets at most two attempts, and a
launcher that is killed at any point finishes the same update when it starts
again. A restore that fails is retried up to three times (each failure
restarts the unit); after that the update needs an operator: the launcher
keeps the backup, starts no Station, and logs the error. Fix its cause, then
run `station service stop --instance=<name>` and
`station service start --instance=<name>`: each start tries the restore once
more. That includes any restart of the launcher, a reboot among them: every
launcher start in this state runs one restore attempt on its own.
`station service status` shows the update (`update` in `--json`), and in this
state names the recovery; it is the place to see it, since no Station runs
for a client to ask. While the launcher that accepted the update runs, the service's
registry entry names it, so the desktop app keeps treating the home as owned
by a live service; a launcher that restarted mid-update does not claim the
entry again, so from then until a version publishes itself the entry names a
process that has exited.
`install.sh` (and so `station upgrade`) does not switch `current` under a
running launcher service: it stages the version, asks the service to switch,
and reports the outcome. It refuses to touch an install whose update is
unfinished until the service has been started to finish it, or one that needs
an operator until the restore has succeeded.

A client connected to such a server can start the same update: Settings →
Connected Station server → **Check for server updates** fetches the signed
public manifest the install records (`manifestUrl` in
`.station-release-state.json`) and verifies it against the pinned signing
keys for the install's ring before it offers a newer version. Applying it
writes the update request (owner-only, published atomically, refused while
another update is queued or under way); progress and the outcome, including a
rollback and its reason, are read back from `runtime/service-state.json` and
`runtime/update-request-result.json`. Only the server the launcher's own child
supervises may queue a request: the launcher's context
(`STATION_SERVICE_LAUNCHER`) reaches that server and no other process, and it
must name the server's install and version. An archive that no launcher runs
reports its newest release and says to update with `station upgrade` on the
host; an install that records no public manifest cannot be checked from a
client. An update that needs an operator is not visible from a client: in that
state the service runs no Station to answer, so the card keeps waiting and
names `station service status --instance=<name>` on the host.

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
| Windows | Task Scheduler task, `ONLOGON`, `LIMITED`, no time limit, no battery rules | installing user's logon | `<STATION_HOME>\logs\*-service.{out,err}.log` |
| No service manager (container, or Linux without a systemd user session) | foreground `service run` with an atomic home claim | when invoked after winning the claim; waits while another live owner holds the home | supervisor stdout/stderr and `<STATION_HOME>/logs/<instance>.log` |

`service status` reports the OS unit, lifecycle instance/processes, and both
server/UI identity endpoints. `--json` emits the same data for automation. An
installed but inactive or unreachable service exits non-zero.

The unit's `PATH` is captured once, at install, from your login shell
(`$SHELL -l`) plus the Node and system directories. A directory added to your
profile later, or a Nix/home-manager generation that has since moved on, does
not reach the service until it is reinstalled. For a managed install on macOS
or Linux, `service status` (and the status `start`/`stop` print) re-reads your
login-shell `PATH` and compares it with the `PATH` in the installed unit file
on a `service PATH` line:

- `current`: the unit carries exactly the directories, in the same order, that
  a reinstall would capture now.
- `drifted`: lists directories missing from the unit, directories no longer
  captured, and the first difference when the shared directories are in a
  different order (order decides which same-named binary wins). The reinstall
  command follows, printed once even when scheduling is also stale, or an
  explanation when no faithful command can be given.
- `unknown`: the unit could not be read or sets no `PATH`, or your login shell
  did not report its `PATH` within 5 seconds; nothing is compared.

`--json` carries the same result as `servicePath`:
`{ status, missing, stale, reordered?, reason? }`, where `reordered` is
`{ position, unit, current }` with `position` counted from 0 within the shared
directories. Drift is advice and does not change `healthy` or the exit code.
The comparison reads the unit file Station wrote, not systemd drop-ins or the
loaded job, and uses the environment of the shell that runs `status`. A
reinstall command is prefixed with `STATION_ROOT=…` when the registration's
recorded root differs from the one a shell without `STATION_ROOT` would
derive.

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

`schtasks /Create` leaves a task with Task Scheduler's defaults: a 72-hour
execution time limit, and battery rules that keep the task from starting on
battery and stop it when a laptop unplugs. Install therefore sets, through
`Set-ScheduledTask`, priority 5, no execution time limit (`PT0S`), both battery
rules off, and the scheduler's restart settings (every minute, the shortest
interval, up to 255 times). It reads all six back and refuses the install,
restoring the previous registration or removing the new one, if any of them
did not persist. Unlike the macOS (`KeepAlive`) and Linux (`Restart=always`)
units, the Windows task does not relaunch a service that exits: Task
Scheduler's restart settings apply to a task it could not start, and a wrapper
that exits non-zero is left stopped until the next logon or `service start`.
`service status` (and `station upgrade`) read the same six values on a
`scheduling` line: a task registered by an earlier version reports `stale`
with the reinstall command, and `healthy` is false until it is reinstalled.
So on an existing Windows install `service status` exits 1 after this change
until `station service install` is run again; the service itself keeps
running, and `station upgrade` only prints the advisory. A task whose settings
were changed by hand is reported `stale` the same way, and a reinstall
overwrites them.

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
station start [--port=<n>] [--ui-port=<n>] [--host=<address>] [--clean] [--force] [--allow-default-home-clean] [--build] [--watch] [--home=<dir>] [--base=<dir>] [--temp-home] [--instance=<name>] [--features=<flags>] [--log[=<path>]] [--allowed-origin=<origin>]...
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
| `--watch` | — | Development mode: server under `tsx watch`, UI as the Vite dev server proxying to it; loopback only, builds nothing. See [Development](../guides/development.md#running-a-second-station-in-development-mode) |
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
station dev [--port-offset=<n>] [--host=<address>] [--build] [--watch] [--clean] [--force] [--features=<flags>] [--dry-run]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port-offset=<n>` | derived | Force an exact offset (`0`-`500`), overriding the derivation. `--port-offset=0` is valid and yields the base ports `39140`/`40140` (just below the derived `39141`-`39640` band). |
| `--host=<address>` | `0.0.0.0` | Bind address; the default is a wildcard so a phone or LAN/tailnet client can reach the stable URL |
| `--build` | — | Force a rebuild before starting |
| `--watch` | — | Hot-reload mode, as `station start --watch` |
| `--clean` | — | Wipe this dev instance's isolated home before starting (with `--force` to skip the prompt) |
| `--force` | — | Skip the cleanup prompt / force a restart of an already-running dev instance |
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

**Isolated home.** Each instance runs against
`<STATION_ROOT>/instances/dev/<instance>`. Automatic names are
`dev-<sanitized-basename>-<hash8(resolved-path)>`; an explicit
`STATION_DEV_INSTANCE` uses `dev-<sanitized-seed>` instead. Recreating a worktree
at the same path reuses its home. Reusing an explicit seed across worktrees
deliberately selects the same home. Use the actual identity printed by `dev`;
this command does not accept `--allow-shared-home`.

```bash
station dev                       # deterministic ports from this worktree's path
station dev --dry-run             # inspect the resolved ports/home, start nothing
station dev --port-offset=7       # pin server 39147 / ui 40147
STATION_DEV_INSTANCE=alpha station dev
station stop --instance=<instance-printed-by-dev>
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
station environment operator passkeys [list] [--json] [--api-base=<loopback-url>|--station=<name>]
station environment operator passkeys approve <code> [--device=<id-prefix>] [--api-base=<loopback-url>|--station=<name>]
station environment operator passkeys deny <code> [--api-base=<loopback-url>|--station=<name>]
station environment operator passkeys revoke <passkey-id> [--api-base=<loopback-url>|--station=<name>]
station environment access list [--api-base=<loopback-url>|--station=<name>]
station environment access approve [<request-id-or-offer-id>|--latest] [--force] [--bind-person|--bind-account|--personal-device] [--api-base=<loopback-url>|--station=<name>]
station environment access deny [<request-id-or-offer-id>|--latest] [--force] [--api-base=<loopback-url>|--station=<name>]
station environment access devices [--json] [--api-base=<loopback-url>|--station=<name>]
station environment access scope <device-id|id-prefix|name> (--add=<scope,…>|--remove=<scope,…>|--set=<scope,…>) [--dry-run] [--api-base=<loopback-url>|--station=<name>]
station environment access scopes [--json]
station environment access revoke <device-id|id-prefix|name> [--force] [--api-base=<loopback-url>|--station=<name>]
station environment access remove <device-id|id-prefix|name> [--force] [--api-base=<loopback-url>|--station=<name>]
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
- `environment credential show` prints the raw
  credential so it can be entered in Station Connect's masked field. Do not
  redirect, log, screenshot, or paste this output into a URL.
- `environment credential rotate` preserves the environment ID and replaces
  only the operator bootstrap credential after confirmation. Independently
  issued Device credentials remain valid until separately revoked or the
  environment is reset. Rotation also prints the replacement bootstrap
  credential; protect its output in the same way as `credential show`.
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
- `access devices`/`scope`/`scopes` manage what each paired device may do, on
  the same host-only operator channel (#1796). `access devices` lists the live
  paired devices with id, name, last seen and scopes. `access scope` adds,
  removes or sets scopes on one device, named by its id, a unique id prefix,
  or its exact name (an ambiguous prefix or name is refused). Every scope is
  checked against the real vocabulary, `access:manage` is never grantable to a
  device, the new scope is computed from the device's current one and sent
  with the scope it replaces, so a change another operator made meanwhile is
  refused rather than overwritten (rerun to apply yours). `--dry-run` prints
  before and after without changing anything. `access scopes` lists every
  scope with its meaning. Full access is one scope among them:
  `station environment access scope <device> --add approval:full-access`
  lets that device put a chat, or an Agent's default, at full access;
  `--remove approval:full-access` takes it back, and resets to Ask every
  conversation that device had put at full access (a running turn finishes
  first). The command prints what it reset and what stays at full access
  for another reason (the operator's or another device's decision, an Agent or
  Station default, or a session with no recorded grantor). If that reset
  failed, running `--remove approval:full-access` again on the device re-runs
  it; re-running changes nothing already reset. A paired remote CLI cannot run
  these verbs: they refuse a non-loopback target before reading any
  credential.
- `access revoke` and `access remove` finish what the Paired devices panel
  cannot do from a native host app (#3256), on the same host-only channel and
  with the same device selector as `access scope` (id, unique id prefix, or
  exact name; an ambiguous one is refused). `access revoke` ends a live
  device's access immediately, closes its terminal and voice connections, and
  resets to Ask what its full access had granted, printing the same report as
  `--remove approval:full-access`; the device can pair again later. `access
  remove` deletes the record of an already-revoked device; a device that is
  still paired is refused (revoke it first). Both name the device before
  acting and fail unless Station's answer names that same device as revoked.
  Neither can be undone, so an interactive run asks first, and a run with no
  terminal is refused before Station is contacted unless it passes `--force`.
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
environment. Operator-credential rotation preserves the paired-device registry;
environment reset clears it, requiring those devices to pair again.

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
From a prebuilt server archive (`station-server-<os>-<arch>`) that `install.sh`
installed (the version `<install root>/current` names), `upgrade` validates the
install state, provenance, ownership marker and active link, then re-runs that
version's installer with the recorded release manifest. On Windows the
installer is the version's `install.ps1`, run through the system Windows
PowerShell, and the install root's ACL (current user only) is checked in place
of POSIX mode bits; a Windows service is not switched yet (#2675 W3). Public-manifest
installs record the URL in schema-4 state; an explicit
`STATION_INSTALL_PUBLIC_MANIFEST_URL` overrides it. The installer keeps the ports
the install recorded: the CLI's own `STATION_SERVER_PORT`/`STATION_UI_PORT`
(its channel's defaults unless set) are not passed on, and a deliberate change
goes through `STATION_INSTALL_SERVER_PORT`/`STATION_INSTALL_UI_PORT`. A Station user service
installed from that archive does not block it. When that service runs through
the fixed service launcher and is running, the installer only stages the new
version and asks the service to switch; the launcher trials it and keeps the
previous version if the trial fails (see [`service`](#service)). Otherwise
the installer stops the service, switches `current`, and starts the service
again, and if the service does not come back answering as the new release it
restores the previous version and restarts the service on it. Any other installed service still
blocks the upgrade, as in a source checkout.

A loose extracted archive has no installer-owned layout and still refuses
`upgrade` without changing anything. Install through `install.sh`, or stop
Station, extract the newer archive into its own directory and start it there;
it finds the old version's instance records (see
[Instance State Mechanism](#instance-state-mechanism)).

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

Run an integrity check over `data/orchestration.sqlite` and
`scheduler/scheduler.sqlite` and report each one. This command does not inspect
the home's other authentication, membership, native replay or Knowledge stores.
The stores are opened read-only, so this is safe to run while Station is
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
checked before copy for every included `*.sqlite` file, a database named by the
[home store registry](../../packages/shared/src/station-home-store-registry.ts),
or a file with an existing SQLite WAL. This includes
`security/native-device-proof-replay.sqlite` and `knowledge-index/index.db`;
WAL and shared-memory sidecars are not copied. Symlinks in included content,
corrupt databases, detected active instances, and
configured size/count limits fail closed. Volatile logs, monitoring output,
service state, temporary files, live instance records, and the top-level
quarantine directory are excluded. Defaults are 100,000 files, 20 GiB total,
and 2 GiB per file. This is a private local copy, not an encrypted export or a
transfer of execution authority.

```
station home backup [--output=<directory>] [--home=<dir>] [--base=<dir>] [--json]
```

If `--output` is omitted, Station creates a timestamped sibling of the home.
The destination must not already exist or be inside the home.

### `home restore`

Validate manifest entries and content hashes, stage the copied home, then
rename the previous home aside and publish the staged directory. The
[archive owner](../../packages/shared/src/station-home-archive.ts) holds the
maintenance lease, checks recorded live instances and attempts rollback on
publication failure. The two renames are not a single crash-atomic exchange:
the retained previous home is the recovery copy if publication is interrupted.

The CLI identifies the result as **recovered from a copy**, prints the backup's
snapshot time, and notes that work after that snapshot may be missing. Its JSON
receipt includes `recovery` with a new recovery ID, snapshot/recovery times,
the validated manifest digest, and `authorityTransferred: false`. Restore
publishes `station-home-recovery.json` atomically with the home, replacing any
prior recovery disclosure from that copy. This metadata grants no execution
authority and does not claim witnessed failover. Connected browsers show the same recovery-from-copy notice after refreshing
system status. This home-level disclosure does not establish a channel-specific
divergence checkpoint or witnessed transfer.

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

Archive the selected Station home so a fresh one is
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
| `--instance=<name>` / `--port=<n>` / `--ui-port=<n>` | Accepted lifecycle inputs; the reset refusal checks the selected home, not only one port or instance |
| `--json` | Print the result (`{"archived":..., "archivePath"?:..., "projectHome":...}`) as JSON |

Without `--if-incompatible`, this can archive a compatible home too. It checks
the lifecycle instance records for that home before renaming it. Unlike backup
and restore, this path does not acquire the home maintenance lease or separately
consult the home-scoped service registry. Stop every process using the home
first; use `station service stop` for a supervised service. A successful reset
preserves the old directory but does not itself start or scaffold the new home.

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

**Current restore limitation ([#2734](https://github.com/kontourai/station/issues/2734)).**
The restore caller uses raw `fetch`, sends no authorization, and defaults to
`http://127.0.0.1:3141` unless `--api-base` is supplied. It does not use saved
Station selection, `STATION_API_CREDENTIAL`, or the shared request deadline.
A protected Station therefore refuses its preview; supplying a credential flag
does not repair this caller. Use the authenticated workspace checkpoint UI or
API described in [workspace checkpoints](../user/workspace-checkpoints.md).

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
| `restore` | Currently cannot authenticate to a protected Station (see above). The caller requires `--confirm`, requests a preview, then immediately submits its `previewId` and `currentTreeSha`; it does not display the changed paths/tree before confirming. The server owns preview identity, expiry, current-tree, and active-turn checks. |

`--json` on every action prints one JSON document instead of the
human-readable form.

```bash
station checkpoints
station checkpoints prune --thread=abc123 --gc
station checkpoints prune --all --gc
# Restore is currently unavailable through this CLI; use the authenticated UI/API.
```

Restore changes workspace files only. It does not rewind conversation history
or external tool effects. A failed or indeterminate response must be inspected
before retrying; Station does not treat response loss as confirmation that the
workspace was unchanged.

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

Run from a prebuilt server archive, doctor reports the Node.js the archive
ships (`Node.js — v24.x (bundled: <archive>/runtime/...)`, a warn when some
other Node.js is running it) and a `Prebuilt archive` line with the release
ref, sha, ring, channel and lifecycle-state directory. It skips the npm, tsx,
Rust and `@kontourai/*` pin checks and the toolchain fix commands: an archive
cannot build itself and ships no source manifest.

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

Without a URL argument, fetches and displays the registry. It does not report
installed state: the running Station owns that, and
`station registry plugins list` shows it. The URL is read from
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

The install command currently submits the ID without a preview decision.
Executable or lifecycle-bearing entries are refused by the canonical installer;
[#2809](https://github.com/kontourai/station/issues/2809) tracks the missing CLI
consent flow. Use the Registry UI or `station plugin install <source>` to review
and submit consent. A successful catalog read does not prove installation.

`examples/registry/manifest.json` is the reproducible local fixture used by
`npm run proof:registry-manifest`. It is not a hosted registry proof by itself:
Phase 2 was closed on local-fixture scope, while any hosted registry remains
separate publication/distribution work requiring its own stable-URL evidence.

---

## Plugin

### `plugin install <source>`

Install a plugin from a git URL or local path through the running Station server.
The server owns the filesystem transaction, registry identities, runtime activation,
and rollback. A local path resolves from the CLI's invocation directory and is
accepted only for an automatically resolved active-local target or the default
loopback fallback. An explicit `--api-base` or saved-Station selection is refused
for directory input even when its URL is localhost; use a git URL for those targets.

The CLI previews first and requests consent for the captured package and
dependencies. Interactive use asks for confirmation; a noninteractive call
requires explicit `--yes`. The server rechecks that preview and owns dependency
installation. Installation and activation are separate outcomes; inspect a
pending or failed result before assuming the plugin is usable.

```
station plugin install <source> [--skip=<components>] [--yes]
```

| Argument/Flag | Description |
|---------------|-------------|
| `<source>` | Git URL (https or ssh) or local path. Append `#<branch>` to target a specific branch. |
| `--skip=<components>` | Comma-separated list of components to skip, e.g. `agent:myplugin:chat,layout:main` |
| `--yes` | Approve the disclosed installation without a terminal prompt |

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

List the installed-plugin projection visible to this caller, including rejected
rows when the server exposes them. Records can include contributions,
dependencies and readiness; presence alone does not prove activation.
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

Request removal by manifest name through the server's lifecycle owner. Managed
contributions are retired there; retained data and pending cleanup are separate
dispositions. The CLI prints completion only after an accepted success response.
When that response carries the plugin's own `commandEffects` withdrawal with a
status other than `completed` (Station answers 202 until captured palette
command effects settle), the CLI appends the outstanding count, status and
withdrawal id; with `commandEffectsUnavailable` it says completion cannot be
confirmed. The removal has already committed in both cases. A dependency's
`dependencyCommandEffects` are not summarized.

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

Update an installed plugin through the running Station server. The server resolves its source, rebuilds it, and applies registry and runtime changes as one lifecycle operation. Its success message carries the same command-effect note as `plugin remove`.

```
station plugin update <name>
```

```bash
station plugin update my-plugin
```

### `plugin init [name]`

Scaffold the full template in a new named subdirectory (`my-plugin` by default).
This legacy alias uses the CLI process directory; through `./station`, that is
the Station checkout. Prefer `plugin create` to use the preserved invocation
directory when launching from another project.

```
station plugin init [name]
```

```bash
station plugin init
station plugin init my-plugin
```

`init` scaffolds a new plugin (full template).

### `plugin create [name]`

Scaffold a new named subdirectory in the invocation directory using a specific
template. The default directory name is `my-plugin`; an existing directory is
refused.

```
station plugin create [name] [--template=<pane|full|provider>]
```

Every template writes an Agent Plugins 1.0 `plugin.json` whose Station
settings live under `extensions["io.kontourai.station"]`. The same templates
back the in-app **Plugins → New plugin** action
(`packages/shared/src/plugin-scaffold.ts`). The name must match the Agent
Plugins name grammar: lowercase letters, digits, hyphens or periods.

| Template | Description |
|----------|-------------|
| `pane` | One `plugin-component` Workspace Pane (`src/index.tsx`, `src/pane.css`) and a build script |
| `full` (default) | Two Workspace Panes, an Agent definition, and a build script |
| `provider` | Server-side starter with `serverModule`, a branding provider, and a setting |
| `layout` | Alias for `pane`, kept for existing scripts |

```bash
station plugin create my-plugin --template=full
station plugin create my-pane --template=pane
station plugin create my-provider --template=provider
```

`station plugin dev` previews legacy layout tabs only; it does not render
`workspacePanes`. Install the scaffold to see its Pane.

### `plugin experience inspect|review`

Inspect a pinned local Skill library, then review an authored ordinary plugin
against its source/package digests, source spans, gap dispositions and retained
evaluation transcripts. These commands read local files and grant no execution
or installation authority. See the [author learning path](../guides/authoring-skill-experiences.md)
for the receipt contract and evidence limits.

```bash
station plugin experience inspect /path/to/library --entries=my-skill
station plugin experience review /path/to/plugin --library=/path/to/library --entries=my-skill
station plugin experience review /path/to/plugin --library=/path/to/library --entries=my-skill --receipt=/path/to/review.json
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
| `[port]` | `4200` | Bare positional port. A second positional port is refused; repeated `--port=` flags currently use the last value. Supply one port selector. |
| `--no-mcp` | — | Disable MCP tool server connections |
| `--mcp` | — | Explicitly enable MCP (default when agents are present) |
| `--tools-dir=<path>` | `<invocation-directory>/integrations` | Directory containing integration config files |

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

Run an exact initial or delta review using the canonical request shared by the
API, SDK, Project Review layout, and station-control MCP:

```bash
station review run <project-slug> --file=review-request.json
station review run <project-slug> --data='{...}'
station review status <project-slug> <request-id>
station review list <project-slug>
station review read <project-slug> <receipt-id>
```

`review run` requires a caller-generated `requestId` and implementing Agent slug. Explicit mode carries distinct reviewer Agent slugs; Repo Map mode carries `"reviewers":[]` plus `"selection":{"kind":"repo-map"}` and Station resolves trusted policy, eligible read-only reviewers, and pins the exact resolved Git SHAs. Unavailable routing or reviewers becomes durable `not-verified` with a server-owned reason; no reviewer is invoked and no clean receipt is fabricated. Station resolves actor identities; clients cannot declare attribution.

The SDK gives each HTTP operation a 30-second bound, reads status after a submission failure, and retries the same request ID once if that read also fails. It then polls a running request every 500 ms; there is no CLI-wide review deadline. Completed results are printed, while terminal refused or indeterminate outcomes fail. `review status` reads the exact durable status directly.

Findings are evidence input only and do not approve, reject, satisfy a gate, or replace the completion gate. The station-control MCP exposes the same shared operations as `run_independent_review`, `get_review_request`, `list_review_receipts`, and `get_review_receipt`.

## Instance State Mechanism

When `station start` launches the server and UI processes, it writes per-instance state to `.station/instances/<instance-id>.json` in the current working directory. Each record includes the instance id, home directory, ports, and current server/UI PIDs.

`station stop` resolves the matching instance from `--instance`, `--home`/`--base`, `--port`, or `--ui-port`, then terminates only that instance: the PIDs it recorded, checked against the process fingerprint recorded at start. A process that merely listens on one of the instance's ports is never signalled, and a port listener alone does not keep an instance record alive, so a record left by a start that lost its port race is reclaimed without touching the sibling that owns the port. A recorded PID whose process no longer matches its fingerprint is not signalled and the stop refuses. `station start` refuses, before binding, a port band (server port through consent port, plus the UI port) that overlaps another live instance recorded in this checkout or published to the home's instance registry, and names that instance. If multiple instances are live and the selector is ambiguous, the CLI refuses and prints the matching records so you can choose the intended one.

During rollout, Station still recognizes the prior `<cwd>/.station.pids` file when present and migrates away from it as new-format state is written.

A prebuilt server archive keeps this state outside itself, in `<root>/state/<channel>/instances/` of the Station root the instance's home belongs to. The root follows from the path of the home the command resolved, however it was given (`--home`, `--base`, `STATION_HOME` or the default), and from nothing else: a home at `<root>/instances/...` belongs to `<root>`, which makes the default `~/.station` (`%USERPROFILE%\.station` on Windows); any other home, including a `--temp-home`, is its own root and holds its state, which goes when the home is removed. `STATION_ROOT` does not move it. So `STATION_HOME=/srv/st station start` and `station stop --home=/srv/st` read the same records, and a start from a non-default home prints its stop command with `--home`. A bare `station stop` searches the root of the home a bare command targets (`STATION_HOME` or the default). An archive's port-conflict and shared-home checks likewise see only instances recorded in the same root; a port another root's instance holds still fails the bind. The archive can therefore be read-only, and every extracted version of one channel shares the records: the next version's `station stop` finds what the previous one started. For the same reason an archive's implicit instance id (no `--instance`, non-default home or ports) hashes the channel, home and ports rather than the archive's directory. Source checkouts are unchanged.

The CLI requires the instance-state directory (`.station/instances` in a checkout, `<root>/state/<channel>/instances` for an archive) to be an owned, non-symlinked directory with mode `0700`; if it isn't (e.g. a checkout that predates this check, or a directory created with a looser umask), `station start`/`station build` fails with `Unsafe Station instance-state directory (expected owned mode 0700): <path>`. Fix it with `chmod 700` on the path the error names, for example:

```bash
chmod 700 .station/instances                    # checkout
chmod 700 ~/.station/state/stable/instances     # stable archive, default home
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
| `STATION_SERVER_PORT` | lifecycle | Server port override read by the lifecycle parser; `--port=<n>` takes precedence. |
| `STATION_UI_PORT` | lifecycle | UI port override read by the lifecycle parser; `--ui-port=<n>` takes precedence. |
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

Station-owned identity and path variables use the `STATION_*` prefix; the
table also includes telemetry and UI-build settings. Shared app data resolves
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
limits, and recovery. They do not enroll credentials or transfer running agents.
The package includes Git history and eligible tracked/unignored working files;
secrets already present in those bytes are not removed by a secret scanner.


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

### Open an authorized local browser session

`station open [--home=<directory>] [--instance=<name>]` opens an already-running local instance through its one-time browser authorization. Multiple live instances require an explicit selection. A failed authorization does not silently open an unpaired page. The default form keeps the capability out of stdout; the explicit `--print` form prints the one-time sign-in link. `station doctor` in the packaged client reuses the target diagnostic report; source-checkout doctor retains its development checks.

`station environment access approve <request-id> --api-base=http://127.0.0.1:<port>` requires the selected Station home (`STATION_HOME` or its saved local binding). The packaged client uses the same read-only record validation and listener challenge proof as the host. Non-interactive approval still requires `--force`; ordinary interactive use asks for confirmation.


### Recognize a verified person across devices

On the computer operating the Station, run
`station environment access approve <request-id> --bind-person` to explicitly
bind a verified Tailscale pairing request to that person. The CLI verifies the
local Station before presenting its operator credential, and the confirmation
names the verified subject. Non-interactive use also requires `--force`.

The option is valid only for approval of a server-verified identity. It adds no
Project membership or device scope. Without it, approval remains device-only.
The CLI requires the server's binding acknowledgment and reports older servers
that approved access without recognizing the option. Revoke the paired device
to revoke its binding; existing grants are not silently linked.

When an access request reports a current server-verified account candidate, an
operator can instead pass `--bind-account`. The confirmation names the account
and issuer; neither value is accepted from a CLI flag. Account binding requires
that account to sign in again on the requesting Device. The current pilot can
view Projects the account may access; editing and running work are unavailable.
It does not grant Project membership or personal access.
For a request with an account candidate, the operator must choose exactly one
of `--bind-account`, `--bind-person` (when verified Tailscale identity is also
available), or `--personal-device`. The last choice grants an ordinary Device
the selected scope until revocation; it does not require account relogin and is
not limited by that account's Project membership. A stale or revoked account
candidate fails without retrying as ordinary device approval.


### Portable Project identity and attachment

Export a Project identity from one enrolled Station and attach it to an existing
checkout on another. The CLI uses credentials already stored for each saved Station;
attachment requires an explicit destination.

```sh
station projects prepare-identity website --station=laptop > project-identity.json
station projects attach website-server --identity-file=project-identity.json --name=Website --station=server --target-workspace='~/src/website'
station projects execution-root website-server --repo-id=github.com/example/website --path=apps/web --station=server
```

`prepare-identity` explicitly prepares a missing identity and prints its portable
snapshot. Use `station projects identity website --station=laptop` for a read-only
export of an already prepared identity. Output contains the portable identity;
local paths, local Project IDs and access grants are not exported. Mutating
commands disclose their selected Station on stderr so JSON stdout stays usable.

`attach` creates the receiver's own local Project association while preserving
the portable ID. The receiver validates its existing checkout. Keep the target
path quoted so the invoking shell leaves its interpretation to that Station.
Omit `--target-workspace` for a Project with no local checkout. An existing
conflicting Project is refused; an exact replay can return the existing
association. Membership and compute contributions require their separate grants.

`execution-root` first reads the current portable identity and then submits that
exact snapshot as an optimistic guard. Supply `--repo-id` and a repo-relative
`--path` to select a directory, or `--clear` to remove the selection. The named
resource must already be declared, but it may be unbound on this Station;
configuration never clones, binds, or grants compute. An unchanged request is
idempotent and does not advance the identity timestamp.
