# Child-work epic

One ongoing branch, `feat/child-work-epic-20261021`, owns work outside the
master consolidation in #3991. It starts at published
`d96f54887837be058c5e5119b8028daab0befea1`. Merge subsequent master/main
normally before publication. Open one PR when the combined work is ready.

## Implemented locally, acceptance still open

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

Station now consumes published Flow Agents 9.4.0 at `d835da49916`.
Upstream implementation PR #1543 and generated release PR #1544 merged;
the registry artifact and Sigstore provenance name release commit
`dcbad2e736cc5ffc6e93b6412d4b92239bb292f1`. Archive integrity, 197 included
source files against Git blobs, two npm signatures under one unexpired registry
key, and the exact provenance workflow/tag/source joins pass. All 36 typed
public exports import from inside the extracted artifact. Its declared
production dependency map matches the prior installed graph; this is not full
runtime compatibility or generated-code reproducibility evidence.

All four pins and the managed lockfile select 9.4.0. Normal managed installation,
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

## Authenticated report-group preparation

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
provider termination.

Public serving lookup, fresh-request cancellation, Flow-backed frontier/join and
session ACK remain required before enabling the paid-group capability. The control-plane read responses and provider response in this
qualification are controlled; live ingress/provider acceptance remains open.

## Controlled reserved Station turn integration

The internal reserved-turn port now reaches the real Station adapter through
session start, turn dispatch and canonical event persistence. It consumes the
sealed SDK attempt once, bypasses the ordinary chat endpoint, retains evidence
before publishing usage/completion, and refuses unreserved continuation or
identity changes. Output is buffered; tools, approvals and continuation are
unavailable for this mode. The metadata describes a restriction, not a grant.
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

Local group transport includes the shared Station contract, SDK HTTP/SSE
clients and registered CLI commands. Independent reviews closed the original
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
Boot issuance and managed transport composition remain unwired, and the group
capability remains disabled. These checks establish neither live consent nor
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
