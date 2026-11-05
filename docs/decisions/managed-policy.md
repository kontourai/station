---
status: current
subject: A machine-level managed policy that Station loads at startup and fails closed on
decided: 2026-11-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4515
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4516
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4521
---

# Managed policy

An organization's IT administrator needs to control Station on every managed
machine. Station adds one administrator-owned configuration tier, the
**managed policy**. The administrator installs it on a machine, and every
Station server on that machine loads it at startup and enforces it for every
client that connects. The [administrator guide](../guides/managed-policy.md)
covers rollout. This record holds the decisions.

## Scope and precedence

The policy covers the machine where it is installed: every Station home and
instance on that machine. Clients that connect to that server inherit its
enforcement. A policy on one machine does not govern a server on another.

Precedence for a setting, highest first: managed lock > project > Station >
environment > managed default > built-in default. A managed default sits below
the user's own choices; a lock sits above all of them. Station never writes
policy values into user configuration, so removing the policy restores the
user's values.

The policy only narrows. Operator and instance policy, including the Cedar
operator restrictions (#3733) and `registryTrust`, can narrow it further, and
nothing widens it. A policy permit never grants authority that an existing
mandatory check denies.

The policy is not a sandbox. It controls what Station does. Engine CLIs keep
their own configuration, and a local administrator can remove the policy or
replace the binary.

## Fail closed

Station refuses to start when it cannot enforce the installed policy. That
covers a file it cannot read, a directory at the policy path, invalid JSON, a
schema mismatch, a wrong `schemaVersion`, an unknown key, and more than one
installed source. It also covers a symbolic link at the policy path, a file or
parent directory that someone other than root can change, and a document that
repeats a key name. The error starts with `STATION_MANAGED_POLICY_INVALID` and
names the source and the reason. The error is one line of bounded length: a
quoted key name longer than 64 characters is truncated, and the location and
reason are capped, so a hostile document cannot push the marker out of the
desktop sidecar's 64 KiB stderr capture. The sidecar also latches the first
line carrying a fatal marker while it reads stderr, not only from the tail it
keeps. The desktop sidecar treats that marker as
unrecoverable and does not retry, and the CLI reports the line after a failed
start. A missing file means no policy, and Station behaves as it does without
one.

**Each key may appear once.** `JSON.parse` keeps the last of two equal member
names, so `"limits": {...}, "limits": {}` would silently erase the first
restriction. Station rejects a repeated member name in any object, comparing
names after unescaping, before it builds the document. The error is
`duplicate key <path>`.

**Unknown keys are refused at every level.** A key this build does not know
may be a restriction from a newer release. Ignoring it would leave the machine
looking managed while that restriction is not enforced.

**Keys that later slices own are refused until their enforcement lands.**
Version 1 reserves `settings` (managed defaults and locks, #4517) and `limits`
(#4518–#4522). This build accepts `settings` only as an empty object, and in
`limits` only the [capability switches](#capability-switches) (#4521). Any
setting entry or other limit key gets a "not supported by this version of
Station" error. If Station accepted a key before it enforced that key, the
administrator would see the machine as managed while nothing was managed. Each
enforcement slice adds its key to the parser in the same change that enforces
it.

## Sources

There is one file source per OS, at a fixed path:

| OS | Path |
| --- | --- |
| macOS | `/Library/Application Support/Station/policy.json` |
| Windows | `C:\Program Files\Station\policy.json` |
| Linux and other Unix | `/etc/station/policy.json` |

The paths are literals. Station does not expand `%ProgramFiles%` or use
`%ProgramData%`, because a user can redirect an environment variable, or create
a `ProgramData` folder first and own it. Either would let the user choose the
policy.

**Only an absent entry means no policy.** Station checks the path with `lstat`.
`ENOENT` is the only "no policy" answer. A symbolic link (or, on Windows, a
link or junction that `lstat` reports as one) is an error, even when it
dangles, and is never followed: a dangling link would otherwise read as absence
and let the test override stand in, and a link to a user's file would load the
user's document. On POSIX the file is opened with `O_NOFOLLOW` and
`O_NONBLOCK`. The file checks run on that descriptor: `fstat` must report a
regular file (so a FIFO or a device is refused instead of hanging startup), and
it must be the same file `lstat` saw. The directory chain below is checked by
path, which is safe because every directory in it must be root's.

**System files must be root's.** For the system sources (not the test override
and not `station policy check`), the file and every directory above it up to
`/` must be owned by root (uid 0) and must not be writable by their group or by
other users. Otherwise Station refuses to start and names the offending path. The
group itself is not checked: a stock Mac has `/Library` as root:wheel 0755 and
`/Library/Application Support` as root:admin 0755, and both pass. A symbolic
link among the parent directories must be owned by root, and the directories it
leads to are checked as well. On NixOS, install the file with a copy mode
instead of the default store link.

The check reads owner and mode bits only, not ACLs. On Linux a POSIX ACL that
grants write sets the group-write bit through the mask, so it is refused; on
macOS an `allow write` ACL entry is not detected. The rule guards against
substituting the file, not removing it: when no file exists, Station does not
inspect the folders, because refusing to start on an unmanaged machine over a
loosened `/Library/Application Support` would break users who have no policy.
Anyone who can write the policy folder can delete the policy, so administrators
must keep that folder writable by root only. `station policy check` applies the
ownership rule only when it is given the system path itself.

Windows: Station rejects a link at the file, but it does not yet check the
owner or ACL of the file and its folders. That check, and the reparse point
types Node does not report as links, are a follow-up in #4524.

Sources implement one interface. A source reports "no policy", returns raw
input (JSON text or an already-decoded value), or throws the fail-closed error.
The macOS configuration profile (#4523) and the Windows registry (#4524) join
the system source list. More than one source with a policy is an error: Station
cannot tell which one the administrator meant, and merging them could weaken
either.

## Fingerprint and client summary

The fingerprint is `sha256:` followed by the SHA-256 of the canonical document
(keys sorted, no whitespace). Reformatting the file does not change it; changing
a value does. The server records the fingerprint of the policy it loaded and
reports it at `GET /api/settings/managed-policy`, together with the source and a
value-free summary: organization, support link, locked setting paths and
effective limits. The summary never contains a setting value or a secret. The
route belongs to the `/api/settings` family and needs the same credential as
the settings registry. `station policy show` compares this fingerprint with
the installed policy's to report whether a restart is needed.

The policy must not hold credentials: every user on the machine can read it.
The parser refuses a support link that contains a user name or password.

## Test-only injection

Isolated instances and tests inject a policy through
`STATION_MANAGED_POLICY_TEST_FILE`, an absolute path to a policy file. The rule:

- Station reads every system source first. An invalid system policy still fails
  closed, whether or not the override is set.
- If any system source holds a policy, a set override is a startup error that
  names the installed source. The override never replaces or hides an
  installed policy.
- If no system source holds a policy, the override is loaded like a system
  file, reported with source kind `test-override`, and a missing override file
  is an error.

A user who sets the variable on a managed machine can only stop their own
Station from starting. On an unmanaged machine there is no administrator
policy to escape, and a policy only narrows what Station does. Station refuses
the conflict instead of quietly preferring the system policy, so a test run on
a managed machine fails with a clear message instead of testing a different
policy. The unit tests in `packages/shared/src/__tests__/managed-policy.test.ts`
cover each branch. The startup tests in
`src-server/__tests__/managed-policy-startup.process.test.ts` use the override
to run the real server entrypoint.

## Capability switches

`limits.telemetry`, `limits.webhookAutomations` and `limits.registries` (#4521)
turn a capability off. The parser accepts only `false` for each switch, and
refuses `true` with a problem that says so, because a policy can never force a
capability on. Each enforcement seam reads the switches through
`src-server/security/managed-capability-limits.ts`, which `main()` installs
from the loaded policy before the runtime is built, and refuses with one
sentence (`managedPolicyDenial`) and the error code
`managed-policy-capability-disabled` (`permission_denied`).

**Limits are rebuilt from every slice.** The parsed document, the client
summary and the status decode each rebuild `limits` by merging every entry in
`MANAGED_POLICY_LIMIT_SLICES`, rather than from one slice's own fields. A
later slice adds itself to that list, and a round-trip test that sets every
enforced key fails when a key is missing from any of the three, so merging two
slices cannot silently drop a restriction.

**Telemetry is off at the publisher, not at the setting.** The usage resolver
(`resolveTelemetryConfiguration`) gives every publisher tier `off` with reason
`managed`, which outranks the saved choice, the environment and Do Not Track.
Like Do Not Track, it forbids the tier-lowered feedback that a user's own
"off" still allows. The connection checks and any `PUT /config/app` that
raises a sharing choice are refused; a choice that keeps or lowers is saved,
because it changes nothing that is sent. The product delivery status carries
the same sentence, so clients disable the connection check rather than send a
request that will be refused. The OpenTelemetry bootstrap runs when
`telemetry.ts` is imported, before `main()`, so it reads the policy itself.
Both read one memoized load (`managed-policy-boot.ts`), so the bootstrap and
the startup check cannot see different policies. When that load fails, the
bootstrap registers nothing and `main()` refuses to start.

**The embedded agent framework's own export is off too.** VoltAgent reads
`VOLTAGENT_PUBLIC_KEY` and `VOLTAGENT_SECRET_KEY` itself and, once it has a
client, its default observability exports traces and logs to the vendor's
service. Under the limit, Station registers VoltAgent observability that keeps
the local trace store and live stream but has no remote processor
(`voltagent-observability.ts`). It does this before the first agent is
created, because an agent with no global observability builds the
remote-exporting default for itself.

**What the switch does not cover.** The Kontour Console bridge (session and run
events to an operator-configured hub or workspace files), private usage
storage (a person's usage pages in the operator's own companion, after that
person's custody is set up), and the telemetry of engine programs Station runs
keep their own settings. The first two go only where an operator sends them;
an engine program follows its own configuration. The administrator guide says
so.

**Managed telemetry settings stay refused.** #4517 refuses `telemetryTier`,
the telemetry endpoints and their key references in `settings`. Their readers
(the OTel bootstrap, the publisher resolver) do not see the managed settings
overlay, and a managed `full` tier or endpoint would force telemetry on, which
this record forbids. `limits.telemetry: false` covers the only safe direction.

**Webhook automations are refused before anything is read.** The inbound
route answers `403` before it reads the configuration file, the body or the
limiter, so no state in the file can re-enable it. Station never writes that
file, so the tokens are kept and remain the operator's to edit or delete. The
webhook turn starter refuses too, for any other caller, and the integration
status reports the policy (state `unsupported`, an existing state, so older
clients still parse it) instead of the file's own switch. Automations with a
`github-webhook` source have no inbound receiver in this build, so there is
nothing for the switch to stop there yet.

**Registry limits only narrow the host's own trust.**

- `allowedUrls` is checked where every marketplace is listed
  (`RegistrySourceManager`), so a refused source reads as disabled to every
  reader (catalog, refresh, install) and cannot be added or enabled. Every
  other reader of the registered plugin registries (update checks, dependency
  resolution, previews, lifecycle lookups) gets them through
  `getPluginRegistryProviders()`, which leaves refused ones out. The
  name-based resolver sees them only to say why nothing matched.
- Tool-server (MCP) catalogs follow the same list: the configured MCP
  subregistry outside it reports the policy sentence and is never fetched, and
  a registry manifest's `tools` outside it are not listed or installed.
  Station's bundled curation is always allowed.
- Every entry must be `https`. A registry read over http can be altered in
  transit, so a policy cannot vouch for one; the parser refuses it at load.
- A manifest read follows redirects itself (`registry-fetch.ts`) and checks
  each hop before requesting it. It never goes from https to http, with or
  without a policy. Under `allowedUrls` a hop to the same origin is followed,
  because that origin already serves the listed URL and could serve the same
  bytes there, and a hop to any other origin must itself be listed. A check
  on the final URL alone would come after the unlisted host was contacted.
- Locations compare as normalized URLs (`github:o/r` reads as
  `https://github.com/o/r`), never as substrings.
- Station's bundled catalog ships with the install and is always allowed. A
  local folder is not a listed URL, so it is refused: a local catalog can
  still name remote package sources.
- `unsignedPackages: false` requires a signer from the host's own
  `registryTrust` on every registry plugin install. The policy adds no key, so
  without a trust profile for the registry there is no signer and the install
  is refused. When the registry's claim carries no signature, the refusal
  comes before any package bytes are fetched. A signed claim is verified after
  the fetch, because the signature covers the package bytes. The refusal is
  the managed `403` (`managed-policy-capability-disabled`, reason
  `managed-signature-required`), like every other managed refusal, rather than
  the `409` of a host trust refusal.
- A skill cannot carry a signature, so every skill marketplace but the bundled
  one is refused. A tool-server definition cannot either, so under
  `unsignedPackages: false` no tool server comes from a catalog but Station's
  bundled curation. Refusing them was chosen over documenting the limit as
  plugins-and-skills only: an unsigned definition names an endpoint the
  organization has not vouched for.
- `defaultSkillRegistries: false` skips the built-in skill registries at
  startup, alongside `disableDefaultSkillRegistries`.
- `acpRegistryInstalls: false` refuses `POST /acp/registry/:id/install` for
  public-registry entries; Station's own engine entries remain.

**Not covered.** Already installed code keeps running, and retained recovery
of an installed plugin is not a new acquisition. Installing a plugin or skill
straight from a source rather than through a registry is not governed by
`limits.registries`; a source allow list would be a separate limit.

## Engines

`limits.engines` (#4520) is the engine slice. It lives in its own contract
module (`@kontourai/station-contracts/managed-policy-engines`), registered as
one entry in the limit-slice list, so the parsed document, the summary and
the status decode all rebuild it the same way.

**Engine ids.** The policy names the built-in adapters' provider ids
(`claude`, `codex`, `muse`, `acp`, `station-agent`). The contract keeps the
list statically, because the parser runs in clients and the CLI where no
adapter is registered. Station's own agent is the provider `station-agent` and
the engine `station`; the server maps the second to the first. A plugin
engine's id is never on the list, so an allow list turns plugin engines off:
an administrator who lists engines has said which ones run.

**Disallowed engines.** One predicate, read at four seams:

- `assertAdapterReady`, which every engine start (new, recovered, child work)
  crosses before the adapter is asked;
- the `sendTurn` dispatch, before an engine is restored for the thread;
- runtime connection saves (`ConnectionService.saveConnection`) and ACP
  connection create and registry install;
- connection readiness, which reports the engine as disabled.

The refusal is a `SendTurnRefusedError` with code
`managed-policy-engine-refused` (`permission_denied`, not retryable), so the
dispatch records the command as `rejected`, forwards the code, and the chat,
continue, handoff and command routes answer `403`. A start refused this way
counts as rejected, not indeterminate. Threads are not deleted or rewritten:
removing the policy makes them runnable again.

`acpRegistryAgents: false` is narrower than `acp` off: a connection whose
config carries `publicRegistry` provenance does not run or get added. It does
not stop a user from adding the same command as a custom connection; pinning
`instances.acp` is how an administrator controls the ACP command.

**Pinned launch fields.** Every engine spawn passes its launch through one
function, `managedEngineLaunch`, at the spawn site itself, so no caller can
skip it:

| Engine | Spawn site | Binary |
| --- | --- | --- |
| Codex | `spawnCodexProcess` | replaced before `cliInvocation` |
| Muse | `createMuseProcess` (`muse exec`) and `createMuseServeHost` (`muse serve`) | replaced |
| ACP | `ACPProcess.start` (sessions, availability probes, sign-in) and the OpenCode model listing | a locked pin replaces the connection's command |
| Claude | `createClaudeEngineProcess` (sessions, adoption, model discovery) | handed to the Agent SDK as `pathToClaudeCodeExecutable` |

Claude is different because the Agent SDK chooses the command: a native
executable runs directly, a `.js` one runs under Node. So the pinned program
goes in through `resolveClaudeExecutable` (reason `managed-pin`, with no
version comparison), and the spawn checks that the launch runs it. A launch
that does not (the SDK's bundled copy, because the pinned path is missing or
cannot be spawned) is refused, rather than starting a program the policy did
not choose.

Whose a field is decides what `locked: false` means. Claude, Codex and Muse
have no user-chosen program or arguments, so their pinned program is always
used and pinned arguments follow Station's own. An ACP connection names its
own command and arguments, so a locked pin replaces them and an unlocked one
fills only an empty argument list. Environment is keyed per variable: locked
overrides every layer, unlocked fills only an unset variable.

A locked `environment` also stops the connection's own `env`, `configHome`
and model-proxy route from being applied (`connectionSpawnEnv`,
`engineProxyLaunch`). Each of those points the engine at configuration or an
endpoint the user chose, so merging them under the administrator's variables
would leave a variable the administrator did not pin in the user's hands.

`binaryPath` must be absolute. A bare name is looked up on a `PATH` the user
controls, which is the wrapper gap a pin exists to close; accepting it would
make a locked program mean less than it says.

**Runtimes that bypass the pins.** A plugin adapter normally replaces the
built-in adapter for its provider id. While an engine's entry is locked,
`getProviderAdapters` keeps the built-in one, because a plugin runtime has no
obligation to call `managedEngineLaunch`. The Claude bundled-copy fallback
above is the other bypass, and is refused at the spawn.

**Client summary.** Launch arguments and environment values can carry a
gateway address or token, and the summary reaches every paired device. So,
like `lockedSettings`, the summary's `engines` names what is managed (allowed
engines, whether ACP registry agents may run, and per pinned engine whether it
is locked, which fields and which variable names) and carries no value. The
summary's `limits` omits `engines`, and the status decode refuses one that
carries it. The UI decodes this through the light engines module only, never
the full `managed-policy` module, to stay inside the UI bundle budget.

**With an approval ceiling.** The ceiling (#4518) decides which mode Station
asks an engine for; it cannot stop a user from launching the engine
differently. A locked entry with an absolute `binaryPath` and a pinned
`environment` closes the three launch gaps the ceiling's guide lists: a
wrapper on `PATH`, a connection's environment and config folder, and an ACP
connection's command and arguments. It does not close the engine's default
config folder (pin `CLAUDE_CONFIG_DIR` or `CODEX_HOME`), the `PATH` the engine
uses for its own child programs (pin `PATH`), or Station's own environment.

**Not covered.** The Connections page's installed check for Claude, Codex and
Muse finds the program by name, because its prerequisite ids are derived from
the command; with only the pinned program installed it can report the engine
missing while chats run. Claude and Codex account sign-in
(`device-code-login.ts`, `browser-code-login.ts`) runs the program by name and
gets no pinned arguments or environment; it signs a person in and runs no
agent.

## Status of later slices

Settings, the remaining limits, the macOS profile, the Windows registry, and
`station policy templates` are tracked by #4517–#4524. Until each one lands, its
keys are refused, as described above.
