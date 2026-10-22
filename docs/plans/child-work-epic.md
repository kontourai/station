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
  stays separate from the self-reported client surface. No external
  orchestrator is inferred from text or User-Agent.
- **Native activity:** Codex child-owned tool items project bounded tool names
  through the shared activity UI. The inspected Muse protocol has no child
  tool stream; its missing value stays absent.

At `3a5ca9c8a5d`, the contract suite also binds the documented handle-only
case: without text, a recovery handle has no summary provenance and cannot
replace an existing report or its recovery handle. All 46 cases pass; removing
the text-presence guard fails the new assertion with 45 controls passing.
Byte-identical restoration returns 46 passing cases. This adds regression
evidence for the existing contract, not a new live return/recovery claim.

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

Flow Agents 9.3.0 is published. Upstream PRs #1535 and #1536 merged, and the
release artifact identifies `ab2b320aeec4bf1ec98e1ff4ae456877863bd5b7`.
Station's four workspace pins and managed lockfile select 9.3.0. After authorized
archival of the failed installer receipt, the normal managed install completed;
approved lifecycle/native checks and the PTY handshake passed. The installed
package's 367 inspected artifact files match the verified tarball. Managed
installation does not establish supported group execution or provider acceptance.

The published 9.3.0 pin and managed installation were explicitly authorized.
Subsequent rounds, renewal and accounting work followed the agent's assessment
of contract gaps; issue requirements and that assessment do not establish blanket
authorization for every new primitive. Brian requested an independent scope and
product-ownership audit. Station consumes published contracts rather than
sibling internals, and the upstream release and single Station epic PR have
separate acceptance evidence.

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
that path. Preserve the existing candidates and fail-closed behavior; hold
upstream publication and generalized authority migration until a concrete
Station consumer demonstrates the necessary contract changes.

The first working group will use existing signed-in CLI engines and Station's
existing session authority, permissions and confinement. This is the owner's
chosen first integration path. Portable Flow-envelope lineage remains explicitly
unbound/incomplete; #205's full lineage and restriction requirements remain open.
Hard dollar caps, physical-attempt limits and native token bounds must be reported
unavailable when the selected engine cannot enforce them. Unknown cost is never
zero. Direct API qualification and tariff work remain preserved for a later path.

Keep the full epic and one-final-Station-PR rule intact. The CLI increment does
not complete peer/SSH lineage, context synchronization or the remaining folded
requirements. Hold upstream publication and generalized authority migration
until an actual consumer requires them.

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

The no-tools continuation gap remains open. A non-model OpenCode probe on this
host found CLI 2.0.32 rejects the existing `debug agent` command and advertises
`debug agents`; the latter returned an empty list under the process-local deny
overlay. This is no resolved-policy or tool-enforcement proof. Shared engine
configuration was unchanged, and no provider turn ran.
Inspection of the installed Claude SDK also shows that `tools: []` removes
built-in tools only, while `setMcpServers({})` retains plugin-owned servers.
Neither control alone establishes an all-tools-disabled continuation of the
same delegate session. The generated installed Codex `turn/start` protocol has
no direct all-tools-disable field; that is not proof that no alternative native
mechanism exists. No context-sync action is exposed on these observations.

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

Independent source review supports this as a candidate model-tool restriction
for the checked CLI/SDK pair, not universal no-tools authority. Production work
must bind the group caller to an exclusive per-thread activation generation,
coalesce only matching policy/identity starts, confirm the old engine exited,
and recheck the generation before send. It must persist logical attempts before
effects and exact per-member ACK receipts afterward, retaining ambiguous holds.
Ordinary mode must return through another exact native resume. Codex/ACP sync
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
request or shared configuration write occurred. Independent native execution
qualification is pending. This does not close plugin/delegation/internal-effect
coverage, real-provider sync, #205 restrictions, fiscal guarantees or full epic
acceptance.

## Production adoption sequence

The personal `/api/orchestration/session-groups` path now composes the shared
authorized delegation handler with installed Flow scheduling. It persists seat
launch intents and reserved session/client-turn identities, retains returned
provider-turn identities and admits dependencies from an explicit Station
completion observation. Controlled HTTP tests cover three actual orchestration
sessions and event-store joins, plus refusal at the adapter boundary after
cancellation during Agent preparation.

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
inventory-refusal checks pass. A fresh live Station elicitation check remains
required; the earlier model refusals are not silently converted into success.
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

At `1c682a5a2dd`, a read-only retained-session check observed the earlier mixed
CLI group's completed tasks and closed, idle, resumable conversations. The real
390px browser showed directory context and Operator/CLI provenance across
reload, with no Active now lane or document overflow. Startup carried a
pass-through process-probe diagnostic; the prior uninstrumented start refused
its own process identity and remains unexplained. Both screenshot attempts
timed out. This is not a fresh running-to-ready journey, packaged desktop or
second-device acceptance, and made no provider calls.

This establishes only the exercised CLI paths. Live elicitation, second-device
lifecycle, the remaining lineage/context/recovery obligations, final combined
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
regressions. Server-test types pass. Exact tariff usage remains private evidence:
the installed legacy controller refuses settlement without provider-reported
dollars and retains the full allocation. AccountingV1 integration remains
required. The independent composition review completed with no blocking findings: it checked canonical durable joins, exact
wire/source binding, pending duplicate isolation, incomplete JSON/SSE usage,
unknown allocations and SDK-waiter cleanup. Its compiling waiter-refusal mutation
failed as intended and exact restoration passed. Real provider/registry authority
and AccountingV1 settlement acceptance were not established.

Flow rounds/continuation and v3 authority renewal are adopted in the Flow Agents
worktree at `57f02040`; `36de11b1` joins their independent, paid Flow and
session-bound context-sync paths to AccountingV1. The combined source builds,
passes documentation checks and 20 focused cases. A compiling recipient-return
mutation loses sync accounting as intended; exact restoration passes the three
accounting cases. At that checkpoint, independent review of the combined Flow
source was still running;
the Station response composition review passed within its stated fixture scope.
The earlier rounds review failed without a completed verdict. The interrupted
full-readiness process left no terminal receipt and is being requalified on the
same Flow head; the earlier accounting-only readiness pass does not qualify it.
Everything remains unpublished, and Station still consumes published 9.3.0.
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
