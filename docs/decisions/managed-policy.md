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
    ref: https://github.com/kontourai/station/issues/4522
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
(#4518–#4522). This build accepts `settings` only as an empty object, and
`limits` with only `updates` (#4522, [update control](#update-control)). Any
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

## Update control

`limits.updates` (#4522) has three optional keys: `mode` (`auto` or `off`),
`feedUrl` (a mirror) and `allowNightly`. The decisions:

**Each update surface enforces it where it runs.** There are four: the
server's core update routes and its own update coordinator, `station upgrade`,
the Station service launcher's download step, and the desktop app updater.
The server loads the policy at startup with the rest of the document.
`station upgrade` and the launcher are separate processes that run without
the server, so each reads the installed policy when it runs, and an installed
policy it cannot use refuses the update, as it refuses server startup.

**The desktop app reads the policy natively, not from the server.** The
updater must obey the policy when the bundled server is not running, and in
particular when the server refused to start because of the policy; asking the
server would then have no answer, and treating no answer as "no policy" would
update a machine whose administrator turned updates off. The desktop shell
(`src-desktop/src/managed_update_policy.rs`) reads the same fixed path with
the same source rules: a missing file means no policy; a link, a non-file, a
file over 1 MiB, or (on macOS and Linux) a file or folder not owned by root or
writable by group or others is unusable; a repeated key is unusable. It
honors the test override under the same rule as the server. The shell enforces
only `limits.updates`:

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
nightly. The policy controls Station's own updates; it does not stop someone
from running the installer by hand, because the policy is not a sandbox.

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
desktop updater and `install.sh` refuse a download outside the mirror. The feed
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

**The feed URL never reaches clients.** It may carry an access token in its
path, so the client summary reports `limits.updates` as `mode`, `allowNightly`
and `mirror: true | false`. The parser still refuses a user name or password in
it: every user on the machine can read the policy.

## Status of later slices

Settings, the remaining limits, the macOS profile, the Windows registry, and
`station policy templates` are tracked by #4517–#4524. Until each one lands, its
keys are refused, as described above. `limits.updates` landed with #4522.
