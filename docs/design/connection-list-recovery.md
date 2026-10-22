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
| Valid list exists | Normal startup if the cheap recovery admission check accepts its committed publication; otherwise preserve and refuse. |
| Missing list, trusted root, readable evidence, no locks/activity, vault absent | Import or explicit new list through this same receipt flow; existing safe genesis remains separate. |
| Verifiable root-bound typed metadata | Review candidates, import, or explicit new list. No supported adapter in version 1. |
| Provably unrelated history | Retain it; it does not supply candidates or block an acknowledged new list. Requires an explicit foreign-root binding, not app/channel inference. |
| Unbound/global vault history or readable ambiguous metadata | Explain that old connections cannot be reconstructed; import or acknowledged new list. Do not label it unrelated or absent. |
| Known live lock, root service or maintenance operation | Busy: retry assessment or Exit. No commit, stop or takeover. |
| Unknown/malformed/unreadable lock or unavailable process identity | Exit only; ordinary ownership-safe stale-lock handling remains the only reclaim authority. |
| Unreadable/denied vault, required file evidence, unknown receipt/schema, unsafe path or exceeded budget | Exit only with local retry/unlock guidance where applicable. No new-list bypass. |
| Valid pending recovery, staged list still present | Resume the exact attempt, abandon it before publication, or Exit; never a new genesis attempt. |
| Partial unpublished attempt | Explicit abandon/archive under both locks, then fresh recovery assessment; no genesis. Unknown publication state remains Exit-only. |
| Committed recovery, stage consumed, list missing again | Exit only. No replay of its initial list; do not infer an unpublished attempt. |

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
evidence files and 1 MiB per imported list. Existing evidence remains in place;
stream its size/digest with 64 KiB buffers, without the former 16/64 MiB copying
caps. Bound the total evidence-hashing operation to 60 seconds; a timeout is an
incomplete observation, never absence. Reject oversize imports, duplicate-key
JSON, invalid UTF-8 and unsupported fields/versions. Query the canonical Station
services individually on macOS and Linux, with a 4,096-Station-entry total and a
10-second operation deadline. An incomplete/cancelled enumeration refuses.
The UI may cancel while waiting for OS interaction, but a cancelled/late result
grants no write authority. Limits are centralized contract constants, with
boundary tests, not silently truncated success.

Vault absence and readable global history permit the same recovery actions.
Recheck only **readable versus unreadable**, not an account inventory/digest;
an unrelated channel adding a credential must not invalidate consent. No vault
attribute digest is retained. For now, denied/unreadable vault still refuses
new-list creation; Brian's decision on whether this prerequisite can be removed
is pending. This proposal does not preempt it.

## Recovery paths, in preference order

### Import an existing export

Reuse the raw JSON produced by `station stations export`, with no new wrapper
or claim of authenticated provenance. The updated CLI export must refuse when
the persisted list is missing or recovery is pending; it must not export the
current missing-file empty projection. Validate the entire `StationProfileStore`
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
recovery does not use them to read, overwrite or delete credentials. Every
import requires the same explicit acknowledgement that old connections must be
re-enrolled, bound to the exact normalized target before commit. A zero-row
import is **new-list mode**, with the new-list warning and final action; choosing
an empty export cannot bypass that acknowledgement.

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
existing `.station-profile-store-v1` marker. It remains a permanent genesis
fence, including when it contains only archived attempts. `preparing/<uuid>/`
holds preparation bytes that can never publish a list; atomic directory rename
activates one fully staged attempt as `active/`. `archive/<uuid>/` retains
byte-preserved abandoned attempts. Attempt N
is permitted after a safe archive of N-1; never erase the journal to start over.
Do not reuse the instance-home restore marker; its release/archive semantics are
different. Root/config/journal objects must be current-user controlled, Unix
0700 directories/0600 files or verified Windows owner-only ACLs, without
symlinks/reparse points or hard links. Unsupported filesystems fail closed.

Use three immutable strict JSON records, plus a staging file and optional import
blob. Existing backup, cutover and marker bytes stay in place; do not copy them.

| Artifact in `active/` | Required contents |
| --- | --- |
| `intent.json` | Schema `station.connection-list-recovery/v1`, attempt UUID, mode, root binding, observation time/source version, assessment classes, evidence manifest, embedded normalized target with exact serialization/digest/size, acknowledgement version and excluded inventory scope. |
| `acknowledged.json` | Intent/evidence/target digests, acknowledgement text version, mode, time and current local operator-process identity. Required for import and new-list modes. A local OS-user action, not a remote-authentication proof. |
| `commit.json` | Intent/acknowledgement/target digests, stage identity, publication-protocol version and commit time. Fully durable **before** the list can appear. It authorizes only consumption of the existing exact stage, never regeneration of a missing stage. |
| `publish.tmp` | Full target bytes in the same filesystem as `config/profiles.json`. Atomic no-replace rename consumes this file into the list as the last durable publication step. |
| `import.json` (import only) | Exact operator-selected export bytes, retained privately and never modified. |

The evidence manifest records registered authority-path code, file identity,
size and content digest of recognized evidence, with absence observations where
applicable. No contents are copied from existing evidence. Preserve each old
file byte-for-byte in place. Only import bytes and the proposed target are new
payload copies. Use bounded root-relative components, never absolute paths or
traversal, and reject unregistered authority locations on resume. Do not expose
the manifest in diagnostics. It is a change-detection record, not a backup or
promise to retain bytes against later external deletion.

The root binding combines canonical root identity, stable platform volume/file
identity and current OS owner, encoded as private digests with a format version.
A moved/restored root or copied receipt cannot resume publication under its old
binding. A demonstrably unpublished attempt can instead be archived after fresh
root trust checks and acknowledgement, then reassessed under the new identity.
Unknown publication state cannot. Digests do not defend against the same OS user
rewriting both data and receipt; do not claim a cryptographic audit trail.

**Recovery never creates or rewrites the legacy genesis marker.** Preserve an
existing valid marker in place, and record its digest. When no marker exists,
the committed recovery receipt is the updated CLI/native admission alternative
for this explicit flow, not a widening of ordinary genesis. This removes a
marker-only crash window that would otherwise prevent safe abandonment. An old
client may create the normal v1 marker after it sees the final committed list;
that later ordinary action must remain compatible. Invalid pre-existing markers
are never repaired here. Vault entries and payloads remain untouched; store only
the readable/unreadable observation and bounded class counts, not accounts or
attribute/bearer digests.

### Shared read admission and old-client compatibility

Add a cheap bounded receipt-state parse inside `readPersistedProfileStore` /
`readProfileStore` and `read_station_profile_store`, and before
`station_profile_store_is_initialized` can return early. It parses only the small, bounded committed-record header and checks its
version/root binding plus stage/list presence through no-follow file
observations; absent/invalid commit is pending, never success. Intent/target
parsing and full acknowledgement/digest validation remain in the coordinator. It must run before the CLI's missing-file empty fallback.
No PowerShell ACL subprocess, recursive evidence hash or vault query belongs on
these normal read paths. Existing profile-file trust checks remain; full receipt
ACL/root/evidence verification belongs to the recovery coordinator. Cross-language
fixtures pin the same admission outcomes without duplicating the protocol.

Before the final rename, ordinary reads, writes and backend startup refuse and
point to recovery; archived attempts alone never authorize genesis. After valid
commit plus consumed stage plus a valid present list, normal reads and revision
CAS writes proceed. The original target digest is not a permanent constraint on
later revisions. Commit plus missing stage and missing/corrupt list refuses and
never replays the initial target. The receipt directory remains after success.

For the pinned pre-#4022 main and #4022 clients, the permanent unknown journal
directory/legacy marker already makes missing-store genesis refuse. They can
see only a missing list, or a list whose commit record already exists. There is
no published-but-uncommitted interval and no later completion write to strand an
old writer's valid update. After publication, old-client CAS edits are legitimate
later revisions, not a reason to compare back to the initial target. Clients
predating the genesis-marker fence are **NOT_VERIFIED** and unsupported during
recovery; require upgrading them. Compatibility tests must execute the actual
pinned old builds, not a simulated writer.

## Locks and commit protocol

The read-only UI holds no locks. A host-owned plan expires after five minutes
and is bound to its recovery-window nonce. Renderer input carries selections
and that nonce, not arbitrary write paths, root identities or credentials.

On explicit final confirmation:

1. Acquire the existing root genesis lock, then the existing `profiles.json`
   lock. Use the shared process-incarnation protocol, bounded contention and
   ownership checks. Validate the root/config before creating any needed trusted
   config directory. Do not implement or recursively acquire a second lock
   protocol. Config creation alone never grants fresh-genesis authority.
2. Revalidate current process birth identity, window/plan currentness, root and
   opened-path identities, missing list, marker, known evidence, vault
   readability and live instance/service owners under both locks. Changed
   relevant evidence invalidates confirmation. Unknown identity or a live
   service refuses; unrelated readable-vault inventory changes do not.
3. Exclusively create `preparing/<uuid>/`, intent, optional import bytes and
   `publish.tmp`. Finish/flush and validate them, including required directory
   entries, then atomically no-replace rename that directory to `active/`. The
   publisher only ever consumes `active/publish.tmp`; a preparation path can
   never publish. A partial preparation remains safely archivable. Only a fully
   staged attempt may become active. No old evidence is moved/rewritten.
4. Flush acknowledgement, then recheck the same relevant evidence, root/process
   identities and vault readability immediately before commit. No maintenance
   or registry lock may be held across a potentially prompting vault operation;
   tests must observe those locks while the prompt/query is deliberately paused.
   Do not treat a late, cancelled or unreadable query as approval.
5. Exclusively publish and flush `commit.json` and its directory entry before
   any list publication. Validate its exact stage identity and target bytes.
   No legacy marker is created. A crash now is a committed-but-unpublished
   attempt, resumable only by consuming that same stage after revalidation.
6. As the **last durable publication step**, atomically rename the owned stage
   to `config/profiles.json` without replacement: Linux `renameat2` with
   `RENAME_NOREPLACE`, macOS `renamex_np` with `RENAME_EXCL`, Windows
   `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` or cross-volume copy flags.
   A destination that appeared is never overwritten. No hard-link publication,
   copying fallback, overwrite-rename or stage reconstruction is allowed.
   Flush the destination/directory where supported; release profile then genesis
   lock. There is no post-publication completion record or evidence recheck that
   could lock out a valid old-client edit. The operator explicitly continues or
   restarts; recovery does not auto-attach an old service.

A failed/uncertain rename or flush is not reported as success. Re-read observed
stage/list state through the coordinator; never retry a no-replace operation
with a recreated stage. An error after a consumed stage can mean publication
occurred, so preserve the list and report that exact state. New ordinary writers
remain blocked by the held profile lock until the coordinator releases it;
a crashed coordinator is handled by the existing process-incarnation protocol.

This transaction acquires only genesis then profile. Do not invert the separate
maintenance → registry → profile order. Runtime probes are read-only; if stable
exclusion needs maintenance/registry mutation, refuse and ask the operator to
quiesce the service first. The concrete command is
`station service stop --instance=<verified-instance> --base="<verified-home>"`,
using locally verified ownership, never guessed values or a public diagnostic
path. Source inspection finds service stop has no profile-genesis dependency;
Phase 2 must keep its dispatcher/lifecycle path outside the new receipt fence
and test stop with a pending receipt. A directly launched instance instead uses
its existing ownership-checked `station stop --instance=<verified-instance>`
from the owning checkout. Recovery never runs either command automatically.

### Abandon an unpublished attempt

Offer **Abandon attempt and reassess** with a separate acknowledgement. Under
both existing locks, validate current root/owner/process identity, no live
service, absent list and unchanged pre-existing marker. Recovery creates no
marker, so it cannot leave one to undo. A `preparing/<uuid>/` path, including
partial intent/import/stage bytes, cannot publish by construction and can be
archived without inferring publication from absent records. An active attempt
can be archived only when its known-v1 intent and still-present exact stage
prove the stage unconsumed; a partial acknowledgement/commit does not defeat
that positive proof. An absent stage, unsafe path, unknown protocol or
unverifiable active intent does not prove it. Never infer unpublished from a
missing commit alone: power loss might have lost that directory entry.

For these demonstrably unpublished states, atomically no-replace rename the
whole preparation or active directory to a new private `archive/<uuid>/`, without opening
or modifying payloads; retain partial bytes and names exactly. Refuse unsafe
source/destination paths, sharing violations or unsupported rename semantics.
Do not delete locks, markers, profile evidence, vault data or archive contents.
A crash before/after the archive rename leaves either the original directory
or its archive, never a fresh root. No active directory plus archive history permits
only a **new explicit recovery assessment/acknowledgement**, not genesis.

This handles partial preparation intent/import/stage writes, active partial
ack/commit writes, cancellation before publication and stale root binding on a
demonstrably unpublished attempt.
A consumed/missing stage, unknown publication state, or a present list disables
abandonment. There is no unspecified manual deletion/receipt-edit repair path:
show Exit and retain evidence; restoration of a known valid list or a separately
reviewed subsequent-loss flow is required. Abandonment must not masquerade as
recovery of a list that was published and later lost.

### Crash and restart decisions

| Last durable step / observed state | Next launch or explicit action |
| --- | --- |
| Read-only assessment/config directory only | Reassess; no intent or acknowledgement inferred. |
| Partial preparation directory | It can never publish: archive under both locks and reassess, or Exit; never genesis. |
| Active attempt with valid intent and exact stage, partial ack/commit | Stage proves unconsumed: archive or rebuild the plan via fresh assessment, never infer consent. |
| Valid intent/stage, no acknowledgement | Revalidate and require fresh acknowledgement, or abandon/archive. |
| Valid acknowledgement, no commit/list | Revalidate and publish commit, or abandon/archive. |
| Valid commit, exact stage present, list absent | Explicit Resume rechecks and consumes only that stage; abandonment/archive remains possible. |
| Valid commit, stage consumed, valid list present | Publication finished; normal reads and later CAS revisions proceed. No completion write remains. |
| Commit plus stage and list both present | Collision/contradiction: preserve and Exit; never overwrite. |
| Commit plus stage and list both absent, or corrupt list | Publication may have happened and been lost: Exit; never replay or abandon as unpublished. |
| Unknown protocol, unsafe journal, missing active intent/stage or uncertain publication | Exit; never infer absence. Only positive preparation/stage proof authorizes archive. |
| Archive rename interrupted | Re-read active/archive identity under both locks; retain bytes, then resume the observed side of the atomic operation. |

On Windows, file flush plus atomic rename does not promise portable directory
fsync behavior. Power loss can leave missing/partial records. A step-3 partial
preparation attempt can be safely archived; an uncertain active commit/publication
state still refuses. Process-crash tests do not establish power-loss durability.
No resume rewrites old evidence to make it fit.

## Desktop experience and privacy

Use a dedicated pre-backend Tauri recovery window, not a multi-step no-parent
alert or a backend HTTP page. It has narrowly scoped native assessment/import/
commit/resume/abandon commands and no normal credential, enrollment or shell capability.
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
Keep receipts/imports private and exclude them from ordinary issue/report bundles.
These bounds apply to native `log::error!` and dialog `desktop_failure_body`
paths too: map raw OS/keyring errors to fixed codes before logging or rendering;
never interpolate paths, account text or payloads into recovery errors. Private
import disclosure is not an exception for log output. Public test evidence uses
synthetic identities/origins and redacted screenshots.

Version 1 intentionally has no CLI/headless recovery writer. Headless operators
can stop their verified service, but must open the packaged Desktop on that
root to import/create/abandon. The CLI export refusal and receipt read guards
ship with it; no unattended `--force` or guessed-ack shortcut is provided.
A future typed-ack CLI coordinator is separate work. State this gap in help and
operator guidance; do not claim complete headless recovery.

## Platform assessment contracts

| Platform | Attribute-only observation | Cannot establish / required refusal |
| --- | --- | --- |
| macOS Keychain | Query attributes for each service in the canonical nine-service `STATION_KEYRING_SERVICES` registry; no empty-spec generic-password scan or password reads. App identifier/channel are observations only. | Custody digest is not a root binding; access denial, locked/unavailable query or incomplete enumeration is unreadable. Prompt behavior must be tested with the signed packaged app. |
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
  recursively reading runtime contents. Large backup/cutover files are hashed
  in place rather than copied or refused by the removed 16/64 MiB copy caps. Old
  evidence is byte-identical and recovery does not mutate vault values/items.
- Real CLI export → native import → real CLI read/write succeeds. Verify inert
  normalization, strict malformed/unknown/duplicate-field rejection, unsafe HTTP
  refusal and no automatic credential, default, project or service activation.
- Root-bound adapter absent, unbound custody digest, missing origin and app-ID
  mismatch never create candidates. Denied/unreadable/oversize evidence and
  live/unknown locks refuse all commit paths, including a forged confirmation.
- Interleave native recovery with real CLI writers and service ownership changes.
  Removing final evidence/process rechecks or reversing lock order must produce
  a targeted failure; no user service is stopped by the fixture.
- Inject failures before/after intent/import/stage, acknowledgement, commit,
  atomic list rename and attempt-archive rename; restart both Desktop and CLI.
  Cover truncated records, partial directories, destination appearance, replaced
  paths, symlink/reparse OS-metadata files, root moves and lost identity. Prove
  partial precommit attempts archive byte-for-byte and attempt N can proceed.
  Remove the cheap receipt guard at each real shared read/initialized-entry
  caller and prove admission fails its test; a consumed stage plus missing list
  must never replay. There must be no post-publication completion write.
- Export on a missing/pending store refuses. A zero-row import takes new-list
  mode and cannot commit without its acknowledgement. No import skips consent.
- Vault queries use Station-service filters; an unrelated account addition does
  not invalidate consent, but a readable-to-unreadable transition refuses under
  the current pending-owner policy. No attribute digest or whole-vault scan.
- Pause a prompting vault query and verify no maintenance/registry locks are
  held. The recovery fence must not block real ownership-checked service stop;
  no extra ACL subprocess is launched solely by the cheap shared read guard.
- Exercise stale process incarnation, PID reuse, receipt from a different root,
  expired window nonce, double-click commit, killed window/app and OS prompt
  cancellation. Every failure preserves previously existing bytes.
- After publication, real CLI writes increment revision normally; restart reads
  the edited list rather than demanding its initial target digest. Run real
  pinned old builds from pre-#4022 main and merged #4022: before rename they
  refuse missing-list genesis; after a crash following rename, their CAS write
  is accepted as a later committed revision and cannot cause receipt lockout.
  A simulated old writer is insufficient version-skew evidence.
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
