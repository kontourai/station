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
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4523
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4524
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
refuses to make a profile from a policy that uses one. plutil keeps the last
of two equal keys, so an XML plist is scanned for a key repeated within one
`<dict>` before conversion and refused with `duplicate key <path>`, as a file
is. A binary plist is not scanned: conversion has already merged its keys, and
the tools that write binary plists cannot repeat one.

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
has no control. Controls for later slices' keys may be listed early: the
reader maps their values, and the parser then refuses the key as not
supported, which fails closed.

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

## Status of later slices

Settings and the remaining limits are tracked by #4517–#4522. Until each one
lands, its keys are refused, as described above, and the Group Policy template
leaves out its controls.
