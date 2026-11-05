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
    ref: https://github.com/kontourai/station/issues/4517
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4521
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4519
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
the user's own choices; a lock sits above the project and Station values. Station never writes
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
Version 1 reserves `limits` (#4518–#4522). This build accepts in `limits` only
the [capability switches](#capability-switches) (#4521) and `clients` ([network
exposure](#network-exposure), #4519). Any other limit key gets a "not supported
by this version of Station" error. If Station accepted a key before it enforced
that key, the administrator would see the machine as managed while nothing was
managed. Each enforcement slice adds its key to the parser in the same change
that enforces it. `settings` entries are enforced since #4517; see [Managed
settings](#managed-settings).

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

## Managed settings

`settings` maps a setting key to `{ "value": …, "locked": true | false }`. A
lock fixes the value; a default (`locked: false`) applies where nothing closer
chose one, and users can change it (#4517).

**What can be managed.** A key is a registered Station setting
(`APP_SETTINGS_REGISTRY`), managed as a whole. Registry keys are top-level
fields, so a dotted path names a field inside one and is refused: a composite
setting's fields are validated and resolved together, and locking one field
would leave the rest to whoever writes next. The parser also refuses an unknown
key, a `secret` setting (every user on the machine can read the policy), an
internal or runtime-derived field (not a choice a person makes), and an
environment variable name (it names the setting that reads the variable
instead). It also refuses the telemetry settings (`telemetryTier`, the product
and OpenTelemetry endpoints and key references): the OpenTelemetry bootstrap
reads `config/app.json` itself before the policy loads, and the tier resolves
against environment variables, Do Not Track and operator policy outside the
settings registry, so a managed value there would be reported without being
in effect. Telemetry is managed through `limits` (#4521). Each value is
checked with the registry's own sanitizer, the one a settings write runs. `null` is accepted only for a setting that stores `null`
as a value, and a blank string is refused because Station reads it as unset.
The parser cannot see a composite's structure, so the server checks every
managed value against the settings file schema before it listens and refuses to
start, with the policy marker, when one does not match. `station policy check`
runs the same check (`managedSettingsSchemaError`, the same schema file bundled
into the CLI, the same AJV options and the same `appConfigSemanticError`
rules), so a policy it accepts is one startup accepts. The offline CLI readers
and writers load the installed policy through the same check.

**Device settings are out of scope.** Device settings live on each client, in
the browser or app that sets them, and the server that loads the policy never
sees or serves them. The server could not enforce a lock on one, so a device
setting key is refused with a message that says so.

**Precedence is applied once, where readers get the config.** Most server code
reads raw `AppConfig`, so `ConfigLoader` applies the managed values where it
hands one out, and `observeAppConfigFile` applies them for the plugin and
registry-trust observers. A lock replaces whatever is stored. A default fills a
key only when there is no Station decision (a value equal to a loader-written
seed is not one) and no environment value the setting's consumer accepts: the
registry's declared variable, or one the consumer reads itself
(`STATION_LOG_LEVEL` for `logLevel`; `SHELL`, or `COMSPEC` on Windows, for
`terminalShell`). A lock outranks those variables in the consumer too: the
logger holds the locked level, which beats `STATION_LOG_LEVEL` and is applied
to loggers created before the policy loaded.
`resolveEffectiveAppSetting` and `GET /config/app` provenance apply the same
rule and report `managed` only where the managed value is what readers get.
Provenance never carries the value; it names the organization and support link
so a row can explain itself.

**Policy values are never written.** The mutation path reads the stored file
raw, merges only what the caller changed, and refuses any change to a locked
key's stored value. A write of exactly the locked value is dropped as a no-op
rather than stored. Removing the policy and restarting therefore restores the
user's own values.

**Every write path refuses the same way.** The refusal is one sentence,
"<Organization>'s policy manages this setting.", followed by the support link.
`PUT /config/app` refuses with `403` and `code: managed_setting_locked` before
any other rule; the station-control `update_config` agent tool goes through that
route. `ConfigLoader.mutateAppConfig` and `saveAppConfig` refuse too, which
covers the log-level and first-run routes and every internal writer. The CLI
commands that write `config/app.json` directly (`config set --offline`,
`registry <url>`, `import`) load the installed policy themselves and refuse; an
installed policy they cannot load refuses the offline write.

**A lock outranks a project override.** A lock hides every project field
that would decide the setting past it (`MANAGED_SETTING_PROJECT_FIELDS`): the
model, provider and `last-used` model selection for `defaultModel` or
`defaultLLMProvider`, since New Chat fills a model from a provider alone; the
approval default and its `last-used` selection for `defaultApprovalMode`; and
the workspace isolation mode. Readers do not see those fields
(`FileStorageAdapter.getProject`, the project list, the workspace-isolation
reads that use the stored revision, and the responses of project create and
update). A write that sets one to a value is refused. A write that sends it as
unset (`null` or `''`), or resends the stored value, is dropped, so a project
form that saw the field hidden can still save other changes. The stored record
keeps the field, so it returns when the policy is removed.

**A lock does not cover narrower scopes.** This is a decided product scope,
not a gap to close in the settings layer. A lock fixes the Station-level value
and the project overrides. Values set on an Agent, a connection, a
conversation or a person's own account, which Station's resolvers apply before
the Station value, still apply. For `defaultApprovalMode`, a mode a person
picks for a conversation, an Agent's own default and a person's per-engine
default still apply; the hard approval bound is `limits.maxApprovalMode`
(#4518). For `region`, an Agent's region and then a model connection's region
still win. `MANAGED_SETTING_NARROWER_SCOPES` in
`@kontourai/station-contracts/managed-policy` lists every setting with such a
value, traced to the resolver that applies it. `station policy check` prints
that sentence under each locked setting, and the administrator guide lists the
same table. Bounding those values is the job of `limits`, not of a setting
lock.

Project refusals carry the same 403 body as `/config/app` (`code`, `key`, and
the organization's sentence with its support link), composed from the loaded
policy rather than from the caught message, which the project route redacts.

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

## Network exposure

`limits.clients` (#4519) lists the client kinds that may reach the machine's
servers: `desktop`, `local-browser` and `remote`. The
[guide](../guides/managed-policy.md#network-exposure) covers what
administrators see. These are the decisions behind it.

**Only `remote` can be left out.** The two local kinds are both loopback HTTP
clients holding a home-possession credential, minted by the desktop's
local-grant or by a `station open` link. Telling them apart reliably needs
its own design, so a list without `desktop` or `local-browser` is refused
("can only leave out `remote`") instead of being accepted and not enforced.
A status read from a server skips that rule, so an older client can read a
newer server's list.

**Two layers: the network and the credential.** Under the limit the
entrypoint binds a literal loopback address (`127.0.0.1` when `STATION_HOST`
is unset or `localhost`, and any other non-loopback `STATION_HOST` refuses
startup), and so do the voice and consent listeners, which receive the same
host. A name is never handed to `listen`: it is resolved again at bind
time, and a resolver can map `localhost` anywhere. Loopback alone is not enough:
Tailscale Serve, the relay connector and other tunnels all reach Station from
this machine. So `DevicePairingService` also runs with `localClientsOnly`:

- an offer is created only when its caller exchanges it with home possession
  (the local-grant and the same-machine launcher mint), and every exchange
  without that stamp is refused, so `POST /api/pairing/offers`, access
  requests, pairing-code requests and relay enrollment cannot mint;
- a device credential resolves only when it was minted with home possession.
  Ordinary devices, delegations, relay aliases and personal access tokens
  stop authenticating. They are compared all the same, so the lookup's timing
  does not reveal which devices are signed out;
- personal access tokens are not minted, and web and native push skip
  signed-out devices.

The operator credential is unchanged: it is read from the home, not paired.
Native device-proof admission is not composed under the limit, and a
telemetry producer allowed to send from off the machine is held to it.
Refusals carry `managed-policy-remote-clients`, which maps to
`permission_denied`.

**Suspended, not revoked.** Station never writes policy into user state, so
removing the policy restores the devices. That makes the limit a temporary
admission restriction, not incident response: a compromised device must still
be revoked. Device lists mark a suspended device with `suspended: { by:
"managed-policy", organization }`, separate from `revocation`, and the server
logs the suspended counts at startup. A restoration is not logged, since
nothing records an earlier run's limit and adding storage for one line was not
worth it.

**Every listener is admitted.** The startup check covers the ports known
before binding. Each listener opened later (the MCP Apps frame origin, the
browser egress proxy, SSH forwards, the telemetry companion's published
ports, the isolated repair relay) goes through one admission: a literal
loopback bind, then the Tailscale Serve check for its port, closing it if
refused. The entrypoint installs that admission before the runtime starts.
An ephemeral port is known only once bound, and the kernel completes
connections from then on, so a listener holds every request, upgrade and
CONNECT until admission succeeds; refused, it drops them and destroys every
socket it accepted (round 2: a request during a pending check had been
served). The telemetry companion is admitted again before every Start, not
only at installation, and its saved ports join the startup check, since a
running companion outlives Station.
The repair relay binds every interface without the limit, because a Docker
container reaches the host through Docker's host alias. Docker Desktop and
OrbStack forward the alias to the host's loopback, so under the limit the
relay binds `127.0.0.1` there. Docker on Linux maps it to the bridge gateway,
which loopback does not serve, so isolated repairs are refused on Linux under
the limit rather than bound to a network interface.

**The UI dev server is checked where it resolves.** `vite dev` takes `--host`
from its CLI, which overrides the config's loopback default, so a Vite plugin
checks the final resolved `server.host` and `preview.host`, and then the
address actually bound, against the installed policy. The bound port then
goes through the server's own admission, held as above, so a Serve route
(HTTP or TCP) to Vite's loopback port refuses it too.

**Startup refusals, not runtime switches.** The relay connector
(`STATION_BROKER_CONFIG_FILE`) is an opt-in to remote clients, so it refuses
startup instead of being silently dropped. So does a supervisor-held listener
bound to a non-loopback address: a later supervised generation serves on the
sockets it inherits, not the host it is configured with. Every refusal uses
the `STATION_MANAGED_POLICY_INVALID` marker: a restart cannot fix it, so the
desktop sidecar must not retry it.

**Tailscale Serve: refuse, do not turn routes off.** At startup Station reads
`tailscale status --json` and then `tailscale serve status --json`, and checks
the server, voice, consent and UI ports. It refuses to start while a route
targets one of them, naming the port and `tailscale serve reset`. Station
does not edit another program's configuration. Turning routes off would also
remove the user's other routes when a route's target is ambiguous, and the
administrator sees exactly what was found. A target that names a host counts
as a match, since the name can resolve to this server.

Station believes only a Tailscale CLI an ordinary user cannot stand in for.
A `tailscale` on `PATH` can be any user's script, and its absence from
`PATH` does not show that no daemon runs. So the check runs only a CLI at a
fixed system location the system owns, with a fixed, minimal environment:
the macOS app bundle, root-owned and accepted by `codesign` against Tailscale
Inc.'s team; a root-owned Linux binary whose whole directory chain passes the
policy file's own ownership check; or the Windows installer's path, whose
ACLs are not yet checked (#4524). `/Applications` is admin-group writable, so
on macOS the signature stands in for a root-owned chain. Homebrew's CLI is
user-owned and not trusted. Without a trusted CLI, "not installed" stands
only when nothing looks like Tailscale: no `tailscale` or `tailscaled` on
`PATH`, no daemon socket, no app bundle, no Tailscale process. Any of these,
or a process list that cannot be read, refuses startup and names what to
install or stop.

**The trusted CLI is re-verified, and speaks for one daemon.** A verified
CLI is reused by later admissions, so its identity (device, inode, size,
modification and change times, plus the macOS bundle's code-signing
manifest) is captured at verification and compared before every run; a
change re-runs the full trust check, signature included. What remains is the
moment between that comparison and the exec. Swapping the file in it needs
write access to the bundle or a root-owned bin folder, that is, a local
administrator, whom the limit does not defend against. The CLI answers for
the system daemon only, and a second `tailscaled` (a user's userspace one
with its own socket) could forward while it reports stopped. So any running
`tailscaled` that is not the system daemon refuses startup, by executable
path and the kernel's real uid: on macOS every `tailscaled`, since the app's
daemon is a system extension; on Linux one not owned by root or not at a
system path. launchd jobs are not listed separately: a loaded job that is
not running forwards nothing, and a running one is in the process list.
Windows is not inspected yet.

"Nothing forwards" is proven only by: no Tailscale at all (as above), a
trusted CLI's non-zero exit that says the daemon is not running, a backend state of `Stopped`,
`NoState`, `NeedsLogin` or `NeedsMachineAuth`, or a Serve configuration whose
every target is another port. A timeout, any other error, output that is not
JSON, an unknown backend state, or a Serve section this build does not know
is unverifiable, and Station refuses to start. Backend states are matched
with a `switch`, so a name such as `constructor` is never found on
`Object.prototype`. The check runs once at
startup. A route added later is not detected, but the credential layer still
refuses to pair or admit anything through it.

**The CLI checks the installed policy too.** `station environment offer
--tailscale` refuses before it runs `tailscale serve`, and an installed
policy it cannot load refuses as well. `station start` defaults its UI proxy
and server to `127.0.0.1` and refuses another `--host`. It also refuses a
non-loopback `STATION_HOST`, which it would otherwise replace with its own
host for the server child without a word. An unloadable policy is left to
the server, which reports it.

**No separate relay switch.** The issue asked whether `limits.relay: false`
is needed. Station's relay only lets remote devices in: relay enrollment
creates a device credential through the same pairing service, and relay
management needs the connector. Without `remote` it is already off, and with
`remote` there is no relay-only threat that `clients` cannot express. A
separate switch would be a second name for part of the same decision, so
there is none. If a later release offers a relay-only remote path, that is
the place to add one.

**Out of scope.** Port forwarding with other tools (`ssh -L`/`-R`, reverse
proxies, tunnel services such as ngrok or cloudflared) connects from loopback
and reads as local. A userspace `tailscaled` a user runs is the same class:
one under that name refuses startup, but a renamed copy is not detected. A
tunnel is not detected; the credential layer still refuses new pairing
through it and keeps earlier devices suspended. Inbound webhooks (`/api/webhooks/inbound`) carry their
own HMAC and grant authority, are not device authentication, and get their
own switch (#4521).

**Chat integrations are remote control.** The Discord gateway's connection is
outbound, but the relay connector's is too: direction does not decide whether
people off the machine drive Station. Discord messages become turns through
the same foreground seam as chat, so under the limit the gateway does not
start, and its status carries the managed sentence. Its configuration is
kept; it is the only such integration in this build.

## Status of later slices

The remaining limits, the macOS profile, the Windows registry, and
`station policy templates` are tracked by #4518–#4524. Until each one lands,
its keys are refused, as described above.
