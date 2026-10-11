# @kontourai/station-cli

Station is Kontour's local-first agent workspace. It keeps execution history
and configured workflow evidence beside the work, on your laptop, a home
server, or another machine you connect to. A completed run is not a passed gate.

This package is the **client** CLI for those Stations. It is a terminal front end
for Stations that are already running: chat with agents, read and interrupt
sessions, and manage projects, tasks, and skills over HTTP. It also supports
selected host-local operations against an
existing installation. Building and installing a backend remain checkout
operations; see [What this CLI does not do](#what-this-cli-does-not-do).

## Availability

`@kontourai/station-cli` is published on npm. Check the live version and
available dist-tags before scripting an install:

```bash
npm view @kontourai/station-cli version dist-tags
```

Run the published stable client with `npx`:

```bash
npx @kontourai/station-cli@latest --help
```

`npx` resolves and caches the published version per invocation. For
latency-sensitive or scripted use, an explicit global install pins one version
instead: `npm install -g @kontourai/station-cli@<version-or-published-tag>`.
Use a channel tag only after `npm view` reports it.

The examples below use `station` for a globally installed command. With `npx`,
keep the `npx @kontourai/station-cli@latest` prefix on subsequent commands too.

**Inside a Station checkout**, `./station` runs that tree's TypeScript sources
— this is the local-invocation path when the registry isn't the point (working
on the CLI itself, or a channel tag you don't want to depend on):

```bash
./station <command> [args]
```

The separate `station-dev` shim runs the checkout's built CLI bundle and
checks its source timestamps for obvious staleness. That check is approximate;
`./station` does not use it. See [the CLI reference](https://github.com/kontourai/station/blob/main/docs/reference/cli.md#invocation)
for the entry-point and build boundaries.

`station --version` reports the CLI version. Bundles also report their stamped
build channel and source revision; the source launcher reports
`development source checkout` without a revision.

## Connect to a Station

Choose a Station you can reach. Setup saves it on this device, performs pairing
when needed, and deliberately selects the default Station.

```bash
npx @kontourai/station-cli@latest setup existing box-b https://box-b.tailnet.ts.net --pair
# or select the configured hosted endpoint
npx @kontourai/station-cli@latest setup hosted
```

`setup hosted` pairs with the fixed endpoint `https://station.kontourai.io`.
That command's existence does not establish service availability or your access
to it. Use `setup existing` for an endpoint you choose.

The CLI registers a device request and waits. An operator approves it **on the
host** (`station environment access approve <request-id>` there, with the
existing Station home selected). When they do,
the CLI stores the issued bearer credential in the operating-system keyring and
saves only its reference with the Station entry. That Station becomes the
default only after pairing succeeds.

That is the whole point of pairing: from then on, nothing needs a flag.

```bash
station agents list
station chat my-agent 'what changed today?'
```

From a Station checkout, local setup installs its durable per-user service and
then selects the conventional `kontour` Station:

```bash
./station setup local
```

## Saved Stations

These are the Stations this device can reach. Forgetting one only removes its
local entry and credential reference; it does not stop or delete the Station.
They are separate from the Environment where an Agent executes and the engine
that runs it.

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
```

```console
$ station stations list
  NAME     ENDPOINT                        CREDENTIAL
* box-b    https://box-b.tailnet.ts.net    available
  kontour  http://127.0.0.1:<channel-port> not-configured

* = default Station.
```

Commands using the shared target resolver select a Station in this order:

| | Source | Example |
|---|---|---|
| 1 | `--api-base=<origin>` | one direct bootstrap/diagnostic request |
| 2 | `--station=<name>` | `station chat --station=box-b` |
| 3 | `STATION_TARGET` | `STATION_TARGET=kontour station agents list` |
| 4 | Project Station selection | owner-controlled mapping set by `station stations project use` |
| 5 | Explicit default Station | set by setup or `station stations use` |
| 6 | Active local Station | owner-safe local service record |
| 7 | Loopback fallback | the selected channel's runtime-resolver server port (or `STATION_PORT`) |

## Guided triage

`station triage [--context-only] [--agent=codex|claude] [--problem=<text>] [--search-issues]` writes a bounded,
owner-only diagnostic hand-off under `$STATION_ROOT/cache/triage/<uuid>`.
It contains redacted schema-v1 JSON, a readable summary, and Station's
versioned read-only playbook. With an existing credential it uses the
authenticated diagnostics-bundle seam, retaining only bounded allowlisted app,
doctor, and log-tail facts; it never persists bearer values or bundle config.
It never reads local-grant or pairing secrets, databases, arbitrary environment
data, or full logs.

Use `--context-only` when you want artifacts without agent probing or launch;
the same read-only source and authenticated remote facts are still collected.
Otherwise Station starts only Codex with approval disabled, its read-only
sandbox, an ephemeral session, and user config ignored, or Claude in safe plan
mode with only Read/Glob/Grep tools, using argv arrays and a run-local prompt
file. With both available,
select one explicitly. No available agent still
leaves portable artifacts successfully. The bundled triage command does not
collect local host filesystem diagnostics or run the source-only doctor report.
`--search-issues` (or the equivalent TTY confirmation) authorizes a fixed,
read-only Station issue search. Launching an agent separately makes the run files
available to that agent and its configured model service; use `--context-only`
to collect without launching one. The first 64 KiB of agent stdout is re-redacted
into local `diagnosis.md` and `issue-draft.md`, including after an unsuccessful
exit. Live stdout is forwarded before redaction and stderr is inherited directly.
Stored-artifact redaction does not protect terminal output. Triage has no GitHub
write or repair operation; its mode flags are requests to the installed agent,
not independent proof of that agent's enforcement.

The versioned store lives at `$STATION_ROOT/config/profiles.json` (default
`~/.station/config/profiles.json`) and is shared with native Desktop. It
never contains bearer material. A missing or unavailable OS credential store
fails closed; Station does not create a plaintext fallback. `station target`
shows the selected Station, endpoint, Environment association, credential
state, reachability, and applicable local-service state without starting or
substituting another Station.

Use `--pair` while adding or editing, or `station stations pair <name>`, to
authenticate a named Station through host approval. Plain add/edit intentionally
creates or updates only endpoint metadata and reports that no credential is
configured. Pairing does not replace an existing endpoint binding unless the
edit action or `--force` explicitly authorizes it.

Project selection is explicit and secret-free. `station stations project use`
records the canonical invoked directory and selected Station in the
owner-controlled shared store; repository files cannot redirect the target.
The selection names a saved Station and never embeds an endpoint or credential.

SDK-backed requests give up after 30 seconds. Override with
`STATION_REQUEST_TIMEOUT_MS=<ms>`, or `0` to disable the deadline. Streams —
orchestration and approval events and live monitoring — have no overall
deadline. Chat sends a bounded JSON acceptance request, then observes the turn
on a separate event stream. Knowledge reindexing and migration also opt out of
the request deadline. The current checkpoint-restore and Operate event-stream
paths bypass the shared credential client and cannot authenticate to a protected
Station; see the reference.

## What this CLI does not do

**It does not build or install a backend.** Source-oriented commands such as
`build`, `dev`, `fresh`, `home`, `link`, `shortcut`, `start`, `stop`, and
`upgrade`, plus `setup local` and service installation, require a Station
repository checkout, not this published CLI. (A prebuilt server archive that
`install.sh` installed carries its own lifecycle CLI, which can also install a
service and run `upgrade`; see the reference.) Use the checkout's launcher:

```console
$ station start
Error: `station start` runs against a Station repository checkout, so it is not part of the published CLI.
Run it from the root of a Station checkout with the bundled launcher:
    ./station start
The published CLI drives Stations that are already running — see `station stations` and `--api-base`.
```

**Selected local operations are available in the published CLI.** `open`,
`doctor`, `environment show`, `environment credential show`, `environment offer`,
`environment access list|approve|deny|devices|scope|revoke|remove`, `environment operator passkeys`, and `service status|start|stop` support
an existing local installation. Local authorization validates the selected
owner-only home and the loopback listener; it does not create a missing home.
Service start/stop controls an existing OS service rather than building or
installing a backend. See the [availability table](../../docs/reference/cli.md)
for the full boundary and prerequisites.

`environment peers`, `environment credential rotate`, and `environment reset`
remain checkout-only. `station environment access request` is the requester
side of pairing and works as a remote client operation.

The packaged CLI never creates or starts a backend implicitly. A bare invocation (including `--inline`,
`--service`, and `--temp-home`) explains how to pair with an existing host or
how to use `./station` from a checkout. The command admission authority is
[distribution.ts](src/distribution.ts); command behavior is composed in
[cli.ts](src/cli.ts). This distribution distinction also appears in the
[architecture reading path](../../docs/architecture.md#reading-path).

`station --version` reports immutable bundle metadata: the CLI version, its
build channel, and the source revision stamped when that artifact was built.
It does not inspect a nearby checkout or a backend build manifest. Invoking
`./station --version` reports `development source checkout`, independent of
`STATION_CHANNEL`; it does not print a source SHA. A locally built bundle has
its own build-time provenance, including a dirty revision when applicable.

The package test packs one exact tarball, records its SHA-256, then installs
that same tarball into an isolated consumer with `npm install --ignore-scripts`.
This proves dependency resolution without claiming publication or
native-keyring behavior. Windows and physical native-keyring verification are
**NOT_VERIFIED** until exercised on those platforms.

`station --help` includes a checkout-command note. That note currently lists
`service` as a whole; the supported packaged exceptions are
`service status|start|stop`, as described above.

## Requirements

- **Node 24** (`engines: 24.x`). The CLI is a bundle, not a binary; it needs a
  host Node.
- **A reachable Station for API commands.** With no Station saved, API commands
  use a running local desktop Station when available, then fall back to the
  selected channel's runtime-resolver loopback origin. Saved-Station management,
  local diagnostics, and existing-service control also use host-local storage
  or operating-system services; they are not all HTTP calls.

Transport failures name the Station that was targeted *and where that address
came from*, so a wrong-target mistake never looks like a broken Station:

```console
$ station agents list
Error: Can't resolve the host in https://box-b.tailnet.ts.net (default Station "box-b"). Check the address or inspect it with `station target --station=box-b`.
```

## Getting the full reference

```bash
station --help                 # grouped, one line per command
station <command> --help       # actions and flags for one command
station --version
```

`--help` is recognised at any depth, and per-command help carries the flag
detail. Unknown commands and actions fail with a diagnostic. Flag validation
belongs to each command; use the documented spelling, including
`--model-option=key=value` rather than a space-separated value.

The prose reference and availability table ship with the Station repository as
`docs/reference/cli.md`. Its implementation links and stated limits distinguish
current behavior from commands that need further qualification.

## Related packages

- [`@kontourai/station-sdk`](https://www.npmjs.com/package/@kontourai/station-sdk)
  — build a Station plugin: UI components, hooks, and typed host API access.
- [`@kontourai/station-shared`](https://www.npmjs.com/package/@kontourai/station-shared)
  — `buildPlugin`, manifest parsing, and the other runtime helpers.
- [`@kontourai/station-contracts`](https://www.npmjs.com/package/@kontourai/station-contracts)
  — the TypeScript contracts those packages are typed against.

## License

Apache-2.0, the same licence as the rest of the `@kontourai/station-*` family.
