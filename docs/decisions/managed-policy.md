---
status: current
subject: A machine-level managed policy that Station loads at startup and fails closed on
decided: 2026-11-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4515
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4516
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
(#4518–#4522). This build accepts `settings` and `limits` only as empty
objects. Any setting entry or limit key gets a "not supported by this version
of Station" error. If Station accepted a key before it enforced that key, the
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
`O_NONBLOCK`. Every later check runs on that descriptor: `fstat` must report a
regular file (so a FIFO or a device is refused instead of hanging startup), and
it must be the same file `lstat` saw.

**System files must be root's.** For the system sources (not the test override
and not `station policy check`), the file and every directory above it up to
`/` must be owned by root (uid 0) and must not be writable by their group or by
other users. Otherwise Station refuses to start and names the offending path. The
group itself is not checked: a stock Mac has `/Library` as root:wheel 0755 and
`/Library/Application Support` as root:admin 0755, and both pass. A symbolic
link among the parent directories must be owned by root, and the directories it
leads to are checked as well. On NixOS, install the file with a copy mode
instead of the default store link.

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

## Status of later slices

Settings, limits, the macOS profile, the Windows registry, and
`station policy templates` are tracked by #4517–#4524. Until each one lands, its
keys are refused, as described above.
