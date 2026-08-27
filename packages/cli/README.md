# @kontourai/station-cli

Station is Kontour's local-first agent workspace: you direct agent work, and
the gate verdicts, evidence, and trust state stay in the same context as the
work. A Station is the process that holds all of that — on your laptop, a home
server, or another machine on your tailnet.

This package is the **client** CLI for those Stations. It is a terminal front end
for Stations that are already running: chat with agents, read and interrupt
sessions, drive projects, tasks, skills, and every other Station
surface, over HTTP. It does not run a Station itself — see
[What this CLI does not do](#what-this-cli-does-not-do).

## Availability

The `npx`/`npm install -g` forms below work once `@kontourai/station-cli` is
live on the npm registry (station#4536; check with `npm view
@kontourai/station-cli`) — until then they 404, and `./station` from a
Station checkout, further down this section, is the way to run the CLI.

Run the CLI with `npx`, pinned to the channel dist-tag matching the Station
you are operating — `nightly` for a Station Nightly host, `latest` for a
stable one:

```bash
npx @kontourai/station-cli@latest --help
npx @kontourai/station-cli@nightly --help
```

`npx` resolves and caches that exact published version per invocation, so the
channel tag is the whole story: no separate install/upgrade step, and no
ambiguity about which build is running. For latency-sensitive or scripted use,
an explicit global install pins one version instead of resolving on every
call: `npm install -g @kontourai/station-cli@<tag>`.

**Inside a Station checkout**, `./station` runs that tree's own build directly
— this is the local-invocation path when the registry isn't the point (working
on the CLI itself, or a channel tag you don't want to depend on):

```bash
./station <command> [args]
```

It refuses to run against a stale build rather than silently executing old
code — see [the CLI reference](https://github.com/kontourai/station/blob/main/docs/reference/cli.md#invocation)
for the freshness gate and the three-tier invocation story (`npx` / `./station`
/ the `station-dev` global dev shim).

Every invocation reports where it came from: `station --version` prints the
CLI version, its build channel, and the source revision the artifact was built
from, so a wrong-binary mistake is visible instead of guessed at.

## Sixty seconds to a working setup

Choose a Station you can reach. Setup saves it on this device, performs pairing
when needed, and deliberately selects the default Station.

```bash
npx @kontourai/station-cli@latest setup existing box-b https://box-b.tailnet.ts.net --pair
# or use Kontour's hosted Station
npx @kontourai/station-cli@latest setup hosted
```

The CLI registers a device request and waits. An operator approves it **on the
host** (`station environment access approve <request-id>` there). When they do,
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

Every command that talks to a Station resolves its target in this order:

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
leaves portable artifacts successfully. The bundled CLI does not inspect the
local host filesystem or run the source-only doctor report.
Problem text stays local unless `--search-issues` (or the equivalent TTY
confirmation) explicitly authorizes a fixed, read-only Station issue search.
Successful agent output is bounded and re-redacted into local `diagnosis.md`
and `issue-draft.md`; triage has no GitHub write or repair operation.

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

Requests give up after 30 seconds. Override with
`STATION_REQUEST_TIMEOUT_MS=<ms>`, or `0` to disable the deadline. Streams —
chat and session turns, orchestration and approval event streams, live
monitoring, knowledge reindexing — are deliberately exempt, because they are
open-ended by design.

## What this CLI does not do

**It does not run a Station.** These verbs act on a Station *repository
checkout* — building the app, starting or upgrading it, installing OS
services, putting the launcher on PATH:

`build` · `doctor` · `fresh` · `link` · `service` · `shortcut` · `start` ·
`upgrade`

They are not part of the published CLI. Run them from the root of a Station
checkout with its own launcher, which is where they have always lived:

```console
$ station start
Error: `station start` runs against a Station repository checkout, so it is not part of the published CLI.
Run it from the root of a Station checkout with the bundled launcher:
    ./station start
The published CLI drives Stations that are already running — see `station stations`, `station setup hosted`, and `--api-base`.
```

**Some `environment` verbs are host-local.** Identity, credential, and
device-approval commands read secrets that only exist on the machine running
the Station, so they answer from the host's own `./station` and nowhere else:
`environment show`, `environment credential`, `environment reset`, and
`environment offer`, and `environment access list|approve|deny`.

```console
$ station environment show
Error: Environment security commands require the Station repository launcher (./station).
```

`station environment access request` is the exception, and the one you want
here: it is the *requester* side of pairing, and it is a pure client.

The packaged CLI never starts, stops, builds, installs, or otherwise manages a
Station backend implicitly. A bare invocation (including `--inline`,
`--service`, and `--temp-home`) explains how to pair with an existing host or
how to use `./station` from a checkout. Host-side pairing offers and approvals
remain in that host's UI/checkout; the packaged client only requests access.

`station --version` reports immutable bundle metadata: the CLI version, its
build channel, and the source revision stamped when that artifact was built.
It does not inspect a nearby checkout or a backend build manifest. Local source
builds report the `development` channel (and a dirty revision when applicable),
independent of `STATION_CHANNEL`.

The package test packs one exact tarball, records its SHA-256, then installs
that same tarball into an isolated consumer with `npm install --ignore-scripts`.
This proves dependency resolution without claiming publication or
native-keyring behavior. Windows and physical native-keyring verification are
**NOT_VERIFIED** until exercised on those platforms.

`station --help` prints the same boundary in its closing note, so the printed
command list never claims a verb this CLI cannot run.

## Requirements

- **Node 24** (`engines: 24.x`). The CLI is a bundle, not a binary; it needs a
  host Node.
- **A reachable Station.** Everything this CLI does, apart from managing
  its own saved Stations and config, is an HTTP call to a Station server. With no
  Station saved, commands use a running local desktop Station when available,
then fall back to the selected channel's runtime-resolver loopback origin.

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
detail. Unknown input is always a failure, never a help request: the CLI exits
non-zero and names the nearest real command or action.

The full prose reference — every verb, every flag, and the complete tier
table — ships with the Station repository as `docs/reference/cli.md`.

## Related packages

- [`@kontourai/station-sdk`](https://www.npmjs.com/package/@kontourai/station-sdk)
  — build a Station plugin: UI components, hooks, and typed host API access.
- [`@kontourai/station-shared`](https://www.npmjs.com/package/@kontourai/station-shared)
  — `buildPlugin`, manifest parsing, and the other runtime helpers.
- [`@kontourai/station-contracts`](https://www.npmjs.com/package/@kontourai/station-contracts)
  — the TypeScript contracts those packages are typed against.

## License

Apache-2.0, the same licence as the rest of the `@kontourai/station-*` family.
