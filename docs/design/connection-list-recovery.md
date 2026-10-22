# Connection-list recovery without a backup

**Status: proposal for review; not implemented.** Issue
[#4023](https://github.com/kontourai/station/issues/4023).
Phase 1 changes documentation only. Phase 2 starts from post-merge `main` after
[#4022](https://github.com/kontourai/station/pull/4022) lands and this design is
reviewed. Nothing here authorizes widening ordinary genesis or resetting a root.

## Outcome and boundary

An operator whose existing Station root has lost `config/profiles.json` can
import saved connection descriptions or deliberately create a new list while
retaining old data and credentials. A recovered description is unauthenticated;
it is not a live connection or permission to start an existing local service.
Unknown ownership, unsafe paths, unreadable required evidence and unverified
locks retain the existing Exit-only behavior.

This is desktop/shared-root recovery, not runtime-home schema migration,
whole-home restore, remote enrollment, credential repair or mobile recovery.
`STATION_ROOT` identifies the shared root; an instance's `STATION_HOME` does not.
Existing service ownership is preserved. Recovery never terminates a service,
deletes a lock, moves a runtime tree or reads arbitrary runtime data to make a
missing list appear fresh.

## Source findings and limits

The design baseline is `origin/main` at `d5c4a9a78e1`; the reviewed prerequisite
is #4022 at `4cbc5b79f57`. The latter is inspected as proposed code, not claimed
to be merged. Phase 2 must reconcile these owners with the actual merge commit:

- [CLI profile command](../../packages/cli/src/commands/profile-command.ts):
  `station stations export` already prints a raw `StationProfileStore` JSON
  document. There is no connection-list import action. Top-level `export` and
  home archives have other contracts and are not substitutes.
- [Profile contract](../../packages/contracts/src/station-profile.ts): schema 1,
  revision, default, profiles and project selections; rows can include an opaque
  credential reference, local-service identity, relay route and client instance.
  Secret-free does not mean safe for public sharing or automatic activation.
- [CLI store](../../packages/cli/src/commands/profile-store.ts) and
  [native store](../../src-desktop/src/lib.rs): shared root marker, genesis lock,
  profile lock, owner/path checks and revision compare-and-swap. The CLI's
  current missing-file read returns an empty projection; Phase 2 must check the
  recovery fence before that fallback as well as before genesis and writes.
- [Custody metadata](../../src-desktop/src/native_device_custody.rs),
  `metadata_account`, `NativeDeviceCustodyMetadata`, and
  [account digest](../../src-desktop/src/native_proof_key_core.rs),
  `proof_key_account`: `credential-custody:v2:…` hashes the app identifier,
  channel and credential-reference key. **The root is not an input.** Its JSON
  payload has exact origin, Environment, client instance, Device identity and
  bearer digest, but no root identity. That JSON is stored through the keyring
  password API; attribute enumeration does not expose it.
- [CLI keyring](../../packages/cli/src/commands/profile-keyring.ts): the ordinary
  bearer account is `profile:<kind>:<id>` under the Station service. That locator
  does not bind a root either.

Consequently, neither reversing a custody hash nor reading its payload can
establish root ownership. App/channel identity and account-prefix matches are
global history signals. A reference already known from a root-bound record can
locate a companion, but cannot turn an unbound companion into root evidence.
Phase 2 will not enumerate secret values, decode bearer contents, probe remote
origins, infer an origin from a port or promote vault history into candidates.

## Read-only assessment

Assessment is a product of independent observations, not a single boolean.
It returns store/marker state, root ownership, lock/process state, file-evidence
state, vault state, recovery-journal state and permitted actions. A denied or
bounded-out observation is never `absent`. No durable ID, directory, marker,
permission change or keyring entry is created during assessment.

**Root-bound** means a supported typed record explicitly identifies this exact
root, its issuer/type/version and the connection fields being asserted, and the
binding can be checked against an already trusted root identity. Mere location
under a root, a matching app/channel, hostname, port, Environment ID or credential
reference is insufficient. A complete connection-list export chosen by the
operator is explicit import input, not proof that it came from this root.

There is currently no recognized root-bound candidate format with a verified
root/origin binding. Version 1 therefore reports no automatically reconstructed
candidates from current custody metadata. Do not add a new metadata writer or
historical migration just to populate this option. A later adapter needs a
separately reviewed typed issuer/binding contract and negative controls before
it can enable candidate reconstruction.

| Observation | Meaning and Desktop actions |
| --- | --- |
| Valid list exists | Normal startup; no missing-list recovery. A pending receipt takes precedence. |
| Missing list, trusted root, readable evidence, no locks/activity, vault absent | Import or explicit new list through this same receipt flow; existing safe genesis remains separate. |
| Verifiable root-bound typed metadata | Review candidates, import, or explicit new list. No supported adapter in version 1. |
| Provably unrelated history | Retain it; it does not supply candidates or block an acknowledged new list. Requires an explicit foreign-root binding, not app/channel inference. |
| Unbound/global vault history or readable ambiguous metadata | Explain that old connections cannot be reconstructed; import or acknowledged new list. Do not label it unrelated or absent. |
| Known live lock, root service or maintenance operation | Busy: retry assessment or Exit. No commit, stop or takeover. |
| Unknown/malformed/unreadable lock or unavailable process identity | Exit only; ordinary ownership-safe stale-lock handling remains the only reclaim authority. |
| Unreadable/denied vault, required file evidence, unknown receipt/schema, unsafe path or exceeded budget | Exit only with local retry/unlock guidance where applicable. No new-list bypass. |
| Valid pending recovery | Resume the exact attempt after revalidation, or Exit; never a new genesis attempt. |
| Valid completed recovery, list missing again | Exit only. No replay of its initial list; recover as a separately reviewed subsequent loss. |

Classify the whole root without recursively scanning `instances/**`. A realistic
used home can have millions of unrelated files. Observe trusted root/config
directory identities, schema/genesis/restore/cutover fences, the registered
profile backup locations, recovery artifacts, locks and instance-registry
process owners. All recognized connection evidence is retained; unknown
regular entries are reported as present, not interpreted as history or read.
An unknown entry at a required authority path, symlink/reparse point in an
accessed path, or unsupported schema refuses recovery. Ordinary runtime
subdirectories are not traversed or modified. An inventory of excluded areas is
part of the receipt; a bounded inventory is not a whole-root consistency claim.

Initial limits: 4,096 root/config directory entries combined, 256 recognized
evidence files, 1 MiB per imported list, 16 MiB per recognized evidence file and
64 MiB total preserved file bytes. Reject oversize, duplicate-key JSON, invalid
UTF-8 and unsupported fields/versions. Vault enumeration is bounded to 4,096
Station entries and a 10-second operation deadline; an incomplete/cancelled
enumeration refuses. The UI may cancel while waiting for OS interaction, but a
cancelled/late result grants no write authority. Limits are centralized contract
constants, with boundary tests, not silently truncated success.

## Recovery paths, in preference order

### Import an existing export

Reuse the raw JSON produced by `station stations export`, with no new wrapper
or claim of authenticated provenance. Validate the entire `StationProfileStore`
using the shared schema plus strict unknown/duplicate-field and size checks.
Require unique names, valid origins and existing transport rules. A malformed
row refuses the entire input rather than quietly dropping it. Copy the exact
input bytes into the private receipt before publication; never modify the
chosen file. A symlink/reparse input or file changed during capture is refused.

The private review window shows the operator the proposed names/endpoints only
after an explicit import and disclosure action; logs/diagnostic export do not.
The proposed list resets revision to 0, default to null, project selections to
an empty object and every row to `requires-auth`/`manual`. Remove credential
references, local-service identities, client-instance identities, relay routes
and development-HTTP approvals. Preserve validated name, endpoint and optional
Environment association as descriptive data only. Do not silently widen allowed
HTTP: a row requiring a removed development exception is refused with a private
per-row explanation. No profile is selected and no service is attached until
normal explicit setup/pairing re-establishes authority.

This deliberately requires re-enrollment even on the same machine. The retained
original export contains the old locators for later operator investigation;
recovery does not use them to read, overwrite or delete credentials.

### Reconstruct from verified metadata

Only supported root-bound metadata containing a verifiable exact origin and
the required identity fields may supply candidates. Missing origin means no
candidate, not localhost or a discovered URL. Candidates undergo the same
inert-row normalization and private review as an import. Today this option is
disabled with an explanation; current keyring companions do not qualify.
Enumeration must precede any separately consented vault payload access. Version
1 needs no payload reads at all and exposes no generic keyring accessor to the
WebView. Reading future metadata would not by itself authorize bearer reuse.

### Deliberately create a new list

For a trusted, readable root with absent or readable unbound/global history,
offer this separate action after import/candidate options. State plainly:
“Your existing data and credentials will be kept. This creates a new connection
list. Add and pair your previous Stations again.” Require an unchecked
acknowledgement and a distinct final **Create new list** action; no default
confirmation, command-line `--force` shortcut or timeout approval.

The target is exactly the shared empty schema-1 store: revision 0,
`defaultProfile: null`, `profiles: []`, `projectProfiles: {}`. This is authorized
recovery over retained history, **not** a conclusion that history was absent.
Marker-present/missing-list can enter only this explicit transaction after all
checks; ordinary startup remains Exit-only for that state. An invalid marker
cannot be replaced or repaired by this flow.

## Receipt, admission and durability

Use one private root directory, `.station-connection-recovery/`, alongside the
existing `.station-profile-store-v1` marker. It is a permanent recovery fence,
not a genesis-allowed directory. Do not reuse the instance-home restore marker;
its release/archive semantics are different. Root/config/journal objects must
be current-user controlled, Unix 0700 directories/0600 files or verified Windows
owner-only ACLs, with no symlinks/reparse points or unsupported hard links.
Unsupported filesystems fail closed; do not substitute a lossy atomicity scheme.

Version 1 permits one attempt, UUID-named under that directory. A malformed,
empty, unknown-version or extra attempt is a recovery condition, never permission
to delete the directory and start over. An exited unfinished attempt remains
resumable only through its exact validated plan. Automatic cancellation cleanup
does not erase it. A later independent loss after completion is out of scope.

The private receipt consists of immutable, strict JSON records and byte blobs:

| Artifact | Required contents |
| --- | --- |
| `intent.json` | Schema `station.connection-list-recovery/v1`, attempt UUID, mode, root binding, UTC observation time, source version, assessment classifications, evidence manifest, target digest/size, required acknowledgement version and excluded inventory scope. |
| `evidence/` | Exact recognized pre-existing profile/backup/cutover/marker bytes, with fixed opaque blob IDs and digests; exact import bytes when selected. No copied runtime trees, credentials or keyring payloads. |
| `target.json` | Fully validated normalized proposed store bytes; immutable even after later ordinary profile writes. |
| `acknowledged.json` | Intent digest, evidence digest, target digest, acknowledgement text version, mode, time and current local operator-process identity. A click by the current OS user, not a remote-authentication proof. |
| `complete.json` | Digests of intent, acknowledgement and initially published target, publication time and completion version. Created only after locked readback and required flushes. |

The root binding combines the canonical root identity, stable platform
volume/file identity and current OS owner, encoded as private digests with a
format version; plain paths are not stored in public diagnostics. The receipt
is not portable to another directory, volume or user. A copied receipt, moved
root, unavailable stable identity or inconsistent opened-handle identity refuses
resume. Local digests detect change; they are not protection against the same
OS user rewriting both data and receipt. Do not advertise a cryptographic audit
trail against that user.

Preserve existing marker bytes and existing vault entries in place. A valid
existing genesis marker is copied as evidence, never rewritten. A missing marker
may be created with its existing v1 signature only after the acknowledged
receipt is durable. The private evidence manifest uses registered authority-path codes or bounded
root-relative components to map blobs back to their unchanged sources; reject
absolute paths, traversal and unregistered authority locations on resume. Never
include that manifest in shared diagnostics. No raw vault account names or secret-derived bearer hashes
enter the receipt: retain bounded service-class counts and a per-attempt salted
digest of enumerated attributes to recheck observations; keep the salt private.
Vault values remain untouched in the OS store. A receipt cannot snapshot or
promise to recover external keychain state after another program changes it.

Both updated Desktop and CLI must check this directory **before** a missing-file
empty projection, genesis, profile read/write or backend launch. A pending
transaction refuses ordinary access even if `profiles.json` is already present.
Only the recovery coordinator can resume. A valid completed transaction permits
normal store reads and revision-CAS writes; the initial target digest is not a
permanent constraint on later revisions. Completed receipt plus missing store
always refuses; completed transactions are never replayed.

Deploy the Desktop/CLI admission change together. Older clients cannot enforce
the new pending-receipt rule and must not participate during recovery. Existing
#4022 genesis already refuses a marker/journal with a missing store. An old
writer that publishes after a recovery crash cannot be mistaken for our write:
resume compares the exact target bytes and refuses mismatch without replacing
them. This is preservation on version skew, not a claim that old readers honor
new admission. UI/docs require all participating clients to be updated.

## Locks and commit protocol

The read-only UI holds no locks. It operates on a host-owned plan expiring
after five minutes and bound to a recovery-window nonce; renderer input contains only selections and
that nonce, not arbitrary write paths, root identities or credentials.

On explicit final confirmation:

1. Acquire the existing root genesis lock, then the existing `profiles.json`
   lock. Use the shared process-incarnation protocol, bounded contention and
   ownership checks; do not implement a second lock algorithm. Validate the
   root/config before creating any required trusted config directory. A crash
   leaving that directory does not authorize fresh genesis.
2. Revalidate current process birth identity, window/plan currentness, root and
   opened path identities, missing store, marker, known evidence, vault
   classification and live instance/service registry immediately under both
   locks. Any change invalidates confirmation and requires a new assessment.
   Unknown process identity or a live service refuses; no implicit shutdown.
3. Exclusively create the journal/attempt and evidence blobs. Finish, flush and
   validate intent/target/evidence before publishing the acknowledged record.
   Publish records without replacement. No existing recognized evidence is
   moved or rewritten. Directory names and the new receipt are the only changes
   before the marker/list commit.
4. Flush the acknowledgement. Immediately recheck the same identities/evidence
   and process liveness before marker or list publication. Vault enumeration
   is observational, not a vault-wide lock: a changed/failed observation refuses,
   and recovery never mutates vault data. Do not hold maintenance/registry locks
   while waiting for a keyring prompt. Registry/process uncertainty refuses.
5. Preserve/validate the existing marker or exclusively publish its v1 signature.
   Copy the immutable target bytes into an exclusively created `publish.tmp`
   in the same filesystem, flush it, then publish the complete staged list with
   an atomic no-replace operation. POSIX hard-link publication followed by
   removal of only the owned staging link, and Windows fail-if-exists publication,
   must be qualified on supported filesystems; plain overwrite-rename is not
   acceptable. Never link the permanent `target.json` to the mutable list. A
   destination that appeared is never overwritten. A crash between linking and
   staging-link removal is an explicit pending state: resume verifies both
   identities and bytes before removing that one owned link. Unexpected link
   counts refuse. Flush file and directory entries where supported, then
   read/validate the exact target.
6. Exclusively publish and flush `complete.json`. Release profile then genesis
   lock. Only a completed, validated receipt may lead to normal startup. The
   operator explicitly continues/restarts; the window cannot imply a successful
   connection or silently attach to an old service.

This transaction acquires only genesis then profile; it must not call a helper
which acquires them again or invert the maintenance → registry → profile order
of other lifecycle coordinators. Inspect runtime state using read-only identity
probes; if race-free exclusion would require maintenance/registry mutation,
refuse and ask the operator to quiesce that service first. Cooperative CLI/native
writers must reach the existing locks before changing profile/instance bindings.
Noncooperating same-user file writers are outside lock authority; changed
evidence always causes refusal, not replacement.

### Crash and restart decisions

| Last durable step / observed state | Next launch or explicit resume |
| --- | --- |
| Read-only assessment or config directory only | Reassess. No saved intent or acknowledgement is inferred. |
| Journal/attempt exists but intent, blob or target is incomplete | Exit only; preserve partial bytes for operator repair. Never genesis. |
| Valid intent/target/evidence, no acknowledgement | Show exact pending plan; require fresh acknowledgement after revalidation. No automatic publication. |
| Valid acknowledgement, marker/list absent | Explicit Resume rechecks under locks and commits the same target; changed evidence refuses. |
| Marker published, list absent | Receipt authorizes only exact acknowledged Resume, not ordinary genesis. |
| Full target published, completion absent | Ordinary readers/startup refuse. Explicit Resume may finalize only when current bytes exactly match target and all evidence/identities still agree. Otherwise preserve and Exit. |
| Completion present and current list valid | Normal startup; subsequent CAS revisions may differ from initial target. |
| Completion present, list missing/corrupt, or contradictory journal/target | Exit only; no replay or empty replacement. |
| Any write/flush/readback failure, filesystem durability uncertain | Keep artifacts; report incomplete, not success. Re-evaluate the observed state on next launch. |

On Windows, file flush plus atomic publication is not a promise of portable
directory-fsync behavior. Power loss can yield a missing or partial journal
record; the existence fence must refuse it. Process-crash tests do not establish
power-loss durability. Resume never rewrites preserved evidence to make it fit.

## Desktop experience and privacy

Use a dedicated pre-backend Tauri recovery window, not a multi-step no-parent
alert or a backend HTTP page. It has narrowly scoped native assessment/import/
commit/resume commands and no normal credential, enrollment or shell capability.
Package its production UI with the app. Closing it exits; killing the app closes
the flow. No-parent macOS CFUserNotification alerts can outlive a killed app,
which makes them unsuitable for keeping a multi-step consent current.

Start with “Station connection list is missing”, a short reason and Exit.
Enable **Recover connection list** only for explicitly recoverable classes in
the assessment table. The window then presents import first, verified candidates
when available, and the acknowledged new-list action last. Busy/unreadable states
offer only re-assessment/unlock guidance and Exit, not a disabled-looking reset
shortcut. Startup errors for the bundled Node or its watchdog retain their own
messages; they do not become folder-recovery advice.

Ordinary assessment UI displays only a sorted, deduplicated maximum of 12 entry
basenames, each capped at 80 Unicode scalar values with control/bidi formatting
characters replaced; show that more were omitted. Do not show the root path,
nested paths, vault accounts, origins, Device/session IDs or raw OS error text.
The private import/candidate review is an explicit disclosure surface; it is not
a diagnostic. Shared diagnostic export contains fixed reason codes, counts,
platform/schema and recovery state only—no names or identity/digest locators.
Keep receipt blobs private and exclude them from ordinary issue/report bundles.
Public test evidence uses synthetic identities/origins and redacted screenshots.

## Platform assessment contracts

| Platform | Attribute-only observation | Cannot establish / required refusal |
| --- | --- | --- |
| macOS Keychain | Enumerate generic-password attributes, filter Station services; no password reads. App identifier/channel are observations only. | Custody digest is not a root binding; access denial, locked/unavailable query or incomplete enumeration is unreadable. Prompt behavior must be tested with the signed packaged app. |
| Windows Credential Manager | Match Station services against raw account-first `account.service` target names. Do not use the store's greedy dotted-service decoder. | Raw target proves history, not root/origin. Session storage refusal, access failure, malformed entry or incomplete enumeration refuses. No CredentialBlob reads. |
| Linux Secret Service | Query each service from the enforced canonical Station service registry, with the same native-store boundary. | Do not search/unlock all unrelated items. Unlocking a requested Station item can unlock its collection. Denied/locked/error/incomplete results are unreadable; provider behavior needs executed proof. |

Every platform reports readable global history as unbound. A different app
identifier is not evidence of another root. The macOS proof harness must inspect
the actual built `CFBundleIdentifier`; a CLI configuration override is not proof
of a different signing/keychain owner. Test cleanup deletes only exactly
attributed fixture items with separate custody, never prefix-wide credentials.

## Acceptance from #4023 (verbatim)

The following issue bullets are retained verbatim as the implementation gate;
the text above chooses the proposed mechanism rather than claiming it ships.

<!-- issue-4023-acceptance:start -->
- Recovery is an explicit native/operator action before any backend starts. A read-only assessment distinguishes root-bound typed metadata, unrelated/global OS-vault history, ambiguous ownership, unknown locks, unreadable stores and missing data. Presence alone must not imply absence or authorize replacement.
- Prefer importing a validated connection-list export. Recover candidates from root-bound metadata only when the required identity/origin fields exist and can be verified; enumerate attributes before any consented secret access. Never guess an origin, claim a live connection, or display secret values.
- For history that cannot reconstruct a list, separately offer an explicit new-list path only after a durable recovery receipt preserves the prior evidence and the operator acknowledges that old connections must be re-enrolled. Retain old credentials and root data; no recursive root reset or silent credential deletion.
- Define the receipt and CLI/Desktop admission contract together. Recheck evidence and process identity under the existing genesis/profile lock order immediately before commit. Marker-present/missing-store, concurrent CLI writes, stale or unknown locks, denied keyring access, crashes and restarts must remain fail-closed. Recovery resumes or refuses deterministically; it must not reinterpret a partial attempt as a fresh root.
- Bound and sort displayed entry names. Keep private paths, saved origins, account/session details and secrets out of shared diagnostics and issue evidence.
- Acceptance includes a realistic used home without a backup, root-bound and unrelated vault history, metadata that lacks an origin, OS metadata files/symlinks, unreadable/denied vault, concurrent writers, and fault injection before/after publication. Prove byte preservation of old evidence and actual CLI read/write interoperability after recovery, then exercise the packaged native UI on Windows and macOS.
- Documentation owners: `docs/user/native-recovery.md`, `docs/guides/desktop-build.md`, and the native/shared profile-store owners. Add the design to `docs/design/` before implementation and keep intended behavior distinct from executed platform evidence.
<!-- issue-4023-acceptance:end -->

## Implementation proof required after design review

Use one shared strict receipt/store contract and cross-language fixtures for
native and CLI; platform adapters own file/vault identity and atomic publication.
Do not write tests in Phase 1 or treat this proposed test plan as evidence.
In Phase 2 each named invariant needs a baseline, intended regression failure
and byte-exact restored pass. Tests must exercise the real admission/commit
caller, not only a classifier helper.

- A realistic used root with many unrelated runtime files, missing list and
  readable global vault history reaches acknowledged new-list recovery without
  recursively reading runtime contents. Old file evidence is byte-identical and
  vault item values/counts are unchanged by recovery.
- Real CLI export → native import → real CLI read/write succeeds. Verify inert
  normalization, strict malformed/unknown/duplicate-field rejection, unsafe HTTP
  refusal and no automatic credential, default, project or service activation.
- Root-bound adapter absent, unbound custody digest, missing origin and app-ID
  mismatch never create candidates. Denied/unreadable/oversize evidence and
  live/unknown locks refuse all commit paths, including a forged confirmation.
- Interleave native recovery with real CLI writers and service ownership changes.
  Removing final evidence/process rechecks or reversing lock order must produce
  a targeted failure; no user service is stopped by the fixture.
- Inject failures before/after each receipt write, acknowledgement, marker,
  atomic list publication and completion; restart both Desktop and CLI. Cover
  truncated JSON, missing blobs, partial directories, destination appearance,
  replaced paths, symlink/reparse OS-metadata files, root moves and lost identity.
  Remove the receipt admission check and prove ordinary reads/writes/startup
  fail their tests; completion plus missing list must never replay.
- Exercise stale process incarnation, PID reuse, receipt from a different root,
  expired window nonce, double-click commit, killed window/app and OS prompt
  cancellation. Every failure preserves previously existing bytes.
- After completion, real CLI writes increment revision normally; restart reads
  the edited list rather than demanding its original target digest. Older-client
  post-crash mutation must cause resume refusal rather than overwrite.
- Packaged Windows (implementation lane) and signed macOS (independent lane):
  import, new-list acknowledgement, denied vault, unknown lock, crash/resume,
  Exit, app kill and post-recovery CLI interoperability. Inspect rendered UI,
  actual app identifiers, process/listener ownership and fixture cleanup. Linux
  unit/source evidence remains distinct from a real Secret Service/packaged run.

Phase 2 updates [native recovery](../user/native-recovery.md),
[desktop build](../guides/desktop-build.md), CLI help/reference, scoped native
guides and review-ledger claims together. Mark current Exit-only behavior until
the flow and its evidence land. No merge/release acceptance follows from this
design PR or from prior #4022 proofs.
