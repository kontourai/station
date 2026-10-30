# Child-work epic

One ongoing branch, `feat/child-work-epic-20261021`, owns work outside the
master consolidation in #3991. It starts at published
`d96f54887837be058c5e5119b8028daab0befea1`. Merge subsequent master/main
normally before publication. Open one PR when the combined work is ready.

## Published Flow 9.9.1 pin (#91)

Station selects the registry Flow Agents 9.9.1 and Flow 5.4.0 packages. The
installed rounds module and type bytes match the released 9.9.1 artifact
(`e2bf2ebdd37`, rechecked at `cdf6a11f7d0`). The source owner
can authenticate a historical Flow location by joining signed report admission,
member envelope and the retained signed source snapshot, without re-preparing
source execution. A metadata-only adapter now joins that locator with the
bootstrap participant, home writer and retained receipt owner, but its route is
disabled even when its preview is enabled (`e802467d519`). The published patch
repairs 9.9.0's exact-finalizer replay authentication defect; that historical
failure is retained, but publication is no longer the blocker. Station's other
rounds writers do not yet hold the home writer through journal publication.
The home-first transaction composition, cross-participant exclusion proof and
positive full runtime-factory HTTP/SDK finalization remain open. Controlled
custody tests and a busy contender refusal do not establish a CAS-loser race or
complete publisher exclusion.
Missing or altered location evidence refuses; no provider execution or #91
completion follows from this work.

## Private publication lifetime (#91)

Bootstrap captures the exact current home runtime lease into a private publication
participant. The existing report sync finalizer holds it through its rounds
transaction and response readback. Shutdown stops new admissions first and joins
admitted work before closing dependent services or releasing the home; a pending
join leaves those dependencies and the lease intact for a later attempt. This is
not a provider authority and does not complete #91. The metadata continuation
route remains disabled until the composed publication owners and their proofs
are verified. The patched public package is installed; its upstream evidence
does not qualify Station's composition.

## Portable delegation-group source split (#91)

The unfinished portable delegation-group CLI, SDK transport, contract shapes,
route, runtime and exclusive binding owners are retained at
`archive/portable-groups-unsplit-15d0352a40b` (commit
`15d0352a40bced0c7826efb316b17c39fbc82190`). They are NOT DELIVERED on
this branch. The public `delegationGroups` capability remains false.
Production preparation, current V2 grant binding, Flow host callbacks and
qualified physical execution remain open under #91. Shared report and CLI
session-group owners remain in use; this split does not complete the epic.

### Portable source-owner recovery increment

The new, unwired portable preparation and execution owners use the installed
public V2 controller and signed host admissions (`f33b6940b67`). A later request
can authenticate the retained intent and reuse the persisted group; recovery
also finishes creation from a retained admission with no group journal, using
the exact retained authority identities (`67d080ec499`, `43c6cb70284`). The
focused preparation/execution selection passed three cases and server-test
typechecking passed after the recovery repair. Independent source review closed
the replay and preparation-cache findings. The overlapping-create test does not
establish that the second request reached the held phase before release;
concurrent retry remains unverified at that boundary.

These owners are not mounted in production. Bound Session source and credential
authority, the complete runtime/HTTP/MCP/CLI surface, Flow callbacks, cancellation
and member transport qualification remain unfinished. The operator fixture's
controlled SDK responses do not establish provider or physical-runtime acceptance.
The capability remains false and #91 remains undelivered.

## Earlier source checkpoints

### Merged UI focused qualification

At `e076e661411`, two serial `npm run test:focused` selections passed
175 tests across eight files: background-task retention, global child-work
state and parity, Home lanes, child-work rows, mounted background-task hooks,
active identity and directory context. The UI and child-work contract had no
working diff; separate server publication edits were still in progress and
are outside this receipt. The runs cover fixture state, subscriptions and
rendered labels, including reported CLI origin and result provenance. They do
not establish browser geometry, current device/provider acceptance, CPU
performance, or finalizer/runtime publication qualification. The exact logs
and their digests are retained in the local ignored
`.kontourai/child-work-cli-group/ui-focused-e076e661411.json` receipt.

### Merged provenance and delivery diagnostics

At `e84be2b68ca`, the contract, Claude/Codex capture replay, projection,
cold-history and transcript-route selection passed 254 tests across six files.
The named provenance owners had no working diff. A separate delivery selection
passed 145 tests across three files, including runtime-route credential wiring
and real EventStore persistence with recorded stub parent effects. Publication
owner files were dirty during these runs, so neither is an exact-head
whole-server receipt or qualification of that repair. Transcript authority is
fixture-supplied; cold reconstruction is not a true process restart, and no
live provider/device acceptance follows. Hash-bound local receipts are retained
as `provenance-focused-e84be2b68ca.json` and
`delivery-focused-e84be2b68ca.json` under the same ignored evidence directory.

At `1973398083f`, the branch includes main through `8fa16170bed` by normal
merge and consumes published Flow Agents 9.7.0. The
published package's integrity and installed renewal implementation were checked;
the controlled same-Session continuation and canonical-input consumer tests both
pass. These are synthetic-provider tests, not live serving qualification.

Provider qualification was refreshed at `14b187ec67b` from retained official
snapshots with fixed validity windows. The mixed-family/profile selection
passes 18 controlled cases. Exact-expiry mutations fail the two owning tests;
byte-exact restoration passes all 15 profile cases. These checks establish
source and controlled contract behavior, not account entitlement or invoices.

At `0d62100ff7d`, active cancellation uses the authenticated current epoch while
preserving the original signed admission. Controlled tests cover revocation,
renewed-but-unadopted cancellation, adopted cancellation and retention of an
unresolved reservation. This is a cancellation prerequisite; it does not issue
a production authority renewal.

Commits `090f38882f8` and `55d2d5693e9` add the verified-answer no-tools ACK
after adopted narrowing. SDK/HTTP/CLI select the original signed renewal and
private completed answer rather than accepting replacement text. Earlier-epoch
terminal receipts are revalidated by their exact canonical event ID and physical
Session identity, then reused unchanged. Independent source review approved the
slice after the terminal-event finding was repaired. Controlled input/continuation
tests pass; an answer-content mutation fails the exact-context assertion and
byte-exact restoration passes. A missing exact terminal refuses before another
provider call and leaves its new reservation held.

Commits `0f588b8dc71` and `243399dda91` add the separately funded report through
published Flow retry admission, with exact later-invocation delivery/cancellation
custody. The server requires a current-head/round same-seat ACK, the actual
previous invocation and route-back or checked retry reference; it compares the
Flow-prepended request with the freshly prepared no-tools wire. A missing exact
ACK terminal refuses before payment. Controlled tests cover answer carriage,
returned raw output, exact new-turn cancellation, held unknown usage, historical
reads after Session teardown, and two concurrent observational replay races.
Independent source review approved the slice after historical-read and replay
findings were repaired. Pre-payment and signed-turn custody mutations fail their
owning integration assertions; restoration checks are retained separately.

The branch merged main through `dd13acebd62` normally at `cb6ea219951`.
Both resource-manifest additions were retained and the generated documentation
artifact was rebuilt. The 57 manifest/MCP-doc controls and 163 pairing-route
controls pass after this merge.

Upstream Flow 5.3.0 and Dispatch 0.8.0 are now published: registry integrity and
installed runtime files were checked against their release builds. Flow adds
exact-head evaluation/retry under a host-held lease, and Dispatch adds actual
existing-reservation inspection and checked exact settlement. Their source
reviews and local evidence remain separate from Station adoption.

Flow Agents source `6a66cbc39e` composes the actual Dispatch reservation bridge,
original-epoch dual-ledger recovery and checked Flow continuation admission. The
combined source and aligned coordinator closure migration are source-approved;
67 rounds/runtime cases pass. Full qualification is still open. A broad run
failed two kit-custody controls under load; the four-worker candidate at
`75fbae3c` preserves the full corpus, assertions and protected 20-minute limit.
Its Mac readiness run timed out at that limit, with no assertion failures in
the captured unit-test fragment. The first Linux run of that revision finished
within the limit but failed: the host created group-writable fixtures, and the
static-route test still expected the old uncapped command. The test contract is
repaired at `ea26262f`. A fresh isolated Linux run uses a non-group-writable
fixture environment and preserves test-owned PATH overrides; its qualification
is pending. The contract is not yet published or adopted by Station; Station
still consumes Flow Agents 9.7.0.

Station captures original approved pricing evidence at `51b3764882d` and
re-audits complete raw-response usage against it at `8f8732aaddc`, without
reactivating execution capabilities or consulting the current registry. The
contract and actual SDK-retention/persistence checks pass 133 cases, and
server-test typechecking passes. Independent source review approved the verifier.
Its persisted-caller mutation fails all four provider/protocol cases with 72
controls passing; byte-exact restoration passes all 76 caller-file cases.
The historical-reconciliation draft still addresses only authority accounting
and is neither mounted nor fully
qualified. Unknown and above-capacity usage remain holds.

Evaluation-only serving, reappraisal/retry authorization, complete historical
reconciliation, Google/mixed-family runtime, live/device journeys and final
combined qualification remain open. An ACK alone cannot authorize another paid
report: Flow must admit its actual route-back or retry using current-head sync
evidence and original immutable capacity. Station readiness at `51b3764882d`
failed documentation truth on outstanding review/capture freshness; the other
selected checks passed. No combined Station PR has been opened.

## Revision-bound implementation history

The following sections record successive checkpoints. Present-tense words such
as “current”, “unwired” and “open” describe that section's revision; later
claim-specific evidence may supersede a limitation. Historical failed runs stay
failed, and historical test counts are not results for the latest head.
Requirements and unclosed acceptance items remain obligations. The latest source
checkpoint above does not upgrade earlier receipts into broader acceptance.

- **#88:** bounded tool cards and recent resume bindings; raw-tool omission is
  disclosed by a flag and retained-row count, not an exact omitted count;
  snapshot absence remains unresolved; active/terminal evidence can
  correct uncertainty; open chat aliases own presentation-history retention.
  Closed chats share a bounded client recovery cache: 150 rows, 50 bindings
  without rows, and 50 omitted-history flags. Eviction is not a task outcome;
  reopening can recover current delegate facts from the server snapshot.
  The activity sheet labels retained activity and missing closed-chat history;
  its empty state is not proof that no work is running.
- **#1879:** Claude's structured Agent/Task return is bound to the tracked
  call and child, retained as `tool-return`, and replaces a provider summary.
  Other reports retain provider-summary, child-message, or provider-error
  provenance. Missing returns are disclosed; older reports remain unknown.
  Truncated prefixes cannot establish report identity. A returned report does
  not establish a verified artifact or semantic acceptance. Existing authorized
  child transcript access remains the recovery route. Live return/recovery
  qualification remains open.
- **#2868:** projectless rows show labeled directory context. Delegation
  initiation uses the first turn's recorded origin; authenticated actor kind
  stays separate from the self-reported client surface. Activity rows and origin
  filters, Session metadata and receipt summaries mark known client surfaces
  as `(reported)` too. No external orchestrator is inferred from text or
  User-Agent.
- **Native activity:** Codex child-owned tool items project bounded tool names
  through the shared activity UI. The inspected Muse protocol has no child
  tool stream; its missing value stays absent.

At `3a5ca9c8a5d`, the contract suite also binds the documented handle-only
case: without text, a recovery handle has no summary provenance and cannot
replace an existing report or its recovery handle. All 46 cases pass; removing
the text-presence guard fails the new assertion with 45 controls passing.
Byte-identical restoration returns 46 passing cases. This adds regression
evidence for the existing contract, not a new live return/recovery claim.

At `eebc04890a2`, an owned loopback model exercised installed Claude Code
2.1.308 and SDK 0.3.302 through the production Station service and adapter.
An explicit foreground Agent made its own model request and returned exact text
to the parent. Persisted child-work facts retained that text as `tool-return`;
the owner-authorized transcript reader recovered it and refused a foreign user.
Closing and reopening SQLite in a fresh service with no adapters preserved the
same provenance and transcript access without another model request. All 13
probe checks passed. Relabeling the production return as `provider-summary`
failed the two provenance checks with 11 controls passing; byte-identical source
restoration passed all 13 again. The final harness also exits nonzero on failure
and requires successful shutdown, a closed listener and no adapter sessions.

The initial probe is retained as failed evidence: it omitted the explicit
foreground flag and read a turn window rather than unscoped child-work history.
Independent source/evidence review accepted the corrected controls without
independently executing them. This establishes controlled native foreground
return and cold SQLite/service reconstruction. A separate fresh Node process
then reopened the closed store with no engine adapters: transcript recovery,
persisted provenance and foreign-user refusal passed all three checks. This
does not establish crash recovery, native reattachment, full server boot,
every background/order/error case, independent network isolation, real-provider
behavior or full #1879 acceptance.

At `2e7b5a4fffe`, an owned-loopback installed-Claude background child emitted
partial text and stayed running until the exact task-scoped Stop request. Saved
native events settled that child as `cancelled`, retaining its description only
as `provider-summary`, without a `tool-return`. The exact parent initial turn
still completed normally. The runtime harness itself failed: its predicate used
`canceled` rather than the contract's `cancelled` spelling and timed out after
the correct settlement. That failed receipt remains; no native invocation was
repeated to correct the assertion.

A fresh Node service with zero adapters read a SQLite backup of the saved run.
Nine checks passed, including stopped/provider-summary labels, reachable
owner-scoped child transcript and foreign-owner refusal. The transcript retained
the authored child prompt, not the uncommitted partial narrative. Independent
source/artifact review corroborated the exact child and parent events, while
preserving the failed runtime-run status and the mounted-UI, HTTP-authority,
crash, reattachment, provider and fiscal limits. The read-only qualifier now
requires a nonempty settlement set; its first self-matching process scan is
retained separately from the corrected exact-marker/ancestry-excluding scan.
These saved facts support the bounded no-return control, not a successful
original harness or full #1879 acceptance.

At `3669442358f`, the existing audited Agents-pane browser journey passes both
desktop and 390px phone-width cases against a built isolated Station. It checks
CLI provenance, engine identity and live child activity, single Stop controls,
No result after exit, scope persistence across reload, and the phone action note
and Background tasks sheet. Orchestration events/read models are mocked at the
named fixture seam. E2E types and fixture policy pass. This is browser-fixture
evidence, not alternate-theme, independent visual, native-device, provider or
group-serving acceptance. The runner removes successful screenshots at cleanup.
An initial run stopped before tests because the invocation supplied DNT, which
correctly refused its disclosure acknowledgement; the corrected run unsets DNT
and keeps telemetry Off in its isolated runtime.

At `6b2e933890b`, the canonical iOS simulator build passed its native artifact
verification. The installed binary matched the built binary, and the simulator
paired to an ordinary isolated Station reporting that same checkout revision.
A registered CLI delegation through OpenCode GLM-5.3-Flash returned its exact
challenge. Its task completed while the retained Session read `ready`; a CLI
continuation used the same Session, visibly ran in the native client, then
returned to idle. The native Home row labeled its directory separately from
Project membership, and Activity showed the completed work under Just finished
with CLI origin. A separate browser client showed the same item and origin
before and after reload, without mocked routes.

Native relaunch initially failed: Activity showed its unavailable boundary on
two cold launches, and one manual Retry after startup recovered the real list.
An independent source review identified a publication loop while the inventory
query has no data. The real Activity shell, SDK query and review provider
reproduced React's maximum-update-depth exception with a deferred inventory
response. Repair `8767c2dc482` creates the empty inventory inside the existing
memo rather than on every render. The two-file selection passes 148 cases;
restoring the old fallback fails both new cases with 12 controls passing, and
byte-identical restoration passes all 14 owner cases. UI types and Biome pass.

The exact repair build and same-revision server then loaded Activity on two
cold simulator launches without Retry, retaining the real CLI conversation and
origin. The installed binary matched the built artifact. Independent delta
review found no production blockers; its test-observability finding was repaired
at `d4d3610b35a` and accepted by source review. That test-only follow-up waits
for mounted Activity content before releasing query restoration and passes all
14 owner cases. Native evidence belongs to `8767c2dc482`, not a later build.
The physical phone remained unreachable; simulator evidence does not complete
physical-device or full #2868 acceptance. Generated Apple project changes were
archived and restored; the isolated runtime and owned simulator were stopped.

The compact roster, logos, animation, sender provenance, delegated result
delivery, and phone transfer guards already contained in #3991 remain master
work. Source containment is not final runtime/native/provider acceptance.

## #91 and folded work

At `d835da49916`, Station consumed published Flow Agents 9.4.0.
Upstream implementation PR #1543 and generated release PR #1544 merged;
the registry artifact and Sigstore provenance name release commit
`dcbad2e736cc5ffc6e93b6412d4b92239bb292f1`. Archive integrity, 197 included
source files against Git blobs, two npm signatures under one unexpired registry
key, and the exact provenance workflow/tag/source joins pass. All 36 typed
public exports import from inside the extracted artifact. Its declared
production dependency map matches the prior installed graph; this is not full
runtime compatibility or generated-code reproducibility evidence.

At that checkpoint, all four pins and the managed lockfile selected 9.4.0. Normal managed installation,
approved lifecycle/native checks, hook arming and the real PTY handshake pass.
All 12,415 installed artifact files match the registry archive. The existing
persistence/runtime/group integration selection passes 29 cases across three
files. Independent source/artifact review finds no dependency-delta blocker;
it does not independently rerun those checks. Serving preparation, physical
transport and rounds adoption remain unfinished. Controlled retained-accounting
integration is qualified below; no production settlement caller is wired.

The earlier Flow Agents 9.3.0 adoption is retained as history below.
Upstream PRs #1535 and #1536 merged, and the
release artifact identifies `ab2b320aeec4bf1ec98e1ff4ae456877863bd5b7`.
At that stage, Station's four workspace pins and managed lockfile selected 9.3.0. After authorized
archival of the failed installer receipt, the normal managed install completed;
approved lifecycle/native checks and the PTY handshake passed. The installed
package's 367 inspected artifact files match the verified tarball. Managed
installation does not establish supported group execution or provider acceptance.

The published 9.3.0 pin and managed installation were explicitly authorized.
On 2026-10-22, Brian authorized resuming upstream contract work and publication
as needed for the full epic after the controlled CLI consumer worked. This
lifts the earlier generalized migration/publication hold. Station still consumes
published contracts rather than sibling internals; upstream release and the one
combined Station epic PR retain separate acceptance evidence.

Before implementing group execution, bind the published authority and
persistence contracts for create/get/list/events/cancel, ready seats, aggregate
reservations, idempotent accounting, source identity, timeout/cancellation, and
raw member outputs. Flow owns frontier/join/gate semantics. Do not implement a
competing DAG or promote a roster, majority vote, or coordinator narrative into
acceptance. Independent advisory groups still need explicit bounded policy and
durable accounting; they are not implemented by the existing roster.

#107 now has local implementation: recorded delegation annotates the actual
assistant execution row through the existing attribution badge. Streamed and
settled rows share the source; unrelated older executions receive no inferred
posture. Delegation does not imply read-only execution or sandbox guarantees.
Independent source review and mounted checks passed; final exact-head browser
and native acceptance remain open.

The mobile streaming branch still hid that annotation. Repair `04ca8a88748`
renders the existing badge from the recorded posture prop without adding an
engine or authority inference. The new mounted case fails on the previous row
with two controls passing; removing the mobile badge also produces that intended
failure. Byte-identical restoration passes 36 caller/row checks and UI types.
Browser qualification then found the existing light-theme posture color at
2.62:1 contrast. `2900e69eda6` uses the shipped caution text token: the controlled
streaming-row harness measures 5.73:1 in light and 6.20:1 in dark. At 390px,
worker/task/absent transitions render without horizontal overflow; a 1280px dark
control also passes. The final four-file selection passes 48 checks. Independent
source and CSS delta reviews found no actionable issue. This is a synthetic
browser component check, not a native-phone or live delegated-session receipt;
the separate caller tests cover recorded-session identity selection.

#600 has a reviewed local preset/preparation increment: the public Ensemble contract parses
versioned named members and renders roster-aware briefs; the server loads exact file bytes/hash
and prepares frozen member options through existing resolution plus mandatory authentication
receipts. Unsupported option values and ancestor/descriptor substitutions refuse. Forty-six
focused tests and bounded independent review cover these source boundaries. Actual-context
credentials, launch/session identity persistence, preset UI entry points and roster delivery
still need adoption evidence. A local `station ensemble inspect` CLI now reports bounded exact
file bytes/hash, parsed declarations and roster without authentication or launch. Its independent
review passed bounded caller probes. Source-launcher and local bundled-command inspections agree
on exact bytes/hash and roster at `a9acb0625863aa83674fafc023e3e39c5b6ca843`. Published CLI/contracts
availability remains open; this does not complete #600.

The live-group inspector now derives a read-only dependency graph and its
accessible member table from the same authorized group revision. Nodes retain
seat identity, edges show declared prerequisites, and states remain explicitly
last observed. Fixed grid placement adds no scheduler or inferred execution
order. Retained preset hash and exact session/turn handles remain available;
current preset files are not joined by name. Mounted coverage and the UI type
lane pass. An edge-omission mutation fails the mounted owner assertion, and
byte-identical restoration passes all five cases. Independent review found
same-row arrowheads hidden by cards; gutter routing repairs that geometry.
A controlled browser inventory exercises adjacent, skipped-column and upward
edges in dark desktop and light 390px layouts, with keyboard-scrollable graph
and table regions. Narrow preset hashes wrap without page overflow. This is
component/SDK fixture evidence. Independent source review accepts the repair
for same-row, skipped-column, upward, self and cyclic edges across 1–16 members;
overlapping trunks remain possible and the table preserves exact dependencies. This increment does not supply richer runtime tool/memory/routing
facts or complete #453/#600.

At `c5caf44956f`, the group form can inspect its actual receiver draft before
saving or starting. The existing inspector accepts exact uploaded preset bytes
and Agent/expected-engine/workspace bindings, projects declared prerequisites,
and labels missing or disabled MCP definitions without claiming effective grants.
The prelaunch inspector now retains each declared prerequisite list on its own
configuration fact. The diagram derives prerequisite arrows and fact references
from those same records, alongside member-to-setting relationships; it creates
no second execution graph or ready frontier. Node cards and labelled prerequisite
links reach the corresponding table rows. Prerequisite links have 44px minimum
targets; arrows themselves are not narrow interactive targets. Legacy inspection
records without the optional list keep their configuration-only diagram.

At `9a17c4f7e9e`, the HTTP/mounted UI/layout selection passes 35 cases.
The pre-implementation controls fail in three intended places with 32 controls
passing after correcting a shared-fixture mistake. Discarding only prerequisite
edges produces two intended failures with 11 UI/layout controls passing;
byte-exact restoration passes all 35 again. Independent source review found
indistinguishable node link names across members. Repair `ebd04baaf54` includes
member/category identity; its regression fails on the prior source with 11
controls passing and passes all 12 UI cases after repair. Delta review closes
that finding without claiming independent execution. A separate verifier passes
nine pure-layout probes, catches an endpoint-reversal mutation with two intended
failures and seven controls, and restores nine passing probes. That evidence
covers the helper, not mounted UI or runtime integration.

Synthetic Chromium checks at 1280px dark and 390px light show visible arrows,
correct fact targets, large node links, 44px prerequisite references and keyboard
navigation that scrolls an off-screen node into view without page overflow.
The first arrow-only targets were too narrow and were replaced by labelled
references. T3 snapshot automation timed out twice; installed Chromium supplied
the browser check. UI/server-test types, lint and canonical MCP generation/check
pass. These are controlled component and fixture results, not native/provider,
hosted, complete topology or whole-epic acceptance.

At `0801039607e`, the real HTTP inspector test also binds refusal of a
prerequisite ID absent from the preset: `422 ensemble_inspection_invalid`, before
additional capability reads. The existing valid uploaded draft remains the
positive control. All 21 cases pass. Removing only the unknown-prerequisite
guard produces one intended failure (200 instead of 422), with 20 controls
passing; byte-exact restoration returns 21/21. The initial diagnostic expected a
missing-state projection and failed because the existing guard already refuses
the request. That diagnosis was corrected rather than changing production to
fit the test. This adds regression evidence for existing validation, not a new
readiness, launch, provider or topology-acceptance guarantee.

Host-browser inspection does not gain the local grant needed to read host preset
paths. The shared table/diagram renderer keeps origin, state, owner and resolution
receipts visible; editing the draft discards that observation. Saving and running
still resolve and authorize the current configuration independently.

Focused HTTP/UI/SDK evidence passed 30/30, with server-test/UI types and lint.
Running the new regressions against the preceding route/service produced four
intended failures; removing the host-path local-grant guard produced two intended
failures. Byte-exact restoration returned 30/30. Independent source-only review
found no confirmed P1/P2, without independently executing the tests or browser.
This is configuration observation, not full launch-equivalence validation:
filesystem admission, authentication and caller-scoped dispatch remain separate;
memory, external routes and portable authority remain unfinished. No live-provider,
hosted, browser-layout or full #453 acceptance follows from this increment.

At `af67f9c5526`, Project-bound inspection adds canonical Project MCP defaults,
configured knowledge namespaces and registered Project-store metadata. Namespace
precedence is shared with the existing KnowledgeService. The bounded zero-write
registry observation is rechecked before response publication; unknown registry
state is not an empty inventory. Directory-only targets inherit none of these
Project facts from a matching path. Content and raw storage paths stay private;
operator-authored labels are displayed metadata, not comprehensively redacted.

HTTP and KnowledgeService focused evidence passed 45/45, including actual registry
file drift and a 16-member projection with bounded details and request-scoped
Project reads. Server-test types and lint passed. The preceding inspector fails
four new assertions with sixteen controls green. Inverting the registry comparison
produces ten failures and ten passes: stale bytes are accepted and unchanged bytes
are over-refused. Byte-exact restoration returns 45/45. Independent source-only
review found no confirmed P1/P2; no independent execution or browser proof is
claimed. Registered metadata does not establish usable stores, retrieved/injected
content, shared conversation memory, engine tool delivery or write authority.
External routes, full launch equivalence and portable authority remain unfinished.

At `9ede735b5e4`, each member form offers an explicit Project binding while
Directory remains the default. Only the selected workspace kind is sent; toggling
retains both drafts locally without leaking the inactive directory into a Project
request. Inspection and saving use the same parsed binding. The inspector accepts
Project IDs up to the existing group contract's 256-character bound, rather than
applying Agent identity syntax. The receiver still resolves and authorizes the
actual Project workspace and defaults.

Focused real HTTP and mounted UI evidence passed 32/32, with UI/server-test types
and lint. Substituting the parent production form and route causes exactly two
intended failures, leaving thirty controls green; byte-exact restoration returns
32/32. Independent source-only review found no confirmed P1/P2. The UI fixture
proves serialization and local draft behavior, not server persistence, launch or
real-browser geometry. Native/provider/hosted and full epic acceptance remain
unverified for this increment.

A subsequent isolated Chromium run mounted the current form and shared inspector
with synthetic SDK responses. At 1280px dark and 390px light, Project/Directory
toggling preserved both drafts, the request carried only each selected workspace
kind, keyboard Space toggled the control, and no control or page overflowed the
viewport. The provenance table retained its own horizontal scroll region at the
narrow width. Visual inspection found the general input styling enlarged the
checkbox; the follow-up keeps a 16px checkbox inside a label with at least a
44px target. The browser check was repeated after that repair. This establishes
component geometry and interaction only; responses were synthetic and no runtime,
provider, persistence or hosted acceptance is inferred. The first harness omitted
the SDK credential resolver and refused inspection; that harness setup failure is
retained separately from the corrected run.

Published Flow Agents 9.3.0 exports v2 authority/grants, ancestor allocations and
invocation holds, a durable group controller, Flow-owned scheduling, mailbox
admission and bounded no-tools context acknowledgement. Station now composes the
public controller with its host-fenced persistence owner. Diagnostic probes
against the verified artifact exercise metadata operations and staged-write
revocation. Managed focused tests now exercise persistence, runtime metadata and
observation owners; serving composition remains unverified. These checks do not
establish provider metering or supported group execution. After the main merge at
`98d885a7ad5`, Station's root Flow is 5.2.1; published Flow Agents 9.3.0 retains its
own declared and resolved Flow 5.2.0 dependency. Dependency-specific findings stay
bound to that graph. Dispatch/Relay 0.7.1 supply physical reservation APIs.

Retain the folded detail records #73, #107, #205, #432, #453, and #600 as
acceptance obligations. Closed-as-batched is not implemented. In particular,
permission posture, envelope authority, context ACKs, team presets, and topology
inspection need their own real producer and caller evidence.

## Scope and delivery priority after audit

The independent scope audit found real published contract gaps and broadly
appropriate product boundaries, but identified production adoption as the main
unfinished work. Station's separate hard-cap API group runtime still refuses
runtime resolution, invocation and request execution. More isolated framework tests cannot complete
that path. The earlier hold on upstream publication and generalized authority
migration was lifted after the controlled CLI consumer worked. Flow Agents
9.4.0 is now published and adopted, as qualified above. Continue the full
serving integration against that published contract while preserving existing
groups, charges and fail-closed behavior.

The first working group will use existing signed-in CLI engines and Station's
existing session authority, permissions and confinement. This is the owner's
chosen first integration path. Portable Flow-envelope lineage remains explicitly
unbound/incomplete; #205's full lineage and restriction requirements remain open.
Hard dollar caps, physical-attempt limits and native token bounds must be reported
unavailable when the selected engine cannot enforce them. Unknown cost is never
zero. Direct API qualification and tariff work remain preserved for a later path.

Keep the full epic and one-final-Station-PR rule intact. The CLI increment does
not complete peer/SSH lineage, context synchronization or the remaining folded
requirements. Published-contract availability removes the upstream wait;
authenticated preparation, provider qualification, execution and rounds custody
remain Station implementation obligations.

Preset-derived groups now retain each member's codename, color and role beside
its stable seat identity. The inspector reads that saved roster after execution;
older groups retain the seat-ID fallback. The server rejects roster/seat
substitution on read. Focused real-service and SDK/UI checks cover this identity
path without exposing prompt additions. At `de1888c324b`, a real read-only
browser inspection passed light/dark at 1366px and 390px plus reload. The first
fresh-browser login attempt never observed bootstrap and is excluded; the
corrected harness required bootstrap 200 before proceeding. Collaborative
snapshots timed out twice, so screenshots use isolated local Playwright. The
group was created and canceled with zero dispatches and zero provider calls.

That check exposed the wide member table's missing named keyboard entry point.
Repair `206adac1810` adds it and a focus indicator. A fresh real browser check
passed Tab/Shift+Tab entry and over 400px of ArrowRight scrolling in both narrow
themes; retained labels/colors and reload also passed. A compiling tab-order
mutation failed the panel regression and byte-identical restoration passed.
This is read-only presentation evidence, not native, second-device, a new live
member run or full-run identity acceptance. The isolated runtime was stopped.

The independent member-identity review found an upgrade replay gap: adding the
derived roster changed the create digest for an existing operation. Replay now
accepts the legacy preset projection only for a stored roster-less record with
unchanged source and launch inputs. It returns the old record without inferred
names; new records still bind their full identity. Focused owner checks cover
changed-hash/brief refusal, case-duplicate corruption and the UI seat-ID fallback.

CLI groups now accept an authored `maxDispatches` allowance for reserved seat
starts, including zero. The locked intent reservation consumes it before the
launcher; refused and unknown reservations are not refunded. Exhaustion closes
further admission durably and appears in group views and revision events.
Reopen and same-operation replay cannot reset or increase it. The SDK/CLI and
browser form carry the policy; the inspector labels reserved starts and
exhaustion. This is a logical host count only. The fiscal, token and physical
provider-attempt guarantees remain unavailable, and Flow owns joins/outcomes.

Independent reviews accepted the scoped legacy-replay repair at `188131f4f4f`
and reserved-start allowance at `fe5fc622b02` without blocking findings. The
allowance review independently passed 48 cases and caught a compiling boundary
mutation. At `fe5fc622b02`, the real registered CLI and browser form each saved
and supervised zero-start groups: no seats were dispatched, the event-store
count remained 238, replay retained exhaustion and an allowance increase under
the same operation returned 409. The browser inventory disclosed exhaustion;
repair `407c9f58139` also shows it directly in the form's returned run result.
That UI repair has controlled regression/mutation evidence, not a new live run.
Both test groups were canceled and the isolated runtime was stopped.

The no-tools continuation gap remains open for OpenCode/Codex and general effect
suppression. A non-model OpenCode probe on this
host found CLI 2.0.32 rejects the existing `debug agent` command and advertises
`debug agents`; the latter returned an empty list under the process-local deny
overlay. This is no resolved-policy or tool-enforcement proof. Shared engine
configuration was unchanged, and no provider turn ran.
Inspection of the installed Claude SDK also shows that `tools: []` removes
built-in tools only, while `setMcpServers({})` retains plugin-owned servers.
Neither control alone establishes an all-tools-disabled continuation of the
same delegate session. The generated installed Codex `turn/start` protocol has
no direct all-tools-disable field; that is not proof that no alternative native
mechanism exists. Those observations alone did not support exposing a sync
action; the later source increment below uses a separately qualified native
restriction.

At source `6206ff52961`, owned native probes used Claude Code 2.1.308 and
Agent SDK 0.3.302 with deterministic model responses served only on loopback.
They started no real-provider model turn and changed no shared configuration.
An ordinary native hook denial blocked Write, but a thrown hook callback let
it execute under bypass mode. This is not a failure of Station's staged policy
translator, which already catches evaluator errors. A live flag-layer wildcard
deny blocked Write and a late-added SDK MCP tool in the uncontrolled-policy
fixture. Native permission-state reads then confirmed that managed-only policy
marks that flag-layer rule `notInEffect`, while command-line deny rules remain
effective. A control acknowledgement alone cannot admit a sync restriction.

A separate restart probe retained one native Session ID and its prior history
across ordinary, restricted and restored activations. The restricted activation
used an empty builtin tool set, the SDK builtin deny catalog and `mcp__*`.
Injected Write and SDK MCP calls, including an MCP tool added after activation,
did not execute; restoring an ordinary activation restored their effects.
A missing native resume ID refused before any local-model request. These are
installed-runtime execution probes, not an integrated Station sync path.
MCP tools still appeared on the model wire, so the probes' stronger empty-wire
assertion remains failed. Plugin and delegation-tool coverage remains unverified.

The installed SDK explicitly warns that `BUILTIN_TOOL_NAMES` is incomplete;
it cannot define an all-tools restriction. Follow-up native probes replaced
that enumeration with command-line `disallowedTools: ['*']`. Write and
late-added MCP effects were blocked under managed-only permissions, including
a control that kept Write in the base tool set. Native permission-state reads
reported the wildcard as an effective `cliArg` deny before and after flag
settings replacement and clearing. The same retained-session sequence restored
both effects afterward. These probes remove the catalog dependency for the
candidate; they do not establish plugin, delegation or direct internal-call
coverage. The stronger empty-wire assertion still failed and is retained.

At that stage, independent source review supported a candidate model-tool
restriction for the checked CLI/SDK pair, not universal no-tools authority. It
required production work to bind the group caller to an exclusive per-thread activation generation,
coalesce only matching policy/identity starts, confirm the old engine exited,
and recheck the generation before send, persist logical attempts before
effects and exact per-member ACK receipts afterward, retaining ambiguous holds.
Ordinary mode had to return through another exact native resume. The following
increment implements these local controls. Codex/ACP sync
enforcement remains unqualified; context sync and full #432/#205 acceptance
remain open. No physical/token/dollar guarantee follows from these probes.

A production sync increment now connects the session-group HTTP/SDK/CLI caller
to durable logical-attempt reservations and an exclusive retained-session
activation. It uses command-line wildcard denial, exact native identity and
configuration binding, exact ACK comparison and one completed tool-free mismatch
retry. The latest receipts are visible in the group inspector. At source
`38357c0fb20`, the implementer reports 453 focused baseline cases and 408 repair
cases, TypeScript 7 server checks, and two mutation catches with byte-identical
restoration. Independent source review found unsupported-engine reservation and
terminal-authority gaps; delta review accepted the repairs without new confirmed
P1/P2 findings. It did not independently execute tests or mutations.

An owned loopback model then exercised the actual group/service/Claude adapter
with installed Claude Code 2.1.308: one native conversation retained prior history
and folded context, exact ACK persisted, an injected Write was denied and recorded
as failed without retry, and an ordinary resumed turn restored advertised tools.
The initial harness omitted the canonical session refresh and refused preflight;
that receipt is retained alongside the corrected probe. No real-provider model
request or shared configuration write occurred. An independent owned-loopback
run against pinned primary source then rejected a trailing-space ACK after two
attempts, blocked Write after one, and restored ordinary tools/history in the
same native conversation. Its first workspace-linked run is excluded; the final
run used archived workspace packages and two declared generated artifacts whose
generation was not verified. Its archive briefly exceeded the 200 MiB bound
before being reduced to 84 MiB. These limits remain part of the evidence. This
does not close plugin/delegation/internal-effect coverage, real-provider sync,
#205 restrictions, fiscal guarantees or full epic acceptance.

A later owned native plugin control at `c88113b55f7` uses the same installed
Claude/SDK pair and a deterministic loopback model. A plugin-owned MCP marker
tool executes in ordinary and restored activations of one native conversation.
During the restricted activation the wire has no tools, an injected call returns
an error and no marker is written, while prior history remains. Removing only
the wildcard deny in a separate harness makes the marker execute and the probe
fail; the original harness passes again. The first strict-MCP fixture loaded no
plugin server and is retained as failed prerequisite evidence, not denial proof.
This is direct installed-runtime evidence, not production sync with plugins,
real-provider sync, arbitrary plugin startup/hooks, delegation/internal effects
or portable/fiscal authority. Independent source/artifact review found the
control nonvacuous, while noting that the harness pass flag alone omits several
failure and cleanup predicates. The qualification separately checks those
recorded failures and a current exact-owned-path process scan; historical
listener identities were not retained.

At `ff10907787a`, a further owned loopback check exercises the production
`CliSessionGroups` → `OrchestrationService` → Claude adapter path with native
Agent delegation. Ordinary and restored turns produce child model requests.
The retained-session sync ACKs without tools; an injected Agent call during a
second sync produces a native error, no child request, and one failed retained
attempt without retry. Both sync receipts name the same native identity hash
and prior/folded history remains. Separate direct-native controls remove only
wildcard denial and catch the restricted child request; that mutation does not
claim to mutate the production path.

Independent source/artifact review accepts those bounded observations. Child
detection uses the controlled prompt marker, not an inventory of all internal
effects; two positive requests per ordinary phase are not labeled one physical
invocation. Qualification checks recorded errors and current owned-path process
absence separately from the harness pass flag. HTTP routing, production plugin
composition, other engines, real-provider sync and fiscal authority remain open.

Preset-derived run supervision now has an all-member actual-context login
barrier before Flow claims, seat reservations or member sessions. Unsupported
observers are identified for the whole roster before any login command; current
Codex/Claude observers receive cancellation/deadline signals. Private run
observations bind the persisted group intent and selected context, refresh stale
pending-member login observations, and contribute synchronous currency fences
to the existing initial session/turn effects. The route reuses ordinary target
permission checks before each probe. This is login only, not model entitlement,
portable authority or fiscal enforcement. ACP/OpenCode preset runs now refuse
before any member starts; manual groups retain their current path.

The previous run owner fails the mounted final-member unauthenticated regression
with 200 and three starts. The new three-file group/auth selection passes 84
cases; the expanded real-route preset case also covers unsupported observation,
configuration drift, cancellation during a held probe, effect-time drift and
completed replay without fresh authentication. Both native-adapter refresh controls also pass: stale concurrent dispatch
requests share one login refresh, old fences refuse, and abort reaches the native
status command without a model invocation. A later per-seat login refusal stays
visible on its pending seat without consuming a reservation; its owner regression
fails before the publication repair and passes afterward. Final combined
validation, mutation/restore and independent delta review remain pending. No new live provider claim follows from these fixtures.

The native-context P2 repair is in progress: a private object-identity continuation
now reaches the actual Codex and Claude spawn wrappers, checks resolved profile,
executable/environment/argument context, and retains bounded local auth/config
witnesses. Scalar copied observations refuse before reservations. Controlled
adapter/spawn tests exercise drift after receiver-resolution awaits and benign
native bookkeeping. The four-file selection passed 92 cases before the final SDK
metadata normalization. Unsupported OS stores and detected dynamic/managed policy
refuse; no complete native policy inventory, live provider, hostile-host or
post-spawn continuity claim follows. Baseline proof, mutation/restore, final
qualification and independent P2 disposition remain pending.

Independent review of `14e4392293a` confirmed that the private carrier and actual
launch comparisons materially repair the direct context gap, but found a residual
P2: Claude's local `remote-settings.json` policy cache was omitted. The follow-up
adds effective-config and default-home refusal/absence witnesses and refuses
remote-policy environment overrides. On the pre-fix committed source, the new
cache regressions fail four cases with 58 controls passing: a present cache was
accepted before login, and a cache created inside lazy SDK startup reached the
mocked spawn. The final executable-drift case now changes Claude's executable
inside that same lazy callback, after profile resolution, to bind the final guard
uniquely. Repair qualification and independent disposition remain pending.

An installed-native loopback qualification at `84bdb2c8f00` exposed a separate
first-query compatibility defect: Claude's SDK stamps `CLAUDE_AGENT_SDK_VERSION`
into the parent process environment after login, invalidating the inventory's
ambient fence. Both real login observations passed before the first member was
refused; no model request occurred. The failed receipt is retained. Reproducing
the installed SDK transition in the owner fixture fails both Claude launch
variants with 60 controls passing. The repair excludes only that SDK telemetry
stamp from the ambient comparison; authentication-variable changes still refuse.
This is not yet native success evidence; qualification continues on repaired source.

The next installed-native attempt at `c8191efaa8c` reached the child-launch fence
and identified one additional SDK default: `CLAUDE_CODE_SDK_READS_SESSION_STATE=1`
is added to the child environment when no case-insensitive key was supplied.
No model request occurred. The owner fixture reproduces that SDK transformation
and fails both Claude launch variants on the pre-fix source, with 60 controls
passing. The continuation now binds exactly that default when the observation
omits the key, while retaining and comparing an explicitly observed value. A
changed child value still refuses; this variable is not a blanket env exemption.
Native successful qualification remains pending the repaired run.

At `d64e3156fc5`, the corrected owned-loopback probe passes through actual preset
composition, group preflight, published Flow scheduling, OrchestrationService,
SDK 0.3.302 and installed Claude Code 2.1.308. Both native login observations
complete before either member starts. Two distinct native conversations receive
roster-bearing briefs and return the authored per-member outputs; saved exact
initial-turn events finish with `stop`, and Flow reports the group completed.
Creation starts nothing. Shutdown closes the owned listener/store/service and
leaves zero adapter sessions; a current check finds no process matching the owned
home, Station handles or persisted native cursor strings.

Independent source/artifact review accepts that bounded run. Dispatch was
hand-composed, so this does not qualify canonical HTTP resolution or caller
security. Roster names were checked for presence, not byte-exact prompt fidelity;
two native cursors do not prove resume continuity. The synthetic loopback token
is not a real-provider account, entitlement or billing observation. Complete
native configuration/OS/remote-store and post-spawn continuity remain unverified.
All five earlier setup/compatibility attempts remain retained as failures. The
two SDK repairs each have prefix/mutation failures with 60 controls and a restored
62-case owner pass. Current main integrates normally at `11b999a993c`, including
Vitest 4.1.12 and the macOS installer work; managed installation and real PTY
handshake pass. Native evidence stays bound to the earlier `d64e3156fc5` source.

At `ad49502d1ed`, an isolated `StationRuntime` qualification exercises the
production HTTP security and group routes with installed Claude and an owned
loopback model. The per-boot local-grant exchange succeeds; the same preset
request without a credential returns 401. Creation starts nothing. Both members
authenticate before the first session starts, receive roster-bearing briefs, and
complete in prerequisite order with two logical dispatches and two loopback model
requests. All eight probe checks pass, and the allocated listener ports are
closed after the owned process exits.

Four failed setup attempts remain retained: an invalid client-instance identity,
an unadopted native connection, a runtime-configuration reconciliation window,
and the diagnostic run identifying the unsupported inventory entry. The final
helper adopts the connection through its registry owner and observes stable
configuration before submitting. Its wrappers forward original arguments and
results; they do not replace authentication or dispatch. The first attempt also
left a listener after awaited shutdown; its owned process was terminated, and
later helpers explicitly exit after awaited cleanup. This qualifies the exercised
HTTP/native path, not the `index.ts` entrypoint, a real-provider account, model
entitlement, billing, resume continuity or whole-epic acceptance.

At `016b53f11b7`, a second completed two-member loopback group is reopened by a
fresh `StationRuntime` process using its retained synthetic owner credential.
The roster, member session/initial-turn identities and terminal references match
the stored group. Authorized session-event reads return both exact authored
outputs. Completed replay starts no session, probes no login and makes no model
request; a new local credential receives 404 when attempting to run that group.
All seven recovery checks pass. An earlier recovery assertion incorrectly
expected the local operator's cross-credential inspection to fail; its failed
receipt remains retained, and the corrected check targets owner-only mutation.

Two intervening fresh-start attempts refused before any model request. Creation
failed during configuration reconciliation in one; the other failed inside its
first login probe without a captured exception identifying the cause. The
successful retry does not establish reliable immediate post-listening admission.
These failures require further investigation; no fence was weakened to obtain
the successful run. Restarted completed replay is not native conversation
resumption.

## Production adoption sequence

The personal `/api/orchestration/session-groups` path now composes the shared
authorized delegation handler with installed Flow scheduling. It persists seat
launch intents and reserved session/client-turn identities, retains returned
provider-turn identities and admits dependencies from an explicit Station
completion observation. Controlled HTTP tests cover three actual orchestration
sessions and event-store joins, plus refusal at the adapter boundary after
cancellation during Agent preparation.

The `44fc5580235` repair restricts that observation to the shared positive
provider finish-reason authority. An absent or `other` finish reason retains
uncertainty and cannot release a dependent. The HTTP route suite passes 21
cases after byte-identical restoration; a compiling authority-broadening
mutation produces the two intended failures. Independent source review found
no confirmed P1/P2, without borrowing execution evidence. This is initial-turn
completion authority, not semantic acceptance or a live-provider qualification.

At `fe998248b601ac6f5e135267ca2866d6772a5164`, an isolated personal Station
completed a live three-seat group through the registered CLI and existing
signed-in OpenCode `zai-coding-plan/glm-5.3-flash` connection. All three returned
their requested short challenge text. The first two provider turns overlapped
for 1.442 seconds; the third began after both exact predecessor turns completed.
After a runtime restart, supervision replay returned the completed group with
one accepted turn per member and no additional turns. The engine reported
context usage, not a reliable dollar charge; billing remains unverified.

That live check first exposed the runtime's one-at-a-time startup lease: a
concurrent start refused while the other member completed. Earlier unknown
records were retained and canceled, never resent. The repair queues supervised
starts on the same bounded runtime lease and leaves ordinary callers' immediate
refusal behavior intact. A compiling wait-bypass mutation reproduces the
failure in the real CLI/session integration test; byte-identical restoration
passes. Independent review of the original session-group owner found no P1/P2
findings; the startup/client delta also passed bounded independent review.
The later member-attention delta passed independent review without P1/P2
findings. Its three load-fragile one-second test waits now use the file's
existing ten-second helper; the repaired route file passes 14 focused cases.

At `ca15aa85c11`, another isolated live group completed with two OpenCode
`zai-coding-plan/glm-5.3-flash` members and one Codex `gpt-6-luna` member at low
effort. Each returned its exact challenge text. The first two turns overlapped
for 3.234 seconds; the third started after both initial completions. The CLI
journal follow read exited cleanly on SIGINT. A real browser read of that group
showed its completed Flow projection, three member/session rows and exact
dependencies, and retained the not-assessed acceptance disclosure after reload.
The 390px layout had no document overflow. No routes or runtime responses were
mocked for that check. Collaborative preview snapshots timed out; the evidence
uses isolated local Playwright instead and is not a second physical device.
The server identified its revision as checkout-derived, not a packaged build.

An earlier Claude/Flash group failed at Claude's weekly usage limit. Its failed
seat remained failed, its dependent stayed pending, and the group was explicitly
canceled rather than retried. Inventory readiness was not live entitlement.
No shared proxy configuration or credentials were changed. Dollar/token/physical
attempt guarantees and real subscription charges remain unavailable.

The first live form-elicitation attempts completed without calling the requested
MCP tool and are excluded from elicitation acceptance. A direct installed-Codex
control after an exact thread inventory read did call it and returned its form
answer; that bypassed Station and is diagnostic only. The adapter now checks
thread-bound authored MCP inventory before reporting a ready session, and
refuses a turn while the session is still connecting. Focused startup-order and
inventory-refusal checks pass. At that checkpoint a fresh live Station
elicitation check remained required; the earlier model refusals are not
silently converted into success.
The next run did call the tool, but the connection's native `never` approval
policy declined its form before Station received it. Its completion text is
not answer evidence. The Codex MCP edge now maps supported data forms into the
canonical input-request contract and returns validated content through the
exact-event reply path for supported nonempty data forms. Empty-schema and
unsupported elicitation retain the existing approval path and cannot supply
form content. A subsequent live check used an explicit asking posture
without changing shared connection/proxy configuration. That group opened no question and returned
`NOT_ACCEPTED`; it is also excluded from live elicitation acceptance. The
controlled real-service form case now passes: invalid credential, foreign event
and invalid content reach no adapter response; a valid exact answer reaches its
request once, returns raw output only through the authorized task read, and
releases the dependent. These are separate from live-provider proof. The
startup availability review accepted the bounded guard and highlighted that
one-shot inventory reads do not poll until readiness. Closed diagnostics now
identify refusals without retaining native error text.

Independent review of the form increment at `b66daf94ba4` found no blocking
findings and independently exercised the exact-event/content path, native reply
acknowledgement, sanitized diagnostics and real-service group integration. It
left live answered elicitation open. Its diagnostic reason assertion advisory
is addressed by pinning the expected closed reason for each inventory defect.

At `a39212fabf0`, a fresh live Station CLI group answered the controlled MCP
form through Codex `gpt-6-luna` at low effort alongside two OpenCode
`zai-coding-plan/glm-5.3-flash` members. The earlier asking-mode failure's exact
native transcript showed a lookup for the bare tool name, not a tool call.
The new brief discovered the qualified callable by suffix and invoked it once;
no production permission or shared connection change was needed.

The dependent remained pending while the form was open. A mismatched opened
event was refused with 409, the exact answer received 200 and an engine
acknowledgement, and a duplicate received 409. The MCP server recorded one
accepted `ELICIT_OK`. All three initial turns completed once, returning
`ELICIT_OK`, `CONTROL_OK` and `JOIN_OK`; the first two overlapped for 2.5 seconds
and the dependent started after both completed. Authorized raw event reads and
subsequent SDK SSE replay retained those outputs and the question. That stream
receipt is retrospective, not delivery while waiting for the answer. An invalid
bearer was refused by the group metadata read; it was not a negative SSE test.

Source provenance was checkout-derived. The direct source boot omitted a
supervisor boot ID, so its identity endpoint stayed unavailable; this is not
packaged identity evidence. An initial retrospective stream probe used the
wrong cursor option and completion marker; its failed receipt is retained, and
the corrected read made no provider calls. The owned runtime and listeners
were stopped afterward. This advances live answered-form evidence on that
source, without establishing billing, fiscal/physical caps, portable authority,
native/physical/hosted/release or whole-epic acceptance.

At `27fafa8d48b6`, one fresh mixed group subscribed to authenticated SDK SSE
before creation. The exact controlled question arrived on that live stream
before the operator answer; its dependent was still pending. Foreign and
duplicate replies returned 409, the exact reply returned 200 with the engine
acknowledgement, and an invalid credential on the SSE endpoint returned 401.
The stream carried `ELICIT_OK`, `CONTROL_OK` and `JOIN_OK`, each with one initial
start and completion, and the Flow join completed after both predecessors.

The initial probe incorrectly compared ACP streamed text with the optional
terminal `outputText`, which those ACP events omit. Its failed receipt remains;
read-only qualification compares the saved frames with the authored challenges.
A second read-only assertion initially looked for acknowledgement under payload
instead of its canonical top-level field; that failed derived receipt also
remains. No provider rerun occurred. Failure cleanup canceled the already
completed group; that later mutation is disclosed rather than hidden.

Independent artifact review verified source/frame/archive hashes and temporal
gates without making provider calls. The owned source server exited and its
PID and four listeners were absent. Startup corrections and the pre-provider
SDK import failure remain recorded. This is checkout-derived source evidence,
not packaged identity, billing, portable authority or physical-device acceptance.

At `1c682a5a2dd`, a read-only retained-session check observed the earlier mixed
CLI group's completed tasks and closed, idle, resumable conversations. The real
390px browser showed directory context and Operator/CLI provenance across
reload, with no Active now lane or document overflow. Startup carried a
pass-through process-probe diagnostic; the prior uninstrumented start refused
its own process identity and remains unexplained. Both screenshot attempts
timed out. This is not a fresh running-to-ready journey, packaged desktop or
second-device acceptance, and made no provider calls.

This establishes only the exercised CLI paths. Second-device lifecycle, the remaining lineage/context/recovery obligations, final combined
review and full epic acceptance remain outstanding.

Reuse the authenticated delegation route for caller resolution, permission
posture, execution-target placement, attachments, receiver admission, session
creation and initial-turn delivery. Persist group membership against the actual
returned task/session/turn identities. Observe, reply, interrupt and continue
through the existing authenticated session paths.

Use published Flow scheduling for readiness and claims, with Station dispatch
count and occupied-seat concurrency bounds. Unknown or ambiguous starts retain
their seat and must not be automatically resent. A deadline stops new dispatch
and requests interruption; it does not prove that a provider physically stopped.
A session/turn is not one physical model invocation. The separate hard-cap API
path must still admit every physical request, including retries, and must not
accept fabricated envelopes or fiscal allocations for CLI sessions.

A local production preparation caller now consumes fresh login observations bound to executable,
connection/profile environment, receiver-owned Agent profile pin, workspace, principal and model.
Its inventory does not discover models or invent ready status. Request authority and context are
rechecked around the probe. At `49c27af63cad55b55e28c26e176b797a77645769`, the implementer
reports 306 focused passes, focused typechecking and two compiling mutation catches with exact
restoration. Independent review then reproduced five P2 gaps. Repair `071b49b8` closes
those original probes with reported 378 focused passes and a compiling final-guard mutation catch.
A fresh independent review still found two late windows: the final guard can retain an earlier
receiver snapshot across Project lookup, and private active-profile/overlay changes can precede
spawn under the old context. Repair `9df426d7` adds ConfigLoader source-file witnesses, Project revision checks,
provider launchability and the existing stable runtime Agent revision. The CLI runner consumes
a synchronous finalizer after its asynchronous setup, checking request authority last before
spawn. The implementer reports 496 focused passes across 14 files, focused types, and four
failures from a compiling mutation that skipped this finalizer, followed by byte-identical
restoration. Fresh independent review passed the bounded managed-owner scope and 121 focused
tests, rechecking all seven prior findings. Its filesystem probes also showed that transient
creation/deletion of absent files and late direct cwd/preset changes can escape pre-spawn
checks before postflight refusal. The pass does not establish atomic filesystem-to-execution
custody, universal drift refusal or hostile same-UID isolation. Booted composition and live
credentials/providers remain unverified; no final-preparation or launch acceptance follows from these counts. The caller stops at the first unsupported guarantee
and returns a refusal, not a complete prepared snapshot. API engines and option/reasoning catalog
discovery are unsupported. Real credential/model entitlement, launch-time context consumption and
subsequent effect enforcement still need implementation and evidence.

Published Relay 0.7.1 Codex and Claude Code runtimes declare output-token limiting unavailable;
the upstream execution bridge requires a native limit and refuses these bindings. Do not relabel
the capability or substitute byte/time limits. Station's API-model factory offers a physical-call
integration seam, but input bounds, final wire output/thinking limits, worst-case cost, complete
actual usage and cancellation reconciliation still require executable enforcement. An unsupported
member must refuse before launch; that refusal does not complete group or Ensemble acceptance.

Complete serving composition of the published durable controller with Station-owned
membership/event joins and full API/SDK/CLI callers. Bind Ensemble identities and roster-aware
briefs to the resulting sessions. Derive the read-only topology and accessible list from the same
prepared/live records, including authored/default/runtime provenance and missing dependencies.
Context sync must use the actual delegate session with enforced no-tools authority, accounted
attempts and retained per-member ACK receipts. Existing continuation plus a prompt is insufficient.

## Read-only inspector increment

Source `21de0f40` adds an Agents inspector at `/agents?tab=ensembles`, a separate
non-probing local-operator inspection route, SDK transport and category table/diagram.
The implementer reports 384 focused passes, scoped types/lint and a compiling UI
branch mutation caught before byte-identical restoration. Independent review passed
37 selected tests and additional route/hook/parser probes, but found a broken Project
owner link (P2) and malformed JSON classified as unavailable (P3). Repair `71d6449c`
passed fresh independent review with 16 tests, before/fixed route controls and retention/layout
mutations. An isolated browser fixture exercised the real inspector/SDK hook against mocked
API responses in light/dark themes and desktop/narrow viewports. It exposed compressed narrow
table columns; `4beaa914` preserves readable columns in a named keyboard-scrollable region,
with five focused tests and a bounded independent review pass. Browser evidence establishes
component rendering and interaction only: no complete Station backend, native phone/shell,
provider credentials or live group execution was exercised. Configuration relations do not establish live group
edges, shared memory, scheduler/webhook membership, provider entitlement or bounded
execution; unavailable facts remain visible. This does not complete #453.

## New-rounds custody integration

The persistence owner now has separate stores for published Flow rounds and v3
authority. Shared authority/group locks serialize custody against legacy stores;
protocol collisions and duplicate current execution/authority ownership refuse.
New stores cannot import v2 state. Existing v2 journals and charges remain in
place. Published validators and capacity functions run before durable commit;
Station retains current-authority commit checks and immutable history.

Controlled persistence tests use the real published rounds controller and v3
authority service. They cancel/reopen an unknown-held reservation without
changing the legacy ledger, refuse cross-protocol ownership, and retain
append-only history. No provider invocation or boot-serving acceptance follows
from this storage integration. Production preparation, qualified issuance and
session-bound context ACK are still required.

The next increment connects member invocation to a rounds-aware final-fetch
fence. It reads the actual latest attempt and adopted grant under the rounds
lock, checks a current-epoch reservation under v3 authority custody, and shares
the existing durable wire consume plus final synchronous source checks. The
reserved SDK transport selects it explicitly; it does not reinterpret a legacy
journal. Context-sync launch admission and authenticated recipient continuity
remain open. Controlled provider fixtures are not live provider qualification.

The private SDK owner now consumes an opaque credential lease from the real
credential-observation store rather than a caller API key. Current local-grant,
provider-file, configuration/runtime witnesses and the observed contract
credential revisions are rechecked; the wire key is checked before source
consumption and again after its callbacks return, immediately before raw fetch.
A post-consumption refusal keeps unknown accounting held and forbids resending
the consumed source. This supplies a credential-source handoff, not provider
entitlement, tariff approval or a production serving issuer. Raw keys are not
returned in observation DTOs or lease serialization. The runtime credential
owner now issues the nominal SDK lease under the actual Agent configuration
read queue and retains the configuration/runtime fences for later SDK reads.
The installed-SDK source preparation controls consume this runtime-owned
handoff. Participating-Agent capture resolves the actual projected Agent and
its managed connection/model through Station's existing selector, rather than
accepting caller-produced binding facts. External-engine and ambiguous bindings
refuse; configured instructions and original fences survive the handoff. The
Anthropic control consumes this selected model and instructions. Controlled
responses remain the transport evidence; boot serving and provider acceptance
are not established.

The narrow Anthropic preparation issuer now derives its contract from the actual
source/credential leases and captured final SDK wire. It selects the documented
`2026-10-21` version explicitly and refuses extra thinking/cache/tool/premium
fields. Caller-produced principal/source/tariff bindings are not accepted. The
reviewed profile reserves a conservative 1,048,576-token input upper bound and
uses the listed 3/15 inference-micro tariffs, excluding invoice/tax guarantees.
Its fixed evidence expiry and installed-SDK hashes fail closed; startup does not
refresh them. Google remains unqualified by this profile. Boot request serving,
model access and same-session ACK acceptance remain separate obligations.

## Report-group operator reads

The Ensemble inspector now exposes retained report groups through scoped SDK
query hooks. It reads metadata only when expanded and raw output only when the
operator opens a member report. The reader assembles bounded UTF-16 pages before
rendering, rejects inconsistent model/usage metadata and renders output as text.
Closing the view cancels pending reads; authority loss hides the old projection
and refuses late output. Labels preserve unresolved reservations, unconfirmed
termination and unassessed acceptance. The inspector also offers an explicit
cancellation request through the scoped SDK mutation. It sends the displayed
revision once, disables repeat attempts in that mounted view, refuses stale
authority, and keeps request status separate from physical termination and
accounting. This surface adds no paid dispatch, Flow topology or provider
qualification. The pending-cancellation inspector also offers explicit receipt recovery using
the original cancellation key and a distinct recovery key. It never resends
interrupts and keeps pending receipts separate from termination and accounting.
The inspector now also submits paid independent report groups through the scoped
SDK create mutation. It requires explicit source selectors, Agent IDs, member
briefs and budgets, retains one operation ID, disables repeat dispatch, protects
unsent drafts, and aborts waiting on unmount/authority change. Controlled
mounted tests exercise the SDK path; rendered browser and live-provider
qualification remain open. Flow topology and continuation work are still open.

## Authenticated report-group preparation

The sealed source owner now separates the published Flow runtime root from
tracked task source. Real generated run state can change without entering the
provider payload or changing the source identity. The root is identity-witnessed;
tracked files in it, links and unrelated ignored/untracked entries still refuse.
A real Flow start/pause plus prepared SDK wire test binds this distinction. This
removes a source-admission prerequisite for Flow topology; it does not yet bind
a report group to a Flow run, claim, frontier or join.

### Remaining Flow-bound execution admission

Current source at `238db867559` still issues only independent advisory report
specifications. The rounds launch fence checks a retained `flowActions` claim,
but that journal entry alone cannot authorize a later physical request. Keep
Flow topology unavailable until the following composition is implemented and
qualified together:

1. Resolve the Flow workspace through the authenticated Project/resource source
   owner. Bind its real repository and sealed source identity to a boot-local
   capability; never accept a caller-supplied cwd, root authority or grant.
   Require the actual Project Flow mutation scope as well as report admission.
2. Derive the run definition, actor and per-seat step binding from current Flow
   state. Release only Flow's public ready frontier; Flow remains responsible
   for joins, gates, route-back and settlement. A returned report is not gate
   evidence or semantic acceptance.
3. Preserve group → authority → Flow lock order. After durable wire-intent
   consumption, take the published `withRunMutationLock`, load the actual run,
   require eligible lifecycle and find the claim in `multi_cursor.active_claims`.
   Compare claim/liveness/run/step/actor/definition/base identities, then validate
   the current stored claim and lease with `validateDurableStepClaim` and the
   current time. That validator alone does not establish active membership.
   Legitimate renewal timestamps may change without rebinding the claim.
4. Recheck request/source authority synchronously immediately before invoking
   fetch while the Flow lock is held. Return a wrapped response promise so no
   provider-response wait holds the Flow, authority or group locks. A refusal
   after intent consumption retains the occupied reservation and never resends.
5. Qualify the actual serving composition with a real published Flow run:
   removed/expired/rebound claims and paused/canceled runs must produce zero
   physical fetches; a valid renewed claim must launch once. Exercise frontier
   fan-out and join through Flow, then qualify explicit continuation and exact
   same-session no-tools ACKs. Controlled transport evidence remains distinct
   from the required live runtime/model-family and elicitation acceptance.

The private source owner and rounds final-fetch fence now implement the
source/Project-scope and final active-claim lock boundary described above.
Controlled source-owner tests cover renewal, removed/rebound claims, paused and
canceled runs, and releasing the lock before a pending response resolves. A real
published Flow scheduler/controller test pauses the run after durable wire intent
consumption: transport does not start, the invocation remains reserved and its
usage stays unknown. These are local controlled prerequisites. Report serving
preparation still creates only independent advisory groups; frontier/join,
continuation, public projection and live acceptance remain unfinished.

The public Flow workspace route is mounted at
`/api/projects/:slug/flow`; its evaluation operation is
`POST /runs/:runId/evaluate`. The current source admission's chat-operation
scope does not by itself establish authority for that operation. These are
remaining implementation requirements, not a newly issued capability or an
acceptance receipt.

Published Flow Agents 9.5.0 is now adopted through the managed lock/install path
in Station, contracts and SDK. Release PR #1546 merged; npm's published integrity
matches the lockfile. The existing HTTP/SDK/CLI consumers pass on that artifact.
Station now consumes its explicit `finalizeCancel` contract through private
custody, HTTP, SDK and CLI. Confirmation reads independent signed interrupt
receipts while Flow holds the group lock; it does not re-enter that lock or
resend native effects. Controlled proof covers lost acknowledgement (still
pending), acknowledged request with a lost journal commit (finalized), a validly
signed wrong-operation receipt (refused), foreign credentials/keys and exact
replay. The public owner drives SDK finalization and registered CLI replay.
Accounting and reservations remain unchanged; requested cancellation is not a
physical-stop, refund or acceptance claim.

The 9.5.1 prerequisite is now published and adopted in Station, contracts and
SDK through the managed dependency workflow. Release PR #1548 merged, and the
registry tarball matches the lock integrity. Installed public contract source,
built JavaScript and declarations match that tarball. The contract permits
omitting legacy `gate_attempt` metadata; Station must not fabricate a gate
counter before Flow has claimed work. This removes a contract prerequisite.
It does not wire Flow topology, continuation or provider acceptance by itself.

Registered `group report-*` CLI commands now consume the strict SDK for
create/get/list/events/follow/results/cancel. Input file and flag bounds apply
before request dispatch; terminal output is escaped. SIGINT closes observation
or aborts one request without implicit cancellation or paid retry. Existing
session commands share the bounded JSON-file reader. Controlled CLI tests cover
registration, credentials, parsing and process-listener cleanup; they do not
establish live-provider acceptance or the remaining UI/Flow/context work.

The public report-group types and SDK client now cover create/get/list/cancel,
journal GET/SSE and raw-result pages. The primary HTTP owner exercises SDK
replay/reads on the actual serving and retained accounting path; SDK controls
reject malformed/foreign/gapped responses and excessive create bytes. There
are no automatic paid retries. CLI/UI adoption and broader qualification remain
open.

Report journal GET/SSE pages now project only revision/kind/member/invocation
metadata. Report-specific resume cursors cannot cross into other group domains;
streams bound their lifetime and recheck the captured response lease before
writes. Raw result pages separately recheck canonical member delivery/read
admission and the retained observation digest. Controlled HTTP proof reconstructs
multi-page text exactly, rejects a substituted observation, and refuses an
unreadable member. It remains fixture evidence, not live-provider acceptance.

Personal-host boot now mounts an allowlisted report-group create/get/list/cancel
surface with one private custody root. The primary execution proof runs through
HTTP and runtime construction, including fresh runtime replay after profile
expiry, response privacy and current credential rotation. Ingress stamps and
provider responses are controlled; no live acceptance is inferred. Provider
qualification is lazy and cannot block historical reads. Client adoption, Flow topology and same-session continuation remain open.

Private custody now composes a fresh operator cancellation with the published
rounds journal and V3 authority. It retains exact member interrupt receipts for
nonterminal attempts and keeps missing acknowledgements pending. Exact command
replay performs no effects. Completed attempts retain their terminal receipts,
usage and reservations; cancellation does not mean acceptance, a refund or a
new physical-stop claim. Explicit pending-cancellation recovery has a published 9.5.0 contract; its
Station confirmation composition is now wired and covered by controlled tests.

The execution runner composes the actual preparation, signed custody,
canonical task dispatch, sealed SDK transport and published AccountingV1 rounds.
It derives usage from retained raw provider evidence and records bounded private
observations; terminal proof joins the exact canonical session/turn event to that
evidence. Historical operation lookup precedes preparation, so exact replay can
observe an expired-profile group without another source seal or physical attempt.
The controlled two-seat fixture exercises this owner directly; it is not live
provider evidence. The mode remains independent advisory, not acceptance, and
Flow frontier/join and session-context ACK remain open.


The private report-group preparer now derives one controller and its child
report envelopes from an authenticated local operator intent, actual configured
Agents, exact qualified SDK quotes and separately sealed copies of one source
state. No caller root/grant or fabricated runtime/model reference supplies its
authority: references describe the observed preparation, and the issuing
boot-local capability authenticates them. Aggregate child allocations must fit
the declared budget. Task and client-turn identities remain reserved intent
until the actual session/turn owners accept them.

The controlled test consumes that issued root in the published v3 authority and
rounds launch path, then reaches the real Station adapter/service/SQLite and
retained tariff accounting. Its synthetic response is not live provider proof.
Same-request replay joins; cross-request/restart preparation replay cannot
reconstruct a launch capability. The issued member now passes a read-only,
durable rounds-reservation preflight before the canonical delegated-task owner
creates its exact reserved task/client turn. Its current-Station handshake must
match the source host captured by the reserved port. The control-plane task is
not evidence of paid request admission; the physical fence repeats its joins
and consumes the wire once. Ordinary canonical task status reads the resulting
binding, and a second handoff refuses without resending or releasing unknown
accounting.

Private historical custody retains host-signed admission facts before canonical
task dispatch. Fresh authorized local-operator GET requests can inspect retained
admission and actual rounds/v3 state after the original preparation closes or
its provider profile expires; this read does not renew provider authority.
Operation identity uses host, canonical principal and operation ID rather than
the returning credential. Retention checks existing execution state before
accepting admission metadata, so a conflicting reseal cannot replace the original
root after metadata loss. Missing metadata does not reconstruct a launch capability.
A fresh private delivery read joins actual attempts/invocations and uses the
canonical task/client-turn delivery lookup to recover the accepted session/turn;
it refuses a different session and does not infer started work from reservations.
It supplies identity for later cancellation composition, not proof of stop or
provider termination. Fresh operation-scoped POST authority can revoke the exact
retained root through the published v3 service after preparation expiry. The
private revocation path preserves known and unknown invocation accounting and
does not claim group cancellation, interrupt delivery or physical stop.
The private per-seat request now requires revoked authority and an accepted
session/turn from canonical delivery lookup. It persists a host-signed interrupt
intent before the exact canonical command and a bounded acknowledgement after it.
Native settlement runs outside the file lock. Reads/replay remain available with
an unknown intent while it is in flight, and acknowledgement re-reads the latest
ledger and compares the exact original intent before updating that seat.
A lost response leaves the intent unknown and reconnect cannot resend it; only
a retained acknowledgement receives a request reference. Historical receipt reads
verify the original admission and signed member identity independently of live
delivery-key retention or engine availability. Canonical interruption
also fences request currency after adapter resolution and at native/deferred
handoff, without forced teardown after pre-dispatch authority loss. Public
serving and Flow journal acknowledgement are still required, and an interrupt
receipt neither settles usage nor proves provider termination.

Public serving lookup, complete fresh-request cancellation, Flow-backed frontier/join and
session ACK remain required before enabling the paid-group capability. The control-plane read responses and provider response in this
qualification are controlled; live ingress/provider acceptance remains open.

## Controlled reserved Station turn integration

The internal reserved-turn port now reaches the real Station adapter through
session start, turn dispatch and canonical event persistence. It consumes the
sealed SDK attempt once, bypasses the ordinary chat endpoint, retains evidence
before publishing usage/completion, and refuses unreserved continuation or
identity changes. The later text-streaming increment emits provisional canonical
text deltas while preserving raw terminal/accounting evidence as the completion
boundary. Buffered activations retain their delivery mode; returning streamed
activations retain theirs without replacing the original resume identity.
That no-tools checkpoint admitted no tools or approvals. The later explicit
input profile is a separate, narrower request class; metadata alone grants
neither mode.
Cancellation requests abort without asserting provider termination; unknown
usage retains its reservation. Ordinary sessions keep their existing logical
stop deadline and teardown.

Result disclosure also rechecks the exact retained provider evidence under the
private persistence lock. Missing or changed canonical evidence refuses; restoration permits
reading the original result without a second invocation or charge rewrite.

This is controlled integration under synthetic provider fixtures. Boot
preparation, production provider qualification issuance, real Flow AccountingV1
serving settlement, authenticated ACK and separate rounds custody remain open.
It does not qualify live provider execution or complete #91.

## Remaining qualification

At the historical checkpoints below, local group transport included the Station contract, SDK HTTP/SSE
clients and registered CLI commands; that unfinished portable unit is now retained at the source split pin above. Independent reviews closed the original
nine transport findings, retained event-identity reuse, and the additional
UTF-8 identity-history byte bound. The provider quote/raw-usage validator has
independently reviewed per-attempt thinking and supplied-count checks, but no
production qualification registry or paid issuer. Binding and shared-publisher
mutations consume mandatory synchronous authority finalizers; the invalid-async
finalizer rejection repair passed independent subprocess and filesystem checks.

At `fedcf0ee664e47508dd7b27b53742dce0e64c539`, the runtime composes public Flow
controllers with Station persistence. Independent review found replacement
preparation in retention callbacks and observation publication without a final
commit fence. Repair `5b65281e0ef` retains the composition's capture and checks
at observation publication and after release. The completed independent R3 review
reproduced both failures on the original source, checked all five retention
callbacks and real staged-file/release boundaries, caught two distinct mutations,
and passed its restored 21-record probe run. The earlier interrupted R2 review
remains incomplete and contributes no completed evidence. The reviewed runtime
blob remains unchanged through `3004ad1efbe`. Those API-group routes remain
unmounted; the CLI session-group routes described above are a separate path.

Managed validation at `c5f062c606c` passes server-test typechecking. The seven-file
persistence/runtime/observation selection has 76 passing cases across its first
five passing files and a two-file rerun after fixture corrections. The separate
physical/provider/Ensemble-preparation selection passes 109 cases. These are
focused fixture results, not full readiness or live execution acceptance. Current host preparation, physical reservations and
launch fencing, raw response settlement, context ACKs and supported execution
still require integration and acceptance evidence. Isolated drafts and safe
refusals do not establish supported group execution.

Additional local increments at `100d4571b25` and `03cf52c427e` add the
single-use final-fetch fence/wire-intent owner and the boot-scoped credential
source observation owner. Their primary managed selections passed 18 and 29
cases respectively; these are separate runs. At `3004ad1efbe`, the observation
suite passes 18 cases including a partial StationRuntime fixture using the real
read queues, EventStore and ProviderService. Bypassing those queues failed the
intended zero-publication assertion; byte-identical restoration passed. This
fixture selects its stable revision and is not a booted route test. The scoped
server-test type lane passes. Credential-source currency remains distinct from
model entitlement, provider qualification and paid execution authority.

The actual #3991 main merge `1dd83e0f3051` is integrated normally at
`98d885a7ad5`. Nineteen conflicts were reconciled without dropping the epic's
retention/provenance additions or 9.3.0 pins. Dependency checks and real PTY
verification pass. Separate focused runs pass 245 contract/security/UI cases and
225 server session/provenance/group-runtime cases; UI and server-test type lanes
pass. These are local checks of selected merged paths, not full epic, serving,
provider, native or hosted acceptance. Documentation freshness remains failing.

The independently reviewed sealed-source SDK owners are now adopted in
`delegation-group-source-admission.ts` and
`delegation-group-sdk-source-wire-owner.ts`. The focused Station selection passes
38 source/SDK cases with mock HTTP and real authorization owners. Snapshot
content remains private and memory-only; live-checkout launch still refuses.
At that adoption checkpoint, boot issuance and managed transport composition
remained unwired, and the group capability was disabled. These checks establish neither live consent nor
provider qualification or billing.

The raw JSON/SSE observers, repaired Google terminal-counter assembler and
reserved provider fetch are adopted. The reserved sealed-SDK attempt joins them
to durable intent and source authorization. A focused selection passes 41
SDK/Google cases; 33 observer cases passed separately before the added Google
regressions. Server-test types pass. At `ce37e9fc59e`, the reserved SDK attempt awaits
private evidence publication and its synchronous finalizer before returning
published AccountingV1 counters and integer tariff-derived micros. Raw response
JSON is retained alongside the usage evidence; for SSE this is reconstructed
JSON, not the original wire bytes. No provider-reported dollars are fabricated.

The controlled owner suite passes 32 cases. Both provider fixtures settle
4 input tokens, 2 output tokens and 7 tariff-derived micros into the real Flow
authority ledger. An actual filesystem publication refusal leaves usage unknown,
the allocation held and the attempt non-terminal. The fixture explicitly fsyncs
the evidence directory on POSIX; it does not qualify Windows durability.
Server-test types and changed-file style checks pass. A compiling mutation that
skips awaited publication and finalization fails the publication-refusal case
with 31 controls passing; byte-exact restoration passes all 32 cases.
Independent source review found no unsafe settlement path before that mutation.
At that stage, private issuance, production retention and settlement callers
remained unwired; those controlled checks establish no serving, provider or
billing acceptance.

At `36c4c5cd9a3`, the reserved SDK attempt calls Station's persistence owner
for raw provider evidence instead of a host-supplied publication callback.
The retained record includes the exact consumed wire intent. Its root and
invocation select one private record: exact replay preserves the reference,
while changed evidence refuses before overwrite. The owner uses its existing
mutation lock, bounded descriptor readback, request finalizers and explicit
POSIX directory fsync. Limits are 20 MiB per record and 1,024 records, not a
20 MiB aggregate store. This is trusted host persistence, not authentication of
arbitrary provider evidence. The controlled caller obtains evidence from the
reserved transport's raw-usage observer. Boot issuance, provider qualification,
serving preparation and the real AccountingV1 settlement caller remain unwired.
The focused SDK/persistence selection passes 38 cases. A compiling mutation
that addresses evidence by response content permits conflicting records for
one invocation: both provider cases fail their refusal assertions, with 36
controls passing. Byte-exact restoration passes all 38. Independent source
review finds no introduced unsafe-accounting path; it performs no execution.

The private provider qualification binding no longer requires an invoice-account
label. Its principal, Station tenant, credential, connection, source, model,
API/SDK and option identities still match exactly. Accounting is explicitly
provider inference before tax with a retained tariff basis; neither a login nor
an organization/catalog observation proves model entitlement or invoice terms.
A failed entitlement request may consume a bounded attempt and retain its full
unknown reservation. Applicable provider limits, complete tariffs and error
charging semantics remain required before qualification. This removes an
unsupported prerequisite; it does not issue a contract or activate serving.

Flow rounds/continuation and v3 authority renewal are adopted in the Flow Agents
worktree at `57f02040`; `36de11b1` joins their independent, paid Flow and
session-bound context-sync paths to AccountingV1. The combined source builds,
passes documentation checks and 20 focused cases. A compiling recipient-return
mutation loses sync accounting as intended; exact restoration passes the three
accounting cases. The independent combined-source review subsequently completed with no P1/P2:
34 review-owned checks cover storage-only finalization, session drift,
renewal/adoption and retained-tariff accounting, with a compiling mutation and
byte-exact restoration. Physical-launch drift was source-reviewed; real host
custody, provider/billing, publication and Station integration were not verified.
The Station response composition review passed within its stated fixture scope.
The earlier rounds review failed without a completed verdict. At `17827e72`,
the upstream CI registration repair preserves the reviewed production/docs/package
bytes. The final documentation follow-up at `c4ec9698f58d` passed hosted CI;
upstream PR #1543 merged as `cc7690a77e40eb8071ef34876650caa3dddb6f0e`.
Release Please generated PR #1544 for 9.4.0; its publication and managed adoption
are qualified above. Installation does not establish a serving path.
Existing v2 group journals have no public
rounds import API; retain their controller and charges. New rounds need separate
authorized custody, and any v3 authority import must transfer the actual locked
snapshot while revoking the old writer.
Tariff-derived integer micros must retain
their cost basis and must not be silently converted to provider-reported Relay
dollars. A candidate public API or a successful synthetic SDK response is not a
published serving contract.

- Finish independent delta review and meaningful injected/restored checks.
- Reconcile canonical documentation and generated review evidence.
- Verify desktop/phone, both themes, focus, hit geometry, and actual animation.
- Exercise CLI task completion, conversation readiness, reload and a second
  device with explicit client/server revisions.
- Qualify native/provider result recovery and ordering without borrowing prior
  source receipts.
- Resolve supported group contracts and installed-runtime group fixtures.
- Merge master/main, qualify the exact combined SHA, then publish one PR with
  honest remaining acceptance limits. No local/focused receipt implies hosted
  integration, merge, deployment, or live-provider success.

## Current desktop connection and physical second-device evidence

At `e6be8cc1ae4`, the canonical lifecycle runtime reports identity 200 with that
source SHA. A desktop browser opens the retained controlled CLI output and
reloads it with the directory label; the header no longer remains Reconnecting.
The root React Strict Mode regression fails for healthy and authentication-failed
probes on the prior source (2 red, 22 controls); the queued-probe repair passes
41 tests. Removing the aborted-result drain reproduces both failures; byte-exact
restoration passes 41 tests. Connect typechecking and Biome pass.

The isolated Android proof app built from `4cd2f9ba7e4` (APK SHA-256
`6544b62aba7b44c9c7f35e53eff8c833a743cd5a5bf4797373cd830835b2f0fc`)
paired through the normal native link and operator-approved API with that
runtime on physical B10. It opens `CLI_CONTEXT_OK`, shows a projectless directory
label and Done, and retains the connection/output through WebView reload.
Activity exposes the exact task ID and `from CLI`; Home details omit origin.
This uses adb loopback forwarding, not tailnet transport qualification, and
reopens the earlier controlled task without a new provider invocation. YouTube
was restored; the owned proof app and forwards were removed. It does not close
whole-epic or new-provider-run acceptance.

The follow-up `e7c029fb479` preserves the hook registry entry through synchronous
Strict Mode unsubscribe/resubscribe by deferring final deletion to a microtask
and rechecking both references and entry identity. The later-consumer test
fails before the repair and when immediate deletion is restored (1 red,
24 controls); exact restoration passes 42 tests. Independent source review
finds no introduced findings. Abandoned concurrent-render options and same-key
consumers with different stores remain outside that scoped lifecycle repair.

## Reported-origin presentation qualification

At `e88d5e8db21`, the shared origin labels distinguish server-derived actor
kind from client-reported surface in Activity rows/filters and Session details.
Missing provenance, unknown surfaces, imported-engine attribution and Agent
message labels retain their separate behavior. Origin filter keys are local
component state, so this wording change needs no persisted-filter migration.
The mounted Session-detail regression fails on the earlier source (1 red,
23 controls); the repaired three-file selection passes 48 tests. Removing the
shared suffix causes three intended failures with 44 controls; byte-exact
restoration passes 48. UI typechecking, Biome and independent source review pass.

Canonical lifecycle identity and the controlled browser journey bind to the
same source. Chromium verifies the reported row, Session metadata and receipt
labels, plus retained row/output after reload and explicit reselection. Activity
row selection itself is component state and is not automatically restored by
reload. This journey sends no new model request. A 390px browser viewport is
not a second physical-device receipt for this later wording change; the earlier
B10 evidence remains pinned to its own APK and server revisions.

At `57ce3a235be`, Activity calls its filter “Recorded origin” rather than
“Started from”: the contract supplies each Session's most recent attributed
turn, and conversation filtering considers those Session values. It does not
claim complete per-turn origin history or replace the delegation header's
first-turn initiation record. The existing mounted label/selection cases fail
on the former label (2 red, 21 controls) and the two-file selection passes 24
tests after correction. Biome and independent source review pass. This small
copy-only follow-up has no new browser or physical-device receipt.

At `58ade549521`, the Agents child row also changes “Started from the CLI” to
“Recorded origin: CLI (reported)”: its selector reads the latest reported
Session surface, not an initiation receipt. Parent conversation/task precedence
is unchanged. The mounted regression fails on the former copy with 14 controls
passing; the pane/row selection passes 39 tests after repair. Independent source
review finds no issue. E2E types, fixture policy and lint pass after the longer
browser assertion receives its required line wrap at `5af8c9cce17`.

The canonical product browser runner then passes both desktop and 390px cases
and stops its temporary Station. Orchestration SSE/read models are mocked;
this is not provider, native recovery, physical-device or accounting evidence.
The initial run refused before tests because the repo-local browser directory
was empty. The corrected run selects the existing cache matching installed
Playwright Chromium revision 1248; no browser installation was needed.

## Current installed-native child result controls

At `b712fbce09f`, a controlled loopback model drives the installed Claude Code
2.1.308 engine and SDK 0.3.302 through the real Station adapter, service and
EventStore. The foreground Agent child returns exact controlled text; persisted
child events bind its parent tool call/turn and retain `source: tool-return`.
The parent receives that tool result. Thirteen run checks and three fresh-process
recovery checks pass, including owner transcript reading, foreign-reader denial
and retained provenance without registered adapters. The retained-evidence audit
corroborates those joins and the positive probe's recorded source hashes; it
performed no independent execution.

A separate background control emits partial bytes and stops the exact child.
Its first stronger recovery check lacked a completed parent terminal after
the harness immediately shut down; that 8/9 result remains failed. A new run
waits for canonical completion of the exact parent turn before teardown: six
runtime checks and nine fresh-process recovery checks pass. The child remains
`cancelled` with a provider summary, never a returned result. Recovery retains
the child prompt and denies the foreign reader; partial narration was not
persisted. The mounted ChildWorkRow suite separately passes 24 cases.

These are controlled installed-native and saved-data results, not real-provider
billing, full Station HTTP/browser, native reattachment, crash recovery or all
background/error-ordering acceptance. Negative-run source hashes and SQLite
backup checksums were captured after execution/recovery; they are not pre-run
custody receipts. Cleanup checks cover service/store settlement, the owned
listener and adapter session count, not arbitrary native descendants. Network
and shared-write zero counters in the old harness are declarations rather than
independently monitored measurements. No previous mutation is relabeled as a
current-head execution.

At `3c12cca5793`, the current retention/store, mounted-hook and activity-sheet
selection passes 79 cases. Reversing only closed-row recency fails the newest-row
retention assertion with five controls passing; exact restoration passes all 79.
Independent source/log review confirms distinct closure clocks and the separate
render-count test for unrelated-chat isolation. At `ffd2b1573de`, the same closure
storm additionally requires 50 retained omission flags before snapshot clearing.
Discarding all closed-chat flags fails that assertion with five controls passing;
exact restoration passes all 79. Independent delta review accepts the stronger
assertion. These are local store/jsdom and mutation results, not screen-reader,
physical-device, hosted or full-epic acceptance.

At `6b173a7e95f`, a separate foreground native control returns a synthetic HTTP
400 from the loopback Messages endpoint for the child. Four physical requests
are observed: parent start, two child requests, then the parent after the error.
Station retains one failed child with `provider-error`; the parent's tool result
has `is_error: true` and the exact spawning tool-call ID. No authored answer or
`tool-return` is fabricated. Twelve retained-evidence checks and three
fresh-process, zero-adapter recovery checks pass, including the refusal transcript,
failed/error provenance and foreign-reader denial. This does not establish a
single physical attempt, external-provider behavior or billing. The harness
records source hashes before adapter execution; follow-up comparison matches the
pinned commit. SDK version is recorded, but installed SDK bytes are not
independently hashed. Service shutdown, listener closure and zero remaining
adapter sessions are recorded; network/write counters retain the declaration
limit above.

### Flow-bound report serving increment

Report create now accepts an optional run and exact seat-to-step map. Private
sealed-source admission resolves the authenticated workspace, definition and
actor before SDK preparation, checks selected read-only steps and retains a
per-member final-claim owner. The execution runner supplies published Flow
callbacks, durable schedule/member/evaluation observations and fresh ready
subsets across bounded initial rounds. No caller cwd or gate counter is accepted.
Report views retain the selected topology; raw reports remain distinct from
Flow gate evidence and acceptance. The full group capability remains disabled.
Same-session Flow continuation, renewal, evaluation-only retry and final live
qualification remain open. Focused serving validation is in progress; this
source increment is not a provider, hosted or whole-epic acceptance receipt.


## Initial report continuation policy

The report input now accepts explicit finite initial continuation limits only
with a Flow selector. The producer records them in immutable intent and the
published rounds policy, reserves per-member aggregate token/micro headroom,
and keeps the per-call allocation unchanged. Legacy input still issues one
attempt per member with no context-sync or renewal allowance. SDK parsing and
CLI file input share the contract bounds; replay cannot enlarge the policy.

This is policy preparation, not operational continuation. Fresh sealed-source
re-admission, same-record prepared-turn attachment, exact context ACK, renewal,
recovery commands and combined live acceptance remain open. A source-only design
review found authenticated re-admission under an unchanged epoch defensible if
it verifies the original signed sealed receipt, current request/grants, exact
observation and fresh bytes, preserves expiry, and creates new one-use custody.
The observation-only `reobserve` method must not be relabeled a launch fence.


### Context-sync final-fetch admission (private composition)

The rounds final-fetch fence distinguishes context-sync invocations from ordinary
report attempts. A sync requires exactly one pending durable sync command for the
seat, no prepared/finalized receipt, returned ordinary rounds, and terminal or
definitely unadmitted prior work. Its reservation must match the controller's
command-derived sync namespace and the current authority epoch and envelope;
a second sync attempt requires known terminal usage for its first attempt.
Explicit no-tools execution authority remains mandatory.

After durable wire-intent consumption, the source owner takes the Flow mutation
lock and rechecks the run definition, eligible lifecycle and exact command head
before invoking transport. It does not fabricate an ordinary step claim. The
wrapped provider response remains outside the lock. Controlled tests drive the
published controller and real Flow state with a fake transport, including a
head change between wire intent and fetch. This private boundary does not expose
continuation commands or establish a returning-request SDK/retained-Session
journey, provider acceptance, or compatible installed Flow runtime identity.

Private original-input custody is also capacity-limited: publication before
signed admission can leave orphan records, and those records consume the
128-record lifetime allowance. No cleanup or rollback is claimed.


### Returning-request continuation candidate

The in-progress consumer now composes private intent loading, fresh source
re-admission, a fresh qualifier/credential/SDK holder, and attachment to the
same canonical live Session. It compares the original retained recipient receipt
and rechecks canonical adapter currency at launch while retaining already
observed response evidence independently. Sync and receipt-only finalization
have API/SDK/CLI shapes and bounded public accounting/state projections.
SDK/CLI transport controls pass, but this is not execution acceptance.

The new real initial-to-returning test fails at
`rounds_current_seat_sync_required`: published 9.5.1 requires an initial ACK for
any positive-sync policy, while Station's actual Session is created by its first
reserved report. Upstream PR1551 adds explicit immutable initial-request
admission while preserving every-release synchronization as the default, and
exports the controller's reservation identity derivation. Source review accepts
that scoped contract; it is not yet published or consumed here. The separate
runtime-alignment PR1540 also remains a prerequisite. No sibling source is used
as a Station dependency. Actual returning sync, storage recovery fault proofs,
renewal/retry serving, model-family/elicitation and native/device qualification
remain open.


### Candidate review repairs

Source review found a null-state authorization preflight refusal in receipt-only
finalization and JSON-encoding overflow for accepted context text. The repair
admits only the authenticated group's preflight while preserving exact projection
comparison under lock. An owner test retains a failed, allocated sync preparation,
closes its original source/SDK preparation, finalizes through fresh custody and
replays without model resend or accounting refunds. Wrong digest/revision and
revoked credential still refuse. This is controlled incomplete-receipt recovery;
actual answered-provider/returning-Session recovery remains unqualified.

Context uses separately bounded SDK text carriage rather than consuming the
ordinary brief allowance. SDK/CLI HTTP JSON and private context records allow
512 KiB for the full 64 KiB text bound after escaping. Sync final wire allows
2 MiB while ordinary report wire retains 1 MiB. Token/attempt/micro reservations
are unchanged. Boundary controls cover ASCII and NUL-heavy context, large
configured instructions, one-byte-over refusal and exact retained round-trip.


### Scoped context UI and checkpoint observation

The inspector now displays recorded context state and root accounting, offers
one explicit context submission, and offers storage-only publication for a
prepared receipt. A new current-authority checkpoint observation reads the
original source receipt and Flow state without an SDK, runtime or provider;
operators do not have to construct a private token. Its group/seat/revision join
is checked by the client and at the server. It grants no future execution.
Unsent drafts use the existing discard guard. Hooks stop admission/waiting on
unmount or authority loss and reject late responses even when a transport ignores
abort; they never retry unknown mutations. Controlled mounted/SDK/source tests
and typechecks are separate from real serving and physical-device evidence.
The inherited test-only credential restart forwarder was removed; its eight
call sites now use the actual recovery collaborator through test support, with
683 posture/confinement/orchestration controls passing. The original returning
execution prerequisite remains failed until the published Flow contracts are
adopted and runtime identity is proved.


### Context cancellation identity candidate

The returning-turn producer now durably retains a signed invocation/client-turn
binding to its captured Session before dispatch. Cancellation checks all root
invocations, preserves exact Session currency and names only the bound turn.
Private interrupt custody distinguishes multiple turns on one seat. Missing or
changed bindings refuse; authority remains revoked and cancellation pending,
with unresolved accounting held. The published-controller unknown-usage recovery
case exercises this refusal without another model call, and storage tests bind
immutable custody and per-turn receipt replay. Actual held-context interruption,
positive returning-Session receipt recovery and provider/device acceptance remain
open until the published initial-request contract is adopted and exercised.


### Flow creation UI candidate

Report creation now carries an explicitly selected existing Flow run and one
step per seat. Optional continuation fields use the contract ceilings and
strict SDK capacity validation. Coordination switches preserve unsent fields
while excluding disabled configuration from the request. Both report forms
share token-based controls and mobile target sizing. Mounted tests exercise
exact Flow/continuation payload, invalid reserved capacity refusal and no resend;
these do not establish serving availability or runtime-family diversity.


### Published runtime alignment adoption checkpoint

Flow Agents9.5.2 is now consumed through the managed installer, with registry
integrity `sha512-Apv1BrSsR1MzoYByCHqnp60cxG1YVh/WFY6iLEFeebS+6nB76vvmnz6WYpjx3keCzyrhbAou7vZUmrOM0n0LQQ==`.
Its release commit is `e78dccc77d665235119255ed88904df3d1396c79` and publish
run40109279530 passed. Registry retrieval initially returned404 after publisher
success; later install metadata exposed the version and the managed install
completed. Actual Node composition passes the public runtime assertion with
Station's `loadRun` and `withRunMutationLock`; Flow Agents resolves Flow5.2.2.
New Flow create/continuation paths assert this identity before new preparation,
while retained create/sync replay bypasses execution qualification.

This does not qualify the serving path. The first aligned controlled HTTP run
still hit its120-second Flow deadline. Its independent advisory control passed.
The separately executed sync-recovery fixture hit its30-second test timeout;
causation and host-load contribution are unproved. Server-test types pass. These
negatives remain required diagnosis work; no timeout extension, lock bypass,
provider acceptance or initial-request policy adoption is claimed. The positive
sync bootstrap contract fromPR1551 remains a separate publication prerequisite.


### Measured credential durability repetition

A temporary, restored diagnostic kept the HTTP graph and120-second policy
unchanged. At timeout it observed856 guard calls taking96.5seconds and12466
synchronous flush calls taking68.8seconds;58.4seconds of flush time was nested
inside guards. These numbers overlap and are not additive. The controlled fetch
seam had one call. Source tracing found each SDK credential read revalidated
twice, with file/directory flushes even for already confirmed immutable custody.

The candidate reuses only that same-process durability witness. Every read
still performs live authorization, source/configuration, revocation, expiry,
private-file content and identity checks. Changed file/directory witnesses and
fresh custody must reconfirm durability. Existing orphan-publication refusal
remains.36 credential/runtime-fence cases pass; HTTP improvement is not yet
claimed and must be measured through the unchanged serving caller.


### Round checkpoint refusal and remaining deadline

After credential durability reuse, the caller run passed40 cases and failed the
Flow HTTP case with explicit `rounds_checkpoint_reused`, rather than the prior
timeout. The initial loop reused its creation-policy reference for every round.
Each round now derives its checkpoint from group/controller, current revision,
observed Flow head, selected seat IDs and original policy. Flow still validates
readiness, claims, budgets and checkpoint uniqueness. Server-test types pass.
The first full run with this candidate still reached the unchanged120-second
HTTP deadline, so successful three-seat join execution is not established.
A matched post-change cost profile remains needed before another optimization.


### Controlled Flow HTTP completion checkpoint

Profile-driven storage currency now uses the existing current local-grant
request owner, while preparation/source currency still brackets round/authority
transaction bodies and guards publication and the final wire. Provider admission
and claim confirmation retain the prepared-source checks. Receipt persistence
no longer treats every durability boundary as a new provider preparation.
Defaults preserve existing store callers.15 persistence/HTTP/recovery cases
pass with the original deadlines; the strengthened separate-preparation fixture
also passes10 cases and server-test types pass.

The controlled HTTP Flow case now completes its three-seat left/right/join
run. The fixture originally counted both `claimed` and `settled` entries as
new claims; the corrected assertion requires exactly three distinct claims,
matching settled claim IDs, and empty active/blocked ledgers. It does not
hide duplicates by deduplicating step names. This is controlled canonical
HTTP/SDK/task/accounting evidence, not live provider acceptance, two-family
execution, elicitation, returning-session sync or native/device qualification.
Publication-boundary mutation and independent review are still required.

### Request-local Agent credential capture

A post-main diagnostic of the controlled three-seat HTTP path recorded 8,740
credential revalidations taking about 40 seconds. All three seats selected the
same Agent. Preparation now captures its managed selection once per Agent in
that request and validates each distinct credential lease at each group fence.
Seat source snapshots, SDK owners, task IDs and client-turn IDs remain separate;
credential authority, source bytes and configuration are still checked on use.
No lease is shared across preparations or Requests.

The new owner test fails on the preceding source for duplicate observation
records, with the distinct-Agent control passing. The repair passes both cases
and the two unchanged HTTP cases; server-test typechecking passes. Configuration
drift after capture refuses both reads and SDK access. These are controlled
fixture results, not a live-provider receipt or a general latency guarantee.


### Second-family direct-text preparation

A separate Google issuer derives bounded `gemini-2.5-flash-lite` preparation
from the actual source/credential leases and final installed-SDK wire. Report
preparation selects nominal provider profiles from the resolved Agent; dispatch
and retained turns carry that provider rather than assuming Anthropic. Existing
runtime/recipient receipt equality still refuses a provider/model or Session
rebind. Profile details, fixed validity and public-source limits are in the
[module map](../architecture/module-map.md#narrow-google-source-preparation).

The installed Google SDK's automatic continuation path is independently bound
by a real SDK-owner regression: 66 cases pass, a compiling post-start raw-fetch
bypass makes the new case fail with 65 controls passing, and byte-exact restoration
passes all 66 again. A first issuer/control selection passes 16 cases. The frozen
issuer/HTTP selection passes eight cases, including the three-seat mixed-family
HTTP journey after its control-plane fixture was corrected to load the requested
Agent. The Flow control remains red at its unchanged 120-second execution
deadline; a preceding diagnostic also observed a shared run-mutation lock
timeout. Neither failure is cleared by the mixed-family result. These are controlled
responses. No real model access, elicitation, native/device, billing or full-epic
acceptance is claimed.


### Host Flow mutation admission

A controlled test held a real Flow mutation and called the source-owned head
and claim APIs from another seat snapshot. Before the repair, four shared-run
or queued-abort cases failed while two different-run controls passed. The source
owner now queues per canonical workspace/run before entering Flow's native
five-second mutation ticket, bounds all outstanding calls to 128, and rechecks
captured request/source authority when dequeued. Flow's lock and exact claim/head
checks remain in place; this creates no scheduler or new authority.

Seven admission cases and the existing source-owner controls pass; server-test
typechecking passes. The combined run has 23 passing cases and the Flow HTTP
control still fails at its unchanged 120-second deadline. This is a contention
repair, not a latency acceptance receipt. Further work must retain that failure
until the full request passes without wider deadlines or weaker fences.


### Paired credential fence cost

A probe at the actual opaque SDK credential caller observed each of its two
captured configuration witnesses run 120 times for ten reads. The credential
store previously received the same combined configuration/runtime callback for
both fence roles. Each role now gets its own captured check plus current
request, stable runtime revision and home checks. Existing async boundaries
still call the combined pair. Neither original capture is dropped or shared
across requests, and provider bytes, authority and final-wire checks remain.

With the same probe, each witness ran 60 times for ten reads. Measured elapsed
read time changed from about 700 to 171 milliseconds on this host; that small
sample is diagnostic, not a general latency guarantee. The 37-case credential
selection passes, including an added configuration-change-between-captures
control that refuses before persistence. Instrumentation was restored. The
full Flow request deadline failure remains open until an end-to-end run proves
otherwise.


### Descriptor-sized private reads

A later isolated Flow profile at `f9d5234906a` reached the unchanged 120-second
request deadline after recording about 18.5 GB of zero-filled Buffer allocations,
including 13.2 GB in buffers at least 1 MB. Private source and credential readers
allocated their full configured byte ceilings for each small file read.

The readers now size buffers from validated descriptor size plus an overflow
byte, while preserving configured ceilings, fresh nofollow reads, full byte
hashes and post-read descriptor/path checks. Source reads additionally require
the bytes read to equal the captured descriptor size. No successful authority
or content result is cached.

The frozen four-file selection passes all 54 cases, including credential
configuration/revocation controls, source/Flow claim controls, the mixed-family
HTTP case and the Flow HTTP case under its original 120-second deadline.
Server-test typechecking passes. This closes the reproduced controlled deadline
failure for that selection, not a general latency SLA or live/provider/native
acceptance. The matching profile completes the request in about 113.4 seconds,
with about 720 MB of requested zero-filled allocations and 2.1 MB in allocations
at least 1 MB. It runs slightly more checks than the deadline-limited baseline;
these measurements do not establish RSS, throughput or a general speedup.
Independent source reviews of both the paired-fence and descriptor-read deltas
found no actionable findings. They did not execute timing or live-provider proof.

Main through `3381f971638` is merged normally at `ee66a6fd952`, without conflicts.
Managed dependencies and the real PTY check pass. A frozen six-file post-merge
selection passes 88 cases, including the report/credential/source controls and
Codex transport changes; server-test typechecking and the 122-topic shipped-doc
check pass. This is focused local evidence, not hosted or whole-epic acceptance.

Independent Google verifier R3 runs all six issuer cases, catches a different
exact-expiry-boundary mutation with five controls passing, and restores all six
green. Its SDK hash inventory occurred after generation rather than before;
strict requested sequencing remains NOT_VERIFIED. The two preceding verifier
rounds ran zero tests because of generated-module and workspace-link setup
failures. None of these results establishes live model access, billing,
elicitation or two-family runtime acceptance.


### Published initial-request policy adoption

Flow Agents9.6.0 is installed from the registry with verified integrity
`sha512-7rXtEhNmDahA4ItjPslGflt/HD8yaJfJY033aD72NXx4yeTOCO9tWWRvdrqEKPpxTo1ld+bXpaApXt301037Ig==`
and publication commit `16b8d03423434586af84001fd55a186bfcd392d8`.
The actual direct Flow5.2.2 references pass the public runtime assertion.
New positive-sync groups select immutable `syncAdmission: "initial-request"`;
legacy records without the field retain their policy and intent validation.

Before producer adoption, the returning-session case reproduced
`rounds_current_seat_sync_required`. It now passes the complete controlled
initial report, fresh SDK/no-tools context ACK in the same actual Session,
exact replay without resend, and changed-intent refusal. The fixture was updated
to the selected streaming profile and one advancing clock for both Date
constructors and Date.now. The preparation owner file passes20 cases, including
the new-policy projection and legacy missing-field validation. Server-test types
pass. These are controlled local results; authenticated authority narrowing,
retry/evaluation serving, live provider/MCP/device and full epic acceptance stay
open.

Main through `cd46072e664` is merged normally at `54b93c8c432`. Both competing
pairing tests were retained, generated documentation was rebuilt and122 topics
validated. Source-derived route inventory caught three missing continuation
POST declarations; their existing operate-tier/local-grant and group/source
checks were traced before declaring them. The merged scope file passes162
cases. No authorization floor was lowered.


### Reserved input profile and canonical answer candidate

An Anthropic-only fixed input-tool profile now parses a complete structured
question separately from report text. The SDK and independent raw observer must
agree after provider evidence is retained. Ordinary text and context-sync
profiles still refuse tools. The production report creator did not select the
new profile at that checkpoint; per-member selection is recorded below.

The private adapter opener installs the actual pending entry before lifecycle
emission, retaining the original Session, turn, controller, normalized form and
adapter-minted event identity. A server-owned registry handle refuses generic
boolean resolution and permits answering only after the canonical consumer has
read back the exact stored request/form. Cancellation during asynchronous
preparation cannot publish a question. The original native turn stays open
through its supplied input runtime; this adds no automatic second model call.

The four-file provider-profile selection passes148 cases. The expanded SDK
owner file passes78, including controlled raw-provider evidence through the real
reserved adapter, orchestration service and sqlite. The MCP integration file
passes7, including append-failure and stored-form mismatch acknowledgement;
registry and adapter controls also pass. Server-test types and lint pass, with
inherited lint advisories. Two test-fixture defects were repaired: leaked
prototype spies, and the fixture logger missing its real settlement method.
A later assertion was corrected to compare validated content rather than the
prototype-free map's object prototype.

These are local controlled checks. At that checkpoint the host-owned ordinary
MCP server, durable physical-send/question/answer ledger, production input-profile composition,
authenticated tool-removal renewal, fresh no-tools ACK and separately funded
answer-informed report remain open. No live provider, device, hosted or epic
acceptance follows from this candidate.


### Input-phase cancellation review repair

Independent source review of `8a577fc914b` found that the invocation transport
signal stopped propagating after provider completion. One retained combined
signal now covers provider delivery, the input runtime, asynchronous open
preparation and pending-question cancellation. The regression first reproduced
both invocation-only abort failures, with the adapter-abort and answer controls
passing. The repaired input/registry/MCP selection passes28 cases and server-test
typechecking passes. The shared SDK fixture is now explicitly typed and reused
by a dedicated reserved-input integration file; its four cases plus the76-case
SDK owner file pass80 cases.

The independent verifier separately exercised the original commit's exact
stored-form acknowledgement:24 green, one intended mismatched-form red with23
controls, then24 green after byte-exact restoration. That does not qualify the
later signal repair or any live provider/MCP/accounting composition. Those
remain subject to delta review and the outstanding integration work above.

### Private MCP input runtime and durable receipt candidate

The [runtime](../../src-server/runtime/mcp/report-input-runtime.ts) now composes
the installed MCP server, HTTP handler and client transport without an external
listener or fetch. Each tool send rechecks the exact captured grant. Retained
raw provider evidence must match its group, paid invocation, seat, execution,
root, envelope and usage before the logical input operation is claimed.

The [ledger](../../src-server/services/orchestration/report-input-ledger.ts)
persists one operation per group/invocation, one canonical question and at most
two physical sends. It consumes the send allowance before transport delivery,
retains the validated canonical answer before SDK reissue, and requires that
same answer as the final MCP result. Failed delivery does not refund a send.
Reopened custody cannot claim the operation again. A completed receipt is
published only after cleanup settles; completion metadata carries the receipt,
not human answer text. Private receipt reads verify its digest and exact scope.

Local controlled checks pass 11 cases across the ledger and real reserved-turn
MCP integration, including acceptance, decline, cancellation, invocation abort,
missing tool authority, failed second delivery and changed storage. Server-test
typechecking passes. These checks do not establish production profile selection,
the funded answer-informed follow-up, authority-narrowing adoption, live provider
behavior, device behavior or hosted acceptance. Independent review and mutation
qualification of this candidate remain open.

The subsequent readiness diagnostic found an OAuth startup fixture that answered
Codex initialization and thread creation but omitted the now-required authored
MCP inventory reply. It reproduced as one failure with 132 controls passing.
Supplying the actual connected-inventory response restores 133/133; production
readiness enforcement is unchanged. Verification policy passes once the new
test files are tracked. The broad connected-agent diagnostic timed out and is
not a passing receipt; the accumulated documentation review backlog still
prevents readiness acceptance.

Independent source review of `1cbdf96ffaf` found a P2: failed cleanup prevented
completion but discarded the invocation-local handles needed to retry cleanup.
The runtime now retains a bounded set of actual cleanup handles until settlement.
Explicit owner close stops new admission, aborts an open question, and retries
the same failed handle without sending again or completing its receipt. Ledger
and runtime checks pass13 cases, including failed-close recovery and shutdown
with a question open; server-test typechecking passes. Subsequent source-only
delta review of `c2db77ee941` accepted the cleanup repair. A separate local failed-handle
mutation fails the intended recovery assertion with eight controls passing;
byte-exact restoration passes all 13 ledger/runtime cases. This does not qualify
the later producer selection or live cleanup behavior.

The independent verifier separately confirmed the pinned `1cbdf96ffaf` baseline:
11 green, one intended mismatched-answer mutation failure with10 controls, then
11 green after byte-exact restore. Its report discloses a transient checkout
footprint over its200MiB limit before sparse reduction. That verifier did not
qualify this later cleanup repair or the main merge.

### Explicit per-member report input selection

Commit `9280a54bd3d` selects the fixed input profile only for a member's explicit
`operator-clarification-v1` intent. The root ceiling admits the fixed tool, the
parent remains tool-free, and non-opted-in child grants retain empty tool lists.
The input phase authenticates the original paid invocation and current grant
after the one-use SDK wire has been disposed; it cannot inspect or revive that
wire. Its completed receipt is checked against the actual member Session/turn
and retained in private report observations, outside public result DTOs.

The real-runtime mixed-member test passes, as does server-test typechecking.
A mutation granting the tool to every member fails the plain-text member's
empty-tool assertion; restoring the committed owner passes again. These are
local controlled receipts, not independent or live acceptance. The production
consumer still needs authenticated authority narrowing, a fresh same-Session
no-tools ACK and a separately funded answer-informed report.


### Post-input narrowing and adoption checkpoint

Commit `6224d8c7c1c` adds explicit SDK/HTTP/CLI input narrowing. The server
verifies the original completed private input and canonical question, prepares
fresh source and actual retained-Session witnesses, and issues a signed successor
that removes only the selected member's execution tool allowance. Original
ceilings, budgets, roster, provider, model and instructions remain fixed. Legacy
admissions without the original signed runtime witness remain readable but refuse
renewal; no identity is backfilled.

Authority renewal and rounds adoption commit separately. Exact-operation replay
can recover a renewed but unadopted group, including concurrent recovery, without
another epoch, model call or MCP call. Independent source review approved this
bounded slice after instruction-drift and concurrent-replay findings were fixed.
The real SDK/HTTP/runtime integration passes. Removing the instruction comparison
fails its changed-Agent rejection; removing replay authorization fails concurrent
recovery with HTTP 409. Each mutation was restored byte-exact and the integration
passed again. These are controlled local results, not live provider acceptance.

Fresh same-Session no-tools ACK, separately funded answer-informed report,
per-invocation delivery/cancellation custody, real Flow route-back/retry admission,
and historical-epoch reconciliation remain open. The ACK alone cannot authorize
a second paid report. Documentation freshness, final combined source qualification,
provider/accounting and browser/native/device acceptance also remain open. No
combined Station pull request or full-epic completion is claimed.

### Original pricing evidence for historical accounting

The response observer now retains the original approved qualification record,
including the complete serialized tariff, alongside its quote, thinking mode
and pricing timestamp. The record stays in private provider evidence; reading
it grants no execution capability and cannot revive a revoked qualification.
Existing evidence without this field remains readable. Historical tariff
verification and dual-ledger recovery still need to refuse missing evidence
rather than reconstruct it from the current registry.

The initial capture increment passes 131 controlled contract and SDK-retention
cases. Omitting the producer field fails all four provider/protocol retention
assertions with 72 controls passing. Source review requested an explicit
qualification-field projection to exclude undeclared owner metadata; that
repair passes the same 131 cases. No historical verification, published
Flow Agents adoption, live billing or full-epic acceptance follows from capture.

### Historical tariff verification boundary

Commit `8f8732aaddc` adds a pure verifier for the retained pricing basis. It
validates the original qualification at the recorded pricing time and recomputes
complete raw-response usage with the same tariff arithmetic as live pricing.
It does not consult the current registry or register executable contract/quote
handles. The private evidence read used by historical reconciliation requires
this verification; older records without pricing evidence refuse that mutation.
Ordinary historical reads and the input-phase evidence path remain separate.

The contract and actual SDK-retention/persistence tests pass 133 cases, and
server-test typechecking passes. The first composed run retained four failures:
its synthetic reservations exceeded the exact quote expected by the historical
join. The fixture now reserves the actual quote, matching production preparation;
the join was not relaxed. Ignoring the recorded pricing time fails both provider
controls, then byte-exact restoration passes all 57 contract cases. Independent
source review approved this boundary. Bypassing the persisted pricing check
fails all four provider/protocol cases at the altered-raw-JSON refusal, with
72 controls passing; byte-exact restoration passes all 76 caller-file cases. This does not wire
Dispatch settlement, publish the upstream Flow Agents contract, or establish
live/provider/device acceptance.

### Coherent original-turn observation for accounting recovery

At `2a6259477e3`, the private accounting draft reads the original personal report
turn through one EventStore SQLite snapshot. It joins fresh persisted owner and
lineage facts, the resolved client/provider turn pair and exactly one matching
completion, with row/payload identity checks. Raw tenant storage must be SQL NULL;
malformed or oversized non-null metadata cannot fall back to personal authority.
The same-connection resolved read uses Monument's workspace module contract with
an explicit active host transaction. This is not registry publication evidence.

Thirty focused read/persistence cases and server-test typechecking pass. The
real OrchestrationService read remains coherent when a second EventStore deletes
the Session between its component reads; a subsequent read returns unavailable.
Moving the first read outside the snapshot fails that case with 20 controls
passing. Removing the owner fence fails the foreign-owner case with 20 controls
passing. The tenant-storage control fails against the pre-fix owner with 29
controls passing. All source restorations were byte-exact and reran green;
independent source review accepted the repaired boundary.

The existing repeated live confirmations remain. No signed durable terminal
witness, changed deletion/retention contract, held recovery authority, Dispatch
settlement or recovery endpoint is supplied by this observation. Those remain
required before historical dual-ledger recovery is qualified. Evaluation/retry
serving and live/provider/device acceptance remain separate open work.

### Fresh local-grant registry observation

The private local-grant observer now checks the persisted paired-device registry
before consulting the existing request-security owner. A descriptor-bound read
checks the file identity and metadata around decoding, then validates the existing
registry schema and environment identity. It neither updates the cache nor writes
activity or migrations. Only an active parent credential minted by local-grant
with home possession and no person/account binding can supply this scope; aliases
and other identities need their own authority owners. The current route must also
be allowed by that persisted scope. Existing request binding, security checks and
host signing-key comparisons remain required.

The original observer accepted a credential revoked through a second pairing
service. The repaired observer refuses external revocation and scope narrowing
that removes permission for the current route, and refuses missing or malformed
registry bytes without repairing them. The
observer and three pairing/environment suites pass 152 cases; server-test types
pass. These are controlled local results. A fresh observation is not exclusion:
whole-file writers still need joined ownership and stale-write protection before
the historical recovery host gate can be qualified. No recovery route or live
provider/device acceptance follows from this change.

### Refuse a stale whole-registry publication

The pairing owner now retains the exact raw-byte digest loaded with its cached
registry, including the original bytes before schema normalization. Its central
publisher stages and syncs the replacement, then compares the current descriptor-
read bytes with that preimage before rename. A changed or deleted registry is
refused; a new owner that observed absence cannot overwrite a subsequently
created registry. The digest advances only after successful publication. Fresh
local-grant reads do not advance the cached writer's preimage.

The original stale activity touch demonstrably restored a second owner's
committed revocation. The revision check preserves that revocation and makes
explicit activity writes refuse the stale revision; the legacy verification
touch still swallows bookkeeping failures. This increment required reconstructing
a stale service before further publication; the owned registry spans below
supersede that limitation with a fresh validated snapshot. This is a pre-publication stale-state check, not an
atomic compare-and-swap: concurrent writers can still pass the comparison before
either rename. Participating writer ownership remains required for the complete
recovery hold, and ordinary cached authentication is not made fresh by this
publication check.

Independent review found a post-rename cleanup gap: the digest could advance
before the caller adopted the new cache. A controlled cleanup failure reproduced
a later activity write restoring revocation. The publisher now adopts the cache,
environment ID and digest together only after successful cleanup; a cleanup
failure retains the old preimage and refuses further stale publication. Reset
observers also see the committed empty registry before they can write activity.
A separate regression binds hashing to raw buffers rather than decoded UTF-8.
Those two review controls and the reset-observer control failed before repair;
the four owner suites pass 158 cases after repair, and server-test types pass.
The simultaneous-publication and cached-authentication limits above remain.

### Home writer and mandatory pairing construction

Pairing now requires `await DevicePairingService.create(...)`. The constructor
is private and checks its factory-only runtime key; all96 prior constructor
sites in39 files use the real factory. A canonical-home owner binds the existing
home and private security-directory identities, prepares the shared lock owner,
and holds a real lease while the factory reads or migrates the registry.
Initialization, credential rotation and reset acquire this home hold before the
legacy environment lock. Synchronous factory work borrows an explicit held
lease; no asynchronous callback inherits an ambient write grant.

Registry mutations acquire or borrow a short synchronous span before reading,
authorization, validation and clone derivation. The central publisher requires
that span before publication and rechecks it before rename. Authentication
lookups refresh durable registry state, so an older service sees another
owner's revocation instead of restoring or authenticating its cached grant.
Missing or corrupt authority refuses. The raw-byte preimage comparison remains
an independent check against non-participant changes during staging.

Borrowed spans invalidate before returning; thenable callbacks and late async
descendants refuse, and a lease from another home cannot borrow. Directory
replacement refuses rather than rebinding. Explicit async acquisition can settle
retained cleanup without repeating the protected callback. HTTP distinguishes
pre-effect503 unavailability from409 unconfirmed operation outcome. A registry
publication that may have changed disk before failing fences that service
instance until reconstruction, so its old offer cannot silently mint again.

The home hold now also covers personal-token mint/revoke/clear and native-push
sidecar mutation, including alert/card bookkeeping and iOS tombstones. Store
construction requires the prepared home owner. Token-file mutation uses the home
hold instead of its former separate lock; older nonparticipating builds are not
excluded. Reset passes its live lease to both token clears. A competing authorized
mint rechecks its caller after the hold, so a reset-revoked credential cannot mint.
Token lookup performs a synchronous best-effort timestamp touch, with no detached
write left to run after the request. Multi-file exclusion does not provide atomic
rollback across identity, registry and sidecars.

This is participating-writer integration, not complete historical recovery.
Signed terminal/intent retention and dual-ledger serving remain open. No live
provider, browser/native/device, release or full-epic acceptance follows.

Independent review found two integration gaps in the participating-writer change:
retirement callbacks scheduled the publisher under an expiring writer context,
and ordinary token routes omitted the post-wait admission callback used by the
initial reset test. Notifications now wait for release and start outside that
context. The self-service and operator route owners pass currentness checks into
the held mutation; self-service also rechecks the required operation scope and
exact person binding. Composed route controls reproduced successful stale mints
before repair; timer-driven retirement controls replace forced worker draining.
These controls remain local evidence, not provider/device or full recovery proof.

### Published recovery contract and coherent authority validation

At that historical checkpoint Station selected Flow Agents 9.8.0, Flow 5.3.0 and Dispatch 0.8.0 together.
Registry tarballs and every installed package file were compared byte-for-byte;
all 201 included Flow Agents source files match release commit
`e2baf1e292d7d35fdc9ca68591ddb549ba02d82a`. Station and Flow Agents resolve the
same Flow and Dispatch module instances, and the public recovery export loads.
These checks do not establish that Station's recovery host or endpoint is wired.

The first composed consumer run after writer integration hit all three execution
deadlines. Profiling and source tracing found nested freshness checks repeatedly
publishing separate home locks. Local-grant assertions, source/Flow guards,
whole-roster validation, preparation/custody callbacks and response authorization
now share one home span for each complete synchronous check. Existing principal,
scope, signature, source, runtime and expiry checks remain. No hold crosses an
await or stream boundary, and each later check reacquires current authority.

Owner-boundary regressions measured ten or twelve lock publications before
repair and one afterward, then refused independent revocation on the next call.
The focused authority suites pass 29 cases and server-test types pass. Earlier
partial batching restored independent and mixed execution but not Flow. Final
composed execution remains required; deadlines and provider qualification windows
were not enlarged. Signed retained terminal/intent evidence, dual-ledger recovery
serving and live provider/device acceptance remain open.

Execution finalizers and SDK inspection now share their complete synchronous
checks as well. An observed SDK credential read uses a required request-bound
observation scope supplied by the existing local-grant owner, forwarded by the
runtime owner; both original credential revalidations and secret selection still
run inside it. Its regression measured six publications before repair and one
afterward, followed by refusal of a later revocation. The four credential/authority
suites pass54 cases and server-test types pass. Filesystem durability fault probes
now identify the observation record or directory by descriptor identity, so a
home-lock flush cannot masquerade as the observation durability check. Composed
execution qualification is still pending.

The next composed run passed independent and mixed execution but again exhausted
the Flow preparation deadline. The remaining consumer run passed28 cases and
timed out five; a profiled preparation-only run on unchanged source subsequently
passed20 cases. Those results do not establish reliable composed completion.
Both SDK and response-scope removal mutations failed at their intended hold-count
assertions, then passed after byte-exact restoration.

Current-source profiling and an extended SDK-read regression found60 pairing
registry opens inside one home hold. Complete authority checks now share one
validated registry snapshot and confirm its bytes before returning, reducing that
read to two opens. A callback-time registry substitution refuses, and a later
revocation is read afresh. Four owner suites pass48 cases and server-test types
pass. The controlled task-driver fixture also groups its complete synchronous
finalizer like the production execution owner. Literal route classification
avoids splitting paths that cannot match a parameterized route. No deadline,
durability flush or authority predicate was removed; composed execution and the
five timed-out cases still require qualification on this revision.

Independent source review found the first snapshot implementation suppressed
the existing credential-activity timestamp touch. The persistence-fault owner
test reproduced that omission. Snapshot lifetime is now separate from registry
operation nesting, preserving the cadence and failure/retry behavior; the four
owner suites pass48 cases after repair. The final byte comparison was
disabled in a local mutation: the callback-tamper assertion failed alone, then
all15 credential-owner cases passed after exact restoration.

At `c0d427f26b0`, all20 preparation cases and all7 Flow-lock admission cases
passed in the combined consumer run; independent and mixed execution also
passed. Flow still exhausted its120-second input deadline, and the complete
sync-recovery case hit its inherited30-second test guard. Those failures remain
part of the evidence. The positive execution fixture now uses240 seconds for
every mode, within the unchanged300-second product maximum. This is functional
qualification at a different supported input, not recovery of120-second
performance. A real prepared handle remains readable one millisecond before its
deadline and refuses at the exact deadline without a provider call. The sync
case retains all receipt, replay, cancellation and accounting assertions with
an explicit60-second test guard; its six-case file passes. Production timing
and expiry checks are unchanged. Final execution on this fixture remains pending.

### Merged consumer qualification and retained terminal witnesses

Normal merge `64a6911bd36` integrates `main@b3901a5ddc0`; the only conflict was
the process-resource manifest, resolved by retaining both lanes' classifications.
Managed install, dependency checks and lint pass. Resource-manifest, SDK stream
and canonical direct-chat turn-key owners pass 67 cases. The five composed
report execution, preparation, lock admission, sync recovery and exact-expiry
suites pass 40 cases on that clean head. Registry tarball bytes and shared
Flow/Dispatch module identity were reverified after installation. This qualifies
controlled functional execution at the disclosed 240-second input, not live
provider/device behavior or the earlier 120-second bound.

The next increment captures a host-signed terminal witness from the existing
coherent personal-turn read. It binds group, seat, invocation, original root and
envelope, physical evidence and the exact owner/conversation/Session/client-turn/
provider-turn/completion tuple. Initial and continuation terminal producers retain
it within the private observation. Storage rejects a witness attached to another
observation; a retained signed witness can still be verified after Session
deletion. Legacy unsigned observations are accepted without reconstruction.
Owner/storage suites pass 33 cases and server-test types pass; composed producer
qualification is pending. This supplies retained accounting metadata, not a
recovery grant. Durable recovery intent, held recovery authority, checked
Dispatch/Flow settlement and public recovery serving remain open.

The witness producer suites subsequently pass all four cases at `d06f8e73231`:
three execution modes and returning continuation capture. Both independent source
reviews accept the bounded witness delta. These remain controlled local results.

### Private published accounting-recovery host

The private runtime now calls published `recoverAuthorizedDelegationAccountingV1`.
It acquires an explicit home lease, borrows it only for synchronous currentness
checks, then reads through the real admission/group/authority/evidence/wire locks
before recovery admission. Those reads drain any earlier publisher that passed
its final check before the home hold. Dispatch remains independently mutable;
its checked settlement revalidates the exact reservation under its own lock.

An immutable signed intent binds operation key, original epoch/envelope,
invocation, reservation tuple, terminal witness, final-wire digest and accounting.
It is retained before settlement; replay reauthenticates raw tariff evidence and
compares the complete signed candidate with retained bytes. An unsigned terminal
can only acquire new evidence from a still-observable coherent original turn;
missing deleted history is never reconstructed. No runtime preparation,
invocation, reservation, release or refund occurs in this recovery method.

The composed owner test begins with deliberately lost ordinary settlement and
Flow publication, verifies a retained unknown group, then loses Flow publication
after recovery commits Dispatch. A returning runtime completes the same intent
after Session deletion without another model/Session/turn/reservation. Signature
and raw-evidence tampering refuse. Grant revocation is excluded during the hold
and refuses later replay after release. A separate unknown-response case retains
the exact reserved capacity across recovery/replay with zero settlement/release
calls. The recovery/persistence/coherent-read owner run passes35 cases and
server-test types pass. The private-core review and mutation evidence are recorded
below. The public HTTP/SDK/CLI recovery surface is mounted as described below;
broader/provider/device/hosted
qualification remains open.

Independent source review of `65b6acceb35` found two first-admission gaps: consumed
wire metadata was not compared in full, and missing later-turn proof could fall
back to the initial turn. The wire control altered only controller generation,
preserving lookup identity and the final-wire digest; it reached settlement before
the repair. Recovery now checks the entire expected wire tuple before admission.
The second control ran initial and acknowledged context-sync invocations on one
Session, then removed the later continuation binding and terminal observation.
The old path accepted recovery; the repair refuses instead of signing the first
turn as the later invocation. A valid signed later witness remains sufficient
after the auxiliary binding is removed. All three composed recovery cases and
server-test types pass after repair. Cross-process publication-drain probes,
public transport review and broader qualification are still open.

The accounting-recovery HTTP/SDK/CLI transport is now implemented with an
explicit public response allowlist and old-host unsupported handling. The composed
recovery case traverses the real HTTP route and SDK after Session deletion.
Cross-process publication-drain probes, provider/device qualification and final
combined review remain open; this transport does not close #91.

Public transport qualification: 51 tests pass across the recovery, SDK and CLI
owners. The SDK and server-test typecheck lanes and lint pass. This is controlled
local evidence; readiness still fails documentation freshness, and no provider,
device, registry publication or hosted acceptance follows from it.
