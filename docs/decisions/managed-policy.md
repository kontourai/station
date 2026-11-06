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
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4522
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4523
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4524
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4520
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4518
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

**A limit key is accepted only once its enforcement lands.**
Version 1 reserves `limits` (#4518–#4522), and this build enforces every
one of them: `maxApprovalMode` ([approval-mode
ceiling](#approval-mode-ceiling), #4518), the [capability
switches](#capability-switches) (#4521), `clients` ([network
exposure](#network-exposure), #4519), `updates` ([update
control](#update-control), #4522) and `engines` ([engines](#engines), #4520).
A limit key it does not know gets an "unknown limit" error. If Station
accepted a key before it enforced that key, the administrator would see the
machine as managed while nothing was managed, so each enforcement slice added
its key to the parser in the same change that enforced it. `settings` entries
are enforced since #4517; see [Managed settings](#managed-settings).

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

**Windows files must be the administrators'.** On Windows (#4524) the file,
its folder and every folder up to the drive must be owned by Administrators,
SYSTEM or TrustedInstaller, and no allow ACE may grant anyone else a right
that changes them. For the file and its folder that is any write right; for
the folders above, the rights that remove or re-permission what is below
(delete, delete child, write DAC, write owner, generic all). The rule reads
the owner and DACL through the Win32 API, converts them to SDDL and checks
them in TypeScript (`managed-policy-windows.ts`), so the rule itself is tested
on every OS against SDDL captured from a stock Windows 11 host. Inherit-only
ACEs are skipped, deny ACEs are ignored (the rule only asks whether anyone
else is granted a write right, which is conservative), an unrecognized right
counts as every right, and a DACL Station cannot parse fails closed. Every
entry in the path must also not be a reparse point
(`FILE_ATTRIBUTE_REPARSE_POINT`), which covers the reparse types Node's
`lstat` does not report as links.

Sources implement one interface. A source reports "no policy", returns raw
input (JSON text or an already-decoded value), or throws the fail-closed error.
On macOS the system sources are the file and the configuration profile; on
Windows, the file and the registry key. More than one source with a policy is
an error: Station cannot tell which one the administrator meant, and merging
them could weaken either.

**macOS configuration profile (#4523).** Station reads only
`/Library/Managed Preferences/io.kontourai.station.plist`, where a
System-scope profile lands. User-scope profiles (under
`/Library/Managed Preferences/<user>/`) are ignored: a user's own enrollment
could write them. The plist gets the file's checks (no link, regular file,
root-owned chain) on the opened descriptor, and the checked bytes go to
`/usr/bin/plutil -convert json` on stdin. plutil is called by absolute path,
with an empty environment and a timeout, so a PATH entry cannot answer for
it, and a failure (including plutil missing) fails closed. A converter was
chosen over a parser written for Station: plutil reads binary and XML
property lists, which is the format macOS writes, and it is part of the OS.
The result is raw kind `value`, decoded by the same parser as a file. Profile
metadata keys macOS writes beside the payload's keys are dropped by exact
name; the `Forced[0].mcx_preference_settings` wrapper is unwrapped only in
its exact single-entry form, so anything beside it reaches the parser and is
refused. A property list cannot hold `null`, so `station policy templates`
refuses to make a profile from a policy that uses one. plutil accepts two
equal keys in one dict and silently keeps one of them, so before conversion
every encoding it would read is scanned for a key repeated within one dict and
refused with `duplicate key <path>`, as a file is. An XML plist goes through a
strict tokenizer that refuses any markup it cannot read rather than skipping
it; a binary plist (what macOS writes) through its object table, refusing a
structure it cannot read. An object is its encoded bytes, found by
its offset, however many indices name it: each distinct container is
expanded once and each distinct key string decoded once. Each expansion
charges its references, and each first decode its string's bytes, against
the object area's size before reading them. Objects that do not overlap, as
plutil writes them (including a valid profile whose strings plutil shares),
stay within it; a file whose objects overlap so as to exceed it is refused.
So the references and key characters the scan reads together are at most
the object area's size; this bounds what is read, not how long it takes. The conversion
itself runs plutil with a 10-second timeout; a timeout refuses the profile. Any other encoding plutil reads (JSON, old-style
text) is not what macOS writes and is refused.

**Windows registry (#4524).** Station reads `HKLM\SOFTWARE\Policies\Kontour\Station`
in the 64-bit view (`KEY_WOW64_64KEY`) through the Win32 API in its own
process, never `reg.exe`, which an organization may block. There is no
fallback to `HKEY_CURRENT_USER` or another view a user can write;
`SOFTWARE\Policies` is shared by both views on current Windows (checked on the
test host: a `/reg:32` write is the same key). The key holds either one
`Policy` `REG_SZ` with the JSON document (raw kind `text`) or the template's
values (raw kind `value`); both is an error. The key and every key above it to
`HKLM\SOFTWARE` are checked like files, with the registry write rights
(set value, create subkey, create link, delete, write DAC, write owner). An
empty key is no policy, and its ACL is not consulted, as for an absent file.

**Native access is through koffi.** Node has no registry or security API, and
the reads must be synchronous because startup loads the policy before the
server is built. `koffi` (an FFI) was chosen over a native addon: it reaches
`advapi32` for the registry and the security descriptors with no compiled
Station code, and it ships each platform's binary as an optional
`@koromix/koffi-<os>-<arch>` package, the same model as the CLI's keyring
binding. Its build-from-source install hook is denied in the lifecycle
allowlist. The packages that read the policy (the server bundle, the
published CLI and `@kontourai/station-shared`) declare it, and both bundlers
keep it external, so the desktop and portable stagers carry it with the
server's runtime closure. It is loaded only on Windows. A Windows Station that
cannot load it cannot tell whether a policy is installed, so it refuses to
start.

### Group Policy template

One control table (`managed-policy-controls.ts`) drives both the registry
reader and the ADMX/ADML generator, so a template setting is always one the
reader maps. Each control names the limit key it writes. The template offers a
limit's controls only when the contract lists that key in
`MANAGED_POLICY_ENFORCED_LIMIT_KEYS`, and a test fails when an enforced key
has no control. Every planned limit is enforced now, so the template offers
every control. A control for a key a build does not enforce would fail
closed: the reader maps its value and the parser refuses the key.

**Disabled is defined per kind.** An "Allow …" capability switch writes
`REG_DWORD` 1 when Enabled and 0 when Disabled; Disabled writes the limit's
off value, Enabled leaves the capability to users exactly like Not
Configured. Every other setting writes its own state value (1/0), and
Disabled on it is a startup error. Group Policy deletes a Disabled policy's
element values, so without a state value Disabled would read as Not
Configured: "no restriction", which an administrator who disabled "Allowed
clients" did not ask for. Organization has no state value; Disabled deletes
it, and any other configured setting then fails for want of it.

Unknown value names and any subkey are refused, because they may be settings
of a newer template. Names compare without case, as the registry does. The
generated ADMX/ADML validate against the ADMX schema of [MS-GPREG] §7; the
schema files are test fixtures, with the two edits libxml2 needs recorded
beside them.

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

**Limits are rebuilt from every slice.** Each enforced limit is one entry in
`MANAGED_POLICY_LIMIT_SLICES`: its document problems, its accepted value and,
where clients see something else, its summary projection. The parsed document
and the client summary both rebuild `limits` by merging every entry, rather
than from one slice's own fields; `updates` is projected to `mirror` (see
[Update control](#update-control)) only when the summary is built, so the
parsed document keeps its `feedUrl`. The status decode reads the summary a
server sent with one reader per limit (`MANAGED_POLICY_SUMMARY_LIMIT_READERS`
in the registry-free `managed-policy-status` subpath), so the browser does not
carry the document checks and the settings registries. A reader checks the
value's shape, not every document rule: `clients` does not require the local
kinds there, since a newer server may enforce a list this build refuses in a
document. The readers' type requires one per summary key, and one round-trip
test sets every enforced key at once and fails when a key is missing from any
of the three, so merging two slices cannot silently drop a restriction.

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
policy file's own ownership check; or the Windows installer's path, held to
the policy file's Windows owner and ACL rule (#4524) for the program and every
folder above it. A CLI someone else could replace is untrusted, which with
Tailscale present refuses startup under `clients`. `/Applications` is admin-group writable, so
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

## Update control

`limits.updates` (#4522) has three optional keys: `mode` (`auto` or `off`),
`feedUrl` (a mirror) and `allowNightly`. The decisions:

**Each update surface enforces it where it runs.** There are four, Station's
own update paths: the server's core update routes and its own update
coordinator, `station upgrade`, the Station service launcher's download and
apply steps, and the desktop app updater. The launcher checks the policy on
every update or apply request, so a version staged before the policy was
installed is not applied under it. A nightly-numbered version or a nightly
runtime channel counts as nightly whatever ring the install state records,
and when the state records no ring, or a ring this build does not ship (only
stable, preview and nightly are recognized), and nothing marks it nightly,
`allowNightly: false` still refuses, because a missing or unknown field must
not pass a nightly refusal.
The server loads the policy at startup with the rest of the document.
`station upgrade` and the launcher are separate processes that run without
the server, so each reads the installed policy when it runs, and an installed
policy it cannot use refuses the update, as it refuses server startup.

**The desktop app reads the policy natively, not from the server.** The
updater must obey the policy when the bundled server is not running, and in
particular when the server refused to start because of the policy; asking the
server would then have no answer, and treating no answer as "no policy" would
update a machine whose administrator turned updates off. The desktop shell
(`src-desktop/src/managed_update_policy.rs`) reads the same fixed path and
repeats the server reader's steps (`readManagedPolicyFile` and
`managedPolicyDirectoryProblem` in `@kontourai/station-shared/managed-policy`):
a missing entry means no policy; a link (even a dangling one) or a directory
is refused at `lstat`; the file is opened without following a link and without
blocking, and the opened descriptor must be a regular file with the device and
inode `lstat` saw; on macOS and Linux the file and both its literal and its
resolved directory chains must be root's and not writable by group or others;
the read stops one byte past 1 MiB and refuses rather than truncates; a UTF-8
byte-order mark is dropped; a repeated key is unusable. It honors the test
override under the same rule as the server. Bytes that are not UTF-8 are
refused (the server substitutes U+FFFD). On Windows, where stable Rust exposes
no file index, the shell opens the file with `FILE_FLAG_OPEN_REPARSE_POINT` and
takes the identity from `GetFileInformationByHandle` (volume serial number and
file index, which Node reports there as device and inode). It opens the path a
second time the same way to stand in for the `lstat` identity, as libuv's own
`lstat` does. Both handles must name the same file, neither may be a reparse
point or a directory, and an identity Windows cannot report refuses the
policy. The shell reads the Windows owner and DACL from that open file handle,
then opens every directory up to the drive with read-control and read-attributes
access, without following reparse points. It requires Administrators, SYSTEM
or TrustedInstaller ownership, and applies the server's role-specific write
masks to effective allow ACEs, including object and callback entries. Inherit-only
entries are checked when their child is inspected; deny entries do not grant
access. Missing or unreadable descriptors refuse updates. This permits a mirror
from a trusted policy file while refusing an administrator-owned file beneath a
folder whose ACL was loosened. Registry/profile delivery remains conservative.
Windows execution evidence is separate from the source wiring and must qualify
these checks; full desktop updater and signed-artifact qualification remain
separate from descriptor and file-reader tests.

**Device management turns desktop updates off.** The shell reads only the
policy file; it does not parse a macOS configuration profile (#4523) or the
Windows Policies key (#4524), so it never holds a second reader that could
disagree with the server's. It checks only that one is present: `lstat` of
`/Library/Managed Preferences/io.kontourai.station.plist` (a link counts,
unfollowed), or `RegOpenKeyExW` on `HKLM\SOFTWARE\Policies\Kontour\Station`
in the 64-bit view. Either one present turns the shell's updates off, whatever
the file says (a file beside it is a startup error on the server), and any
error but "not found" counts as present. A mirror delivered through device
management therefore leaves desktop updates off rather than mirrored;
administrators route desktop updates to a mirror by installing the policy as
the file. The shell enforces only `limits.updates`:

- a policy it cannot use, a `schemaVersion` other than 1, or a
  `limits.updates` with an unknown key or a bad value turns updates **off**,
  because the shell cannot tell what the administrator allowed;
- a usable `limits.updates` applies even when another part of the document is
  something this build's server refuses. Otherwise the policy that stopped
  the server would also stop the approved update that can enforce it.

**A refusal stops before any network access.** `off`, and `allowNightly:
false` on a nightly install, refuse the check as well as the download and the
install: the server's check contacts nothing, its coordinator never checks or
downloads on its own, and the desktop updater stays disabled and starts no
check. Every server refusal carries `managed-policy-updates-refused`, mapped to
`permission_denied`. Nightly means the install's own channel or ring is
nightly. The policy governs Station's own update paths only. Running
`install.sh` or `install.ps1` by hand is replacing Station, and the policy does
not govern it: a policy cannot stop a user from replacing Station, and
application controls are the tool for that. `install.sh` follows a mirror only
through `STATION_INSTALL_MIRROR_URL`, which Station's own update paths set.

**A mirror reproduces the release download tree.** Station's update files all
live at `https://github.com/kontourai/station/releases/download/<tag>/<file>`
(the desktop feeds, the signed server manifests and the server archives), so
one rule maps each of them: `<feedUrl>/<tag>/<file>`
(`managedUpdateMirrorUrl` in `@kontourai/station-contracts/managed-policy`,
mirrored by the desktop shell and `install.sh`). A URL outside that tree is
refused instead of fetched from the default. The mapping keeps every signature
check: the signed server manifest is served unchanged and binds each archive's
size and SHA-256, and each desktop archive carries its own updater signature,
so a mirror may rewrite `latest.json`'s download URLs without re-signing. The
desktop updater refuses a download whose URL is not under `feedUrl`, and
`install.sh` maps each archive into the mirror. The feed
URL has no query or fragment, because paths are appended to it, and must be in
canonical form, so the text the administrator reviewed is the URL Station
fetches.

- The server check, `station upgrade` and the launcher read
  `portable-<ring>/station-portable-<ring>-manifest.json` from the mirror
  instead of the manifest the install recorded, and set
  `STATION_INSTALL_MIRROR_URL` for `install.sh`. `install.sh` then requires the
  manifest to come from the mirror, maps each archive into it, and refuses to
  download Node.js or take the authenticated GitHub path.
- A source checkout and a desktop bundle's server update compare against a git
  remote, which the mirror does not serve. Both are refused under a mirror;
  the desktop app updates a desktop bundle through its own updater instead.
- The Windows installer (`install.ps1`) cannot follow a mirror yet, so on
  Windows a mirrored `station upgrade` or launcher update is refused rather
  than fetched from the default.

**Under a mirror, every redirect stays on the mirror's origin.** Each hop for
a feed, a manifest or an archive must keep `feedUrl`'s scheme, host and port,
for at most five hops; any other redirect is refused. The server follows hops
by hand, `install.sh` turns off curl's own redirects and checks each hop, and
the desktop updater gives the plugin's HTTP client a custom redirect policy.
Same-origin rather than no redirects at all: the policy approves a server, a
hop within it reaches nothing the administrator did not approve, and a mirror
may well redirect within itself (a trailing slash, a versioned path). A
redirect to another host, which is how a mirror in front of a CDN or object
storage would hand off, is refused, so such a mirror must serve the bytes
itself. Without a mirror the default redirects through GitHub's asset host
are followed as before.

**The feed URL never reaches clients.** It may carry an access token in its
path, so the client summary reports `limits.updates` as `mode`, `allowNightly`
and `mirror: true | false`. The parser still refuses a user name or password in
it: every user on the machine can read the policy. The HTTP client puts
request URLs into its error text, so the desktop shell keeps only the scheme,
host and port of every URL in an update error before it reaches the window
state or a log, and drops the updater plugin's own log records (it logs raw
client errors at Error and request URLs at Debug).

## Engines

`limits.engines` (#4520) is the engine slice. It lives in its own contract
module (`@kontourai/station-contracts/managed-policy-engines`), registered as
one entry in the limit-slice list, so the parsed document and the summary
build it the same way as every other limit. The status decode
(`managed-policy-status`) parses its value-free summary, `summary.engines`,
with the engine module's own parser.

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

## Approval-mode ceiling

`limits.maxApprovalMode` (#4518) caps the broadest approval posture any run
may use, whoever starts it. The [guide](../guides/managed-policy.md#approval-mode-ceiling)
covers what administrators see. These are the decisions behind it.

**Order.** `ask` < `auto` < `never`, where `never` is full access
(`APPROVAL_MODE_BREADTH_ORDER` in `@kontourai/station-contracts/provider`).
It is the order the server's compare-and-set already ranked postures by
(`approval-posture.ts`, which now reads the same constant), and the order the
adapters map to: Claude `default` < `acceptEdits` < `bypassPermissions`,
Codex `untrusted` < `on-request` < `never` with `danger-full-access`. A
ceiling of `never` restricts nothing.

**`connection-default` is resolved, never ranked.** It is not accepted as a
ceiling. As a pick or a default it resolves to the posture it stands for (the
Agent's or Station's default), which is then compared. Where it would leave
the engine on its own settings, which Station cannot read and which can be
broader than any ceiling (a Claude settings `defaultMode`, a Codex
`approval_policy`), Station sends Ask instead, at every start and at a turn
on an engine this process applied nothing to. Ask, not the ceiling: the
engine's own default may be stricter, and the policy only narrows.

**A choice is refused; a default is lowered.** A pick (at a chat's start or
later) and a change of this Station's default above the ceiling are refused
with `managedApprovalCeilingDenial`, code `managed-policy-approval-ceiling`.
Lowering a pick would record a posture nobody chose. A default (Agent,
project, Station, a person's saved default, an automation rule's or a
delegation's carried mode) is lowered where it applies, so a new chat whose
default is above the ceiling starts at the ceiling. A default saved before the
policy is kept and resendable, so installing a policy does not break the
Settings page, and it applies in full again if the policy is removed. An
Agent's or project's `never` default is refused on write, by the full-access
rule below. For an Agent the rule reads its own default, not the inherited
one: writing an explicit `never` is refused even where it already inherits
`never` from this Station, a `never` it saved before the policy may be resent
unchanged, and clearing its own default to inherit a stored `never` is
allowed, because the inherited value is lowered where it applies.

A posture carried on a start's or turn's options (the default channel: a
client's default, the CLI's `--approval-mode`) is a default too, so a carried
`never` is lowered, not refused. A known ACP full-access mode id on the
options is not lowered by anything, so it is still refused.

A person's saved personal default is recorded on the new chat as its
decision (so later sessions keep it), marked `source: "personal-default"` on
the `session.approval-mode-set` event. It is recorded as it applies at that
moment, lowered to the ceiling (a `never` needs a grant nobody holds under a
ceiling). `ApprovalPosture.resolve` applies a marked decision as a default:
lowered to the ceiling in force at each start and turn, never refused. So a
later, tighter policy lowers that chat instead of stopping it for a pick
nobody made.

**A recorded pick above the ceiling stops the chat.** `ApprovalPosture.resolve`
reads the conversation's recorded decision at every start, restart and turn,
on every path that sends one. A concrete decision above the ceiling throws
`ManagedApprovalCeilingRefusedError` (a `SendTurnRefusedError`,
`permission_denied`) before the engine is touched. Lowering the mode records
a new decision, and the next turn proceeds.

**No full-access grant exists under a ceiling below `never`.**
`mayGrantFullAccess` returns false for everyone, the operator included, and
every `FullAccessGrant` is minted from it. No session starts or stands as
`host`, even with a `host` stamp or a `never` recorded before the policy: that
stamp would let Claude spawn holding the bypass grant. An "Auto-accept file
edits for this session" answer under a ceiling of `ask` is downgraded to a
single accept, as it is for a caller without `setApprovalMode` authority.

Everything else gated on that authority is closed too. A plugin-owned
Agent's `autoApprove` and `unattendedAutoApprove` grants cannot be added to
or widened while the ceiling is below `never`. Revoking needs no full-access
authority, with or without a ceiling: an empty list, `null`, or a subset of
the current grants (compared as exact patterns) is allowed under the normal
Agent mutation authority.

**One holder, installed by the entrypoint.** The ceiling is process state
(`security/managed-approval-ceiling.ts`), installed right after the policy
loads and before the runtime is built. The gates are reached from many
compositions; a holder none of them can be built without is harder to miss
than an option each must pass.

**A managed default above the ceiling is refused at load.** The parser
reads `settings.defaultApprovalMode.value` from the raw document and refuses a
concrete value broader than `maxApprovalMode`, locked or not, whatever the
settings parser accepts. A valid managed setting raises no other problem, so
that refusal is the one the administrator sees.

**A lock and the ceiling bound different things.** A lock on
`defaultApprovalMode` fixes the Station default and hides the project
override; the values it does not cover (see
[Managed settings](#managed-settings)) are lowered to the ceiling where they
apply. A project write that sets the approval default while it is locked is
refused as locked (`managed_setting_locked`) even when the value is also
above the ceiling: the lock accepts no value, so the ceiling's "the broadest
allowed is …" would name a value that is refused too.

### Gates

| Where a run's posture is chosen or changed | How |
| --- | --- |
| `POST /api/orchestration/commands` `setApprovalMode` | refused (route, then the decision writer) |
| A pick carried on `/chat`, `/chat/:id/continue` or a handoff | refused (route) |
| `OrchestrationService.recordApprovalModeDecision`, the one decision writer (agent tools, delegated picks) | refused |
| Every session start, restart and turn (`ApprovalPosture.resolve`) | a recorded pick above: refused; defaults and carried modes: lowered; nothing: Ask |
| Station default (`PUT /config/app`; read through `resolveStationDefaultApprovalMode`) | change refused; stored value lowered where it applies |
| Agent and project defaults | an explicit `never` refused on write (an Agent's own, whatever it inherits); lower values and inherited ones lowered where they apply |
| A posture carried on a start's or turn's options | lowered, `never` included; a known ACP full-access mode id refused |
| A person's saved default (`recordPersonalApprovalDefault`) | recorded marked `personal-default`, lowered to the ceiling in force at every start and turn |
| A plugin-owned Agent's tool grants | adding or widening refused; revoking allowed |
| Muse Code on `muse exec` (serve disabled or failed) | session refused under `ask`: exec runs at Auto |
| Automation rules and scheduled starts (`automation-actions-runtime.ts`) | carried mode lowered |
| Inbound webhook starts (`webhook-turn-starter.ts`) | defaults lowered, else Ask |
| Delegations and agent-started runs | defaults and carried modes lowered |
| `mayGrantFullAccess` / `fullAccessGrantFor` | no grant |
| Start confinement | never `host` |
| Session-wide edit approval | downgraded to a single accept under `ask` |
| The approval picker and chip | modes above disabled; inherited mode shown lowered |

### Limitations

The ceiling decides what Station asks the engine for. It is not a sandbox,
and engines still enforce their own approvals.

- **Engines without a Station-set approval control are not capped**: engines
  with no approval mode (Ollama, Bedrock, Station's own runtime) and ACP
  engines whose approval rules Station does not set at launch. Known ACP
  full-access mode ids are refused through `mayGrantFullAccess`; others are
  not recognized.
- **Muse Code's `muse exec` cannot run stricter than Auto.** Exec has no
  channel to answer an approval, so it always runs `--approval-mode never`
  inside Muse's sandbox, which is Auto in Station's terms. Under a ceiling of
  `ask`, a Muse session that would run on exec (serve disabled, or a
  `muse serve` start that failed) is refused when it starts, rather than
  falling back past the ceiling. Under `auto` the fallback is within the
  ceiling and still runs.
- **Launch configuration is the user's.** The `claude` and `codex`
  executables are resolved on the `PATH` Station runs with, so a wrapper can
  add its own flags. An engine connection's `env` map and `configHome` point
  the engine at user-written configuration (Claude allow rules and hooks, a
  Codex config home). An ACP connection's command and arguments are
  user-defined. Variables in Station's own environment reach engines too.
  Administrator ownership of launch configuration is #4520. This slice closes
  only the cheap, clearly correct part: Station always sends an explicit mode
  under a ceiling, so an engine's configured default mode cannot widen it.
- **A settings-file allow rule** (Claude's user or workspace
  `.claude/settings.json`) still lets a call run without a prompt in Ask, as
  it does without a policy (#1545).
- **Clients show the ceiling from a read** of
  `GET /api/settings/managed-policy`. Until it is read, or if it cannot be,
  the picker disables nothing and the server's refusal carries the message.
