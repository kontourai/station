# Shared work delivery ledger

Status: active, refreshed 2026-10-03. Owner request: drive the full discussed program to
completion. This ledger is not completion evidence. The product target is
[Shared Task channels](../design/shared-task-channels.md).
GitHub program: [#3034](https://github.com/kontourai/station/issues/3034).

## Completion rule

The program remains open until every track has a delivered result with its
acceptance evidence, or a documented external prerequisite and a concrete
remaining owner. A first UI slice, filed issue, closed related issue or green
focused suite does not complete the program. External prerequisites remain
unfinished work, not silent exclusions.

| Track | Deliverable and acceptance | Current state |
| --- | --- | --- |
| Product value | Backlog idea to accepted result, visibly shared by people and agents; explain the advantage over direct chat | Design target recorded; user journey not yet executed |
| Task board and channel | Recorded-status board, brief/conversation first, readable contributions, decisions and results; keyboard and narrow-width proof | Initial board and shared-workspace slice merged in #3037; complete channel journey remains |
| Connected backlog | Pick up an exact provider item, probe it, retain source, and explicitly choose implementation or disposition; supported write-back uses provider authority | Existing provider rows are read-only in inspected UI; remaining implementation |
| Agent participation | Project-scoped @agent autocomplete with keyboard/touch/IME support and exact removable tokens; send-time readiness/authority checks; accessible equivalent, scoped context, requester attribution, durable request/work card, result and steering | Merged personal request journal/composer #3080, independent lifecycle history #3084, fixed brief preview/binding #3099; contribution artifacts, invited/public and result acceptance remain |
| Invited collaboration | Two humans can discuss and call agents where authorized; permissions, approvals and revocation remain enforced | Existing room/membership foundation; redesigned journey not verified |
| Public viewing and contributions | Deliberate publication, versioned results, attributable proposals and revocation without private-data disclosure | Existing sharing targets authorized Project viewers; public modes remain to implement |
| Previews | Inspect a produced app/document/change and submit feedback against its exact version; stale and isolated content cases | Existing file/diff/output inspection; preview-feedback composition remains |
| Evidence and acceptance | Visible changes, checks, uncertainty, reviewer disagreement and acceptance; engine completion does not imply success | Existing references/output snapshots/Basis; outcome UX remains |
| Onboarding and continuity | Install, connect, select backlog work, start it, leave available host running, inspect from phone, resolve decision and review | Existing first-run/Starter/device paths; full redesigned journey remains |
| ChatGPT-plan access | Assess eligibility and implement supported sign-in, usage attribution and limit recovery with live authorized account proof | Official contracts located; eligibility/account proof remains |
| Managed Agents API | Compare one real job on existing and managed execution; steering, interruption, recovery, artifacts, data boundaries and measured cost | Official managed-harness contract located; adapter/evaluation remains |
| Cloud and computer use | Available-host/cloud routing and one bounded UI-driven job; observe failure, approvals and recovery | Existing environment/delegation paths; fit assessment and proof remain |
| Plugins and distribution | Useful Station workflow inside ChatGPT and reusable agent/specialist package with readiness and permissions | Existing plugins/delegation; #2903 reused for specialist/commercial exploration |
| Events and responsibilities | One scoped recurring/event-driven responsibility with per-run outputs, budget, escalation, cancellation and history | Existing Scheduler/event owners to assess; workflow remains |
| Model and speed choices | Real-job comparison of supported models/tiers using accepted results, latency, human repair and cost; no invented savings | Evaluation remains |
| Security review workflow | Reuse available scanning/review capabilities, show validated findings and proposed changes with evidence | Integration fit and real-work proof remain |

## Existing backlog and ownership

Live-read on 2026-09-30: [#582](https://github.com/kontourai/station/issues/582)
owns shared working state; [#418](https://github.com/kontourai/station/issues/418)
owns Basis; [#2903](https://github.com/kontourai/station/issues/2903) owns
plugin/specialist/outcome-priced exploration. Related open UI/result items
include [#2844](https://github.com/kontourai/station/issues/2844) and
[#1879](https://github.com/kontourai/station/issues/1879); reproduce before
claiming repair. Preserve other sessions' ownership and in-flight PRs.

## Delivery sequence

1. Board and conversation-first Task composition using existing records and panes.
2. Backlog pickup and explicit agent requests through existing admission owners.
3. Contribution/result projection and version-bound previews/feedback.
4. Invited two-human collaboration, public publication/proposals and revocation.
5. Full install-to-result/phone journey and ongoing responsibility.
6. Provider, subscription, managed harness, plugin distribution and model/security
   evaluations, each with its documented eligibility and operational boundaries.

Use independent review and verification for substantive slices. Each receipt
must bind the exact revision, environment, commands and observed result.


## Resumed landing and remaining work: 2026-10-03

Live GitHub REST confirmed #3037, #3080, #3084 and #3099 merged into main.
#3113 merged into the results branch, not main. Its private output provenance
therefore remains part of open #3106. The restored orchestration checkout owns
no implementation edits; the preserved results lane was clean at `09ee00c6c7`.
Its local main merges and remote provenance squash `0ab2fcb159` were both
preserved, then current main was merged at `992f86ee6f`.

Five focused output route/store/SQLite suites passed 265 tests on that combined
revision. Independent source review found a replacement-Task quota defect:
old incarnation outputs were hidden but still consumed the per-Task quota.
Two owner-boundary cases, ordinary and declared creation, failed with the
expected limit error before repair; the repaired output-store suite passed 28.
Independent delta review found no remaining issue. At `63ef1abfc4`, an independent
route mutation removed only the Task creation witness: baseline 12 passed,
injected 1 failed / 11 passed (201 instead of 404), restored 12 passed with
byte-identical source. Landing remains pending on CI and required pre-push
gates. Hosted queue and release proof remain separate.

The frozen CI run was infrastructure-canceled during host ENOSPC. Its retained
receipt `692005dbcde212ca8278ed3a35db1d376920bbb8a7512cfbf5e365681fdf9bbe`
recorded no completed Vitest counts. Captured runtime errors are not an identified
failing assertion. A subsequent retry was stopped pending coordinated capacity
recovery; neither run is passing CI evidence. Only generated dependencies in
this thread's inactive verifier were reclaimed; source, commits and receipts
remain preserved. Heavy validation is held until stable host capacity is
established.

This thread owns the remaining sixteen-track ledger. Next active slice is
exact-output-version feedback and review through immutable Task outputs and
attributed room history in its isolated sibling lane. Its incomplete source
is under review; route, SDK, UI, migration and browser acceptance are still
required before publication. Current blockers are delivery work and unexecuted
acceptance journeys, not a claim that available foundations complete them:

- Results: private provenance landing, version-bound feedback, disagreement and
  explicit human acceptance still need delivery and browser evidence.
- Collaboration: invited two-human calls/revocation and deliberate public
  publication/proposals need their own authority and privacy acceptance.
- Backlog: exact source pickup, disposition and supported tracker write-back
  need the existing provider admission owner and a real tracker receipt.
- Continuity: installed host-to-phone journey needs installed/runtime and
  physical-device proof; artifact transfer alone is insufficient.
- Provider/evaluation: sign-in eligibility, managed execution, cloud/computer
  use, model latency/repair/cost and security workflow need current official
  contract assessment and bounded real-job receipts.
- Distribution/responsibilities: ChatGPT workflow and specialist distribution,
  scoped event/recurring work, budgets/escalation/cancellation need acceptance.

Ownership refresh found active relay, featured-Station/distribution,
knowledge/tools, profile and chat-start sessions. Open #3197, #3213 and #3188
cover adjacent relay, bundled marketplace and usage-limit recovery work;
coordinate those owners before changing their surfaces or arming their PRs.
These lanes are not this programme's acceptance evidence.
