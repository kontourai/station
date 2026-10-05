# Shared work delivery ledger

Status: active, refreshed 2026-10-04. Owner request: drive the full discussed program to
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
remain preserved. The capacity owner subsequently authorized one bounded CI run.
At `678c6e415b`, related-test discovery exhausted its 117887ms selection budget
before running tests (receipt `36bcc35f7e20f603be80ff8eeeaf67a193d3dd4b176604bbb12510af3b780cac`).
This is not passing CI evidence. Required pre-push gates passed at `a496c4a733`,
including all twelve typecheck lanes, transfer, static, governance and readiness
checks. GitHub REST confirms #3106 merged into main on 2026-10-04 at 06:29:27Z,
including its child provenance layer. Hosted promotion remains separate.

This thread owns the remaining sixteen-track ledger. Next active slice is
exact-output-version feedback and review through immutable Task outputs and
attributed room history in its isolated sibling lane. Its committed source has independent review and focused evidence. Seven suites
passed 269 tests across runs after repairing a UI assertion about the existing
unsaved-changes dialog. Removing unconditional fresh-target validation failed
the history owner test; restored history passed 68. At `112bc0a603`, independent
late-requester-revocation mutation proof passed 60 baseline, failed one intended
assertion when checks were removed, then passed 60 restored. These are bounded
local proofs; browser, broad CI, publication and release remain pending. Current blockers are delivery work and unexecuted
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

## Adjacent owner handoff: 2026-10-04

Relay owner reports #3114, #3190 and #3199 merged. Enrollment, activation trust
and recovery source/simulator evidence do not prove physical iPhone delivery.
At this dated handoff, their operator-control lane retained ownership and awaited
account-gate #3210, docs/UI/CI/publication. The native-only gate admission is now
integrated in source; this does not supply this programme's native/physical or
two-human acceptance evidence. This thread does not edit or arm that lane. Nightly has
a separate sole owner; no competing dispatch is authorized here. The accepted
two-human work journey and physical no-Tailscale journey remain distinct.

The read-only B10 SSH reachability probe failed; no installed-package or phone
journey proof was obtained. Provider pickup/writeback is not implemented by the
existing read-only WorkItemProvider. Published Flow Agents contracts expose a
GitHub mutation renderer, which is not an applied tracker receipt. Managed Agents
and plan access still require eligible configured accounts and real-job proof.

## Personal feedback browser receipt: 2026-10-04

Isolated built revision `70fecefef9` (later commits only add documentation review
notes) ran on server 42731/UI 42741 in a throwaway Station home. Bootstrap pairing,
Project/Task/output setup used the actual authenticated routes. The collaborative
browser inspected a 63-byte retained text snapshot, recorded a comment and an
accepted-version statement, and displayed both attributed statements against
output `f69a3f5b-bf70-43a2-852a-44547c187013`, digest
`sha256:8e441ba14bb2c59b5e1716e6f4d07291d16c82a0deb51b5c888f7d5c83200c8a`.
Task status remained `todo` on the actual GET; reload retained both statements.
At 390x844, document width remained 390, with review select/button heights 44px
and textarea 96px. Tab moved from comment to Record review; Enter submitted.
Native select keyboard automation did not change the selection; acceptance
selection used the DOM change event before the keyboard submission. Hide opened
the existing unsaved-changes dialog; Cancel preserved the draft. Dark and light
token rendering were visually inspected, with light selected through the DOM
theme attribute rather than a Settings journey.

Screenshots: `browser-screenshot-localhost-mutgk25e-d7add16b.png` (dark) and
`browser-screenshot-localhost-mutgkl3v-df30473e.png` (light), retained in the T3
browser-artifacts directory. A post-reload connection-health timeout banner
appeared while Task history still loaded; this receipt does not certify overall
connection reliability. No provider invocation, two-human invitation, public
publication, physical-phone or hosted release journey was executed.
