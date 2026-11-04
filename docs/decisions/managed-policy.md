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
Version 1 reserves `limits` (#4518–#4522). This build accepts `limits` only as
an empty object. Any limit key gets a "not supported by this version of
Station" error. If Station accepted a key before it enforced that key, the
administrator would see the machine as managed while nothing was managed. Each
enforcement slice adds its key to the parser in the same change that enforces
it. `settings` entries are enforced since #4517; see
[Managed settings](#managed-settings).

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

Project refusals carry the same 403 body as `/config/app` (`code`, `key`, and
the organization's sentence with its support link), composed from the loaded
policy rather than from the caught message, which the project route redacts.

## Status of later slices

Limits, the macOS profile, the Windows registry, and `station policy templates`
are tracked by #4518–#4524. Until each one lands, its keys are refused, as
described above.
