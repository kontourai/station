# Task room agent requests

Status (2026-10-09): implementation in progress under [#3034](https://github.com/kontourai/station/issues/3034) (open).
This slice implements a durable request path and an explicit agent composer for
the [shared channel](shared-task-channels.md). Local controlled tests verify
selection and retry behavior; browser, actual-provider and invited/public
acceptance remain unfinished.

The Task view records its selected view in the URL's `taskView` parameter;
missing or unsupported values open **Overview**. The URL can survive authority
re-verification, but it grants no access. The protected Room subtree remounts
when the API base, request authority, Task ID or Task creation time changes.
That remount does not restore Task data, drafts or editor mode from the view
choice. **Plan** starts in preview; editing remains an explicit action.

## Owners and transport

The [work module](../../src-server/services/projects/task-room-work-module.ts)
records a request before the existing delegation owner can start an agent.
It does not replace TaskGraph, TaskDispatcher, Session commands or delegation.
Multiple requests retain independent execution identities without overwriting
the durable Task's current-session association.

The [delegation route](../../src-server/routes/orchestration/orchestration.ts)
accepts an explicit `taskRoomRequest` with `taskId`, `taskCreatedAt` and
`operationId`, alongside
the existing prompt and execution target. Initial targets are current-Station
agents in the exact Task Project. Normal dispatch scope, caller attribution,
full-access admission, readiness and workspace resolution remain in their
existing owners. Remote target support remains unfinished; no parity is claimed.

`GET /api/tasks/:taskId/room/agent-requests` reads the authorized request view.
Its `station.task-room-work/v1` version is the negotiation prerequisite for a
client: an older server can strip unknown delegation fields, so a client
must not assume durable request support without this versioned response.
This path is mounted in the personal runtime. GET retains the existing
orchestration read grant and POST the existing operate/admission gates. The
composer refreshes the journal before a fresh request and after its
acknowledgement. Room SSE refreshes history and Task status; there is no
five-second polling card. Reconciliation is coalesced. Completed-answer
reconciliation is scheduled after request responses and runs from canonical turn
events. Human message/status recording
retains its confirmed write boundary, with failures isolated from dispatch
acknowledgement; duplicate proposals make no history writes or history
notifications. A private publication hold preserves human prompt before answer
order even when a completion arrives before the human history write. Refusal and
failure release the hold. A hold expires after 30 seconds so an abandoned request
cannot block later publication indefinitely; it does not confer execution authority. A bounded
in-memory set avoids repeated lookups, and durable proposal lookup covers restart
and cache eviction.
Existing document/history updates continue using SSE and HTTP.

## Images and files

The main Task room composer and agent-thread reply composer accept file drops,
clipboard screenshots and picker selections. Image previews and removal controls
appear before sending; image-only messages are allowed. Intake reuses the chat
limits: five attachments, 5 MiB per file and 15 MiB combined, with the same image
conversion and resizing rules. Clipboard paste depends on the browser exposing
files; native keyboard image insertion is not qualified by these tests.

The [Task asset store](../../src-server/services/projects/task-room-attachments.ts)
saves bytes separately from room history. Upload and reference resolution require
current message-write authority; byte reads require current history-read authority.
Bindings include the canonical Project, Task ID and Task creation time. Knowing an
attachment ID grants no access. Room history and durable agent requests store only
`TaskRoomAttachment` descriptors. Bytes use the existing content-addressed store's
retention settings (90 days and 512 MiB by default); a retained history entry may
therefore outlive its bytes and show an unavailable attachment.

The [room routes](../../src-server/routes/orchestration/project-task-rooms.ts)
expose upload and authenticated byte reads under `/api/tasks/:taskId/room/attachments`.
Initial requests and replies resolve references under Task authority and pass the
bytes through the neutral provider attachment contract. The provider/model still
owns image capability; a reference in room history does not establish that an
actual model understood it. Ordinary room messages share images without starting
an agent.

Uncertain main-composer sends preserve attachment references with the original
operation/proposal for explicit retries, including after reload. Unsent local
files are guarded as dirty state but are not restored after reload. An upload
failure keeps the draft and prevents dispatch. Room records advance to v4 with a permanent old-writer fence; the private request
journal advances to `station.task-room-work-store/v4`. Older binaries reject
these formats; use matching server/client
versions when introducing attachment-bearing room records.

Local tests cover screenshot intake, recovery, SDK/HTTP storage across restart,
Task authority and neutral provider-adapter delivery. Browser, native shell and
actual-provider image understanding remain unverified.

## Independent room contributions

The contribution follow-up extends the existing room lifecycle owner to requests
whose session has the immutable SQLite room binding. The private lookup checks
the canonical Project, exact stored room Project identity and Task incarnation
before and after journal I/O. Publication authority derives the agent and
requesting owner from this binding and the journal rather than a browser-supplied
agent principal. The Task's lead agent and current session remain unchanged.

Startup recovery and an authorized request-list read reconcile start/finish facts
from the canonical Session projection. A journal row without the durable execution
binding publishes nothing. The request view rechecks its original Project, Task
incarnation and requester after its context read and before delivery; its
best-effort reconciliation is scheduled after the response. Session exit also
uses the immutable room binding to find independently requested work. Recovery
reconciles lifecycle history and agent presence; it never retries provider execution.

Local persistence tests at `9f8b407fa` exercised the real journal, SQLite binding
and room history; the old lifecycle implementation failed the independent-agent
case and the restored implementation passed. Scope-check repairs at `5a3d5b4e5`
have independent source review. Mounted controls at `97a988b2e` cover credential
revocation, Task replacement and same-slug Project replacement at final publication
authority. The pre-fix route leaked the request view in all three cases; removing
only the final canonical Project check committed a stale agent record. Restoring
the checks passed all 11 mounted principal-suite tests. These are local
implementation receipts, not shipped, browser or actual-provider proof.

Only the initial room-request turn and in-thread reply turns publish their answer text;
private dock follow-ups on a room-bound Session stay private. Their origin survives
restart through the canonical turn client identity and the private journal's admitted
reply operation IDs. Each admission stores a server-generated client turn ID scoped
to the request's Session; a client-supplied `room-reply:` prefix alone grants no
publication. The bounded admission list is omitted from browser request views. Each room agent request holds at most 256 reply admissions; once it is full,
further replies in that thread are refused.
Older binaries reject journal rows carrying this additive private field. These completed turns publish
their answer text through the existing agent-publish append path. The private principal binds the exact Session; the
envelope retains the turn ID. Browser history exposes that tuple and the
canonical run identity when available. Answer text over the room body limit is
shortened at a code-point boundary to the largest prefix fitting the UTF-8 string
and serialized body limits, with an explicit notice and an Open full run action.
One publication pass opens history at most once for all its pending answers. Publication
rechecks the immutable request binding, Task incarnation, Project and owner;
reconciliation repeats publication idempotently, never provider execution.

Conversation hides brief revision links and presence events; Details retains the raw
history. Owner history rebuilds display names and run identities from durable
principal, agent and Session sources. Guest history retains its anonymized
Participant/Agent labels and filters owner status and thread fragments.
Answers are clamped with Show more, and Keep remains disabled after confirmation.
The Conversation view groups replies to an agent answer by its Session. The thread replaces
the desktop rail and fills the room on narrow screens. A reply uses
`POST /api/orchestration/delegations/:sessionId/continue` with `taskRoomReply`
(Task identity, creation time and operation ID). The server verifies the exact
journal and execution binding before invoking the continuation. The human reply
is appended only after a successful continuation; a refused or failed send remains visibly Not delivered
in the thread with its draft retained. Existing continuation authority owns
provider effects. Unknown acknowledgements require full-run inspection instead
of an automatic resend. The operation ID remains stable for the same send.
The latest saved brief is attached by default; the thread checkbox can opt out.

The shared Task document is the canonical brief. The Overview summary parses the saved
document, or the Task description when the document is empty. Goal uses its named
section or prose before the first heading; later sections never become Goal.
Done when accepts plain bullets and numbered items as neutral criteria, alongside
checked and unchecked Markdown checkboxes. The Plan display renders Markdown and explicitly enters the same
live editor; edits autosave through the existing CRDT plan/batch protocol.

Current canonical lifecycle ends an agent's live presence after each completed
turn, including a follow-up on a Session with an older finish receipt. Terminal
turn errors also trigger room publication, so a failed stream produces a failure
line without another request. Codex's deferred retry errors remain in flight. The
private agent answer retains the exact Session, turn and canonical run identity.

The first recorded room request starts a todo/ready Task through an atomic
TaskGraph transition. Header and slash-command status changes use the existing
status route and its allowed transitions. Confirmed changes append quiet room
lines. Engine completion does not mark the Task done.

These publications are conversation contributions, not accepted results. Agent
document edits still use the lead Task/session association. Task memory is the exception: a recorded independent-request Session may also write its Task's summary and records through `task_summary_update` and `task_record`, authorized by the same immutable binding and re-checked in the write transaction (see [Tracker-backed Tasks](tracker-backed-tasks.md#write-authority)); it still cannot edit the document or Task status. Explicit shared brief context is implemented locally as described below. Personal
output previews and human review statements are implemented in the
[Task-room history contract](project-task-room-history.md); these local slices do
not complete agent result attribution, invited/public review or the accepted-work
journey. The
existing private room agent principal includes its requesting owner identity;
this history is not a public publication projection.

## Selected Task brief

This request snapshot is distinct from the dispatch Task brief of [Tracker-backed Tasks](tracker-backed-tasks.md), which a dispatched Session receives with its first turn and re-reads with `get_task_brief`.

Room dispatch captures the person's message separately from the composed model input.
Session and conversation headers, history lists, and new durable title indexes
use that captured label; the Station-agent chat store receives the same label.
Canonical prompts and the full Brief sent to the model remain intact. Existing
conversation reads prefer captured labels when available without rewriting history.

The request-list response advertises `station.task-room-context/v1` and returns
an authorized snapshot or `null` when a complete brief cannot be obtained.
The snapshot contains the Task title/description and shared document text/revision.
Its digest binds those values to canonical Project identity, Task identity and
Task incarnation. Capture rechecks authority, scope and Task metadata after
worker I/O; incomplete projections and metadata changes do not become a brief.

The composer refreshes the latest saved brief immediately before a fresh Send.
The attachment checkbox explicitly opts out. Connection or recipient changes
retire an in-flight preflight; unknown acknowledgements retain the exact saved
operation and context for retry. The agent receives readable markdown rather
than serialized snapshot JSON. The Plan tab autosaves through the existing
server edit-plan/batch protocol, keeps its draft mounted across tabs and retains
new typing while an older commit settles. In-app navigation flushes pending autosaves before committing its destination.
Failed or uncertain saves retain the draft in place. Co-editing plan rejection
refreshes and retries automatically at most three times; explicit retry remains
available after that bound. Browser close/reload retains beforeunload protection.

A context-bearing create sends only `{ version, digest }` beside its operation.
The server resolves that reference under the journal's mutation lock before
reserving a new execution, persists the bounded snapshot and passes its saved
bytes to delegation. It does not trust browser-supplied brief text. Stale or
unavailable context returns a pre-invocation context refusal. An existing
operation with matching intent replays its saved snapshot without rereading an
edited brief or invoking the provider. Context is part of intent and settlement
identity; a substituted valid snapshot cannot receive a successful settlement.

The public request/record protocol remains v1. The private journal promotes to
`station.task-room-work-store/v2` when the first snapshot is saved; newer servers
continue reading context-free v1 journals. Older servers fail closed on the new
private format, so downgrading after context use needs an explicit migration.
Requests with explicit engine, model, options or definition-fingerprint intent
promote the private journal to `station.task-room-work-store/v3`. The public
protocol remains v1. These fields join operation identity: a changed binding,
model or canonical options digest conflicts rather than reusing an old result.
Options are represented by their digest, not persisted raw values. New servers
read prior v1/v2 journals; old readers refuse v3 rather than dropping its intent.

A document over 16,000 characters produces a shortened snapshot with an explicit
notice in its markdown and composer preview. Room answers honor the existing
8,192-code-unit string bound and 16 KiB encoded-body bound, with a shortening
notice and a full-run action when needed. The four-MiB/256-request journal bound remains. Context is not provider authority or an accepted result.

Controlled transport, storage and mounted/UI tests cover retained context,
stale references, substituted snapshots, metadata edits and late refreshes.
Missing-check controls failed before their fixes. These transport checks do not
qualify browser geometry, a live model consuming the brief or the complete
invited/public journey. The local #3704 diagnostics below are a separate,
explicitly bounded evidence layer.

## Durable identity and uncertainty

The private key is `(Task, requesting principal, operation)`. Reusing it with a
different prompt or agent refuses. File-mutation authority serializes independent
module instances before any provider invocation. A stable execution identity is
reserved and passed to delegation; it remains in the work record after restart.

`starting` means the request is durable but execution is not confirmed. It does
not prove a process is alive. `dispatched` records the delegation return against
the reserved identity; it is not Task completion or customer acceptance.
`indeterminate` means delegation did not produce a trustworthy acknowledgement;
it can also retain a provider-effect refusal after delegation was entered.
`refused` means the earlier post-reservation authority check refused before
entering delegation. No stored row automatically
starts another execution. A settlement write failure remains an error rather
than a successful receipt, and lookup/replay does not invoke the provider.

Scope and requesting identity are rechecked after reservation and before result
delivery, and through a server-only admission beside the actual provider start
and initial-turn effect inside OrchestrationService. Task and Project incarnation
are included so a replacement cannot inherit a
prior request. The private admission also supplies the existing durable room
execution binding using the Task room's exact stored Project identity. This
preserves source-seal provider refusal and pending-execution joins without
changing the Task's current-session association. Lists distinguish refused access from an empty authorized history.
Corruption, excessive bytes, duplicate identities and capacity pressure fail
closed. The Station-wide `task-room-work.json` store retains at most 256 requests / 4 MiB and never silently
evicts them. Production retention/window protocols remain unfinished. This is
not an exactly-once guarantee against destroyed storage or archive rollback.

## Shared data

The private principal used for deduplication remains in the server store. The
authorized response projection (not anonymous publication) contains a Task-scoped display identity, requested agent, prompt, request
state and execution reference. The prompt is shared Task work; private engine
transcripts, credentials and account identifiers are not part of this view.
Execution references do not themselves grant another member Session access.
Curated results, approval routing and membership-aware contribution access must
be delivered before claiming the complete team journey.

## Composer

Typing `@` filters Project-scoped delegation choices by name, identifier and
role description. Arrow keys, Enter, Escape, pointer selection and IME
composition are supported. An **Ask an agent** action provides the same picker.
Selection creates one exact removable recipient and removes the typed lookup
fragment; entering text or picking a recipient starts no execution. Each
request currently names one agent; multiple agent requests retain independent
identities. Multi-recipient assignment remains unfinished.

Send refreshes readiness and negotiates the versioned journal route before
creating work. The composer binds draft ownership to connection authority and
Task incarnation. A changed connection cannot receive the old draft. A failed
preflight retains an editable draft; a lost create acknowledgement freezes the
intent and reuses its operation for an explicit retry. A later retry preflight
failure preserves the original uncertainty and operation. Ordinary message
writes use captured request authority and send the expected Task creation time;
the history grant rereads that incarnation and scope after principal resolution,
immediately before returning commit admission. A late response
cannot clear the draft after its captured authority expires. Unsaved navigation and
close guards protect local drafts. The composer saves bounded drafts and exact
uncertain operations in this browser tab's session storage. A reload offers
explicit restoration; it never sends, retries, or treats a missing receipt as
proof of failure. Agent retries preserve the original operation ID, recipient,
prompt and context digest. Room-message retries preserve proposal ID, text and
occurrence time; a new server-default timestamp would conflict with the original
proposal. Saved operations are written before dispatch, and storage refusal
prevents a new attempt. A refused retry leaves the original unknown operation
locked and saved; refusal of a new attempt does not establish that an earlier
attempt failed. Concurrent views compare their last saved snapshot before a
write or removal, so a stale composer cannot overwrite newer uncertain intent.
Explicit Discard removes only the local copy, not work
that may already be running. Cancel keeps the saved copy.

Recovery partitions include the saved Station connection, API origin, current
authorization generation, Project, Task ID and Task creation time, plus applicable
native/relay binding identities. The runtime-local page activation epoch is
excluded from that storage partition, but every send still uses current live
request authority. A restored recipient must still be available. Changed owners
cannot load or send another owner's draft. A late response from an unmounted or
retired owner cannot clear restored intent. Records are validated before restore;
malformed, unsupported or unavailable storage refuses recovery. The per-tab store
is bounded to 20 entries and 512,000 characters without evicting uncertain work.
Closing the tab ends that recovery lifetime. This is browser-local recovery;
real-model, shared/public and native-shell acceptance remain separate.

The room shows one inline status for each published running agent, with Watch
and Stop through the existing dock and interruption commands. Completed answers
and same-session thread replies remain in the room; no tool-step progress is
inferred from narration.

## Current evidence and remaining proof

The module tests use real file storage and two module instances. They cover
concurrent duplication/restart, conflicting intent, lost acknowledgement,
corruption and revocation before/after invocation. The HTTP test reaches the
actual delegation route and durable module, with a controlled dispatch adapter;
it checks Project mismatch refusal, one invocation, exact parent association,
replay and absence of account IDs in the response. A second HTTP test uses real
delegation and OrchestrationService with SQLite and a session-tracking controlled
provider: its positive control starts a session and sends a turn, then revocation
during target resolution blocks another start and revocation after start blocks
the initial turn. The current revocation fixture observes the exact durable
turn boundary in `reserved` state, before immutable intent capture and provider
invocation. Revocation there blocks the provider, retires the never-invoked
boundary and permits an explicit continuation once authority returns. Only a known authority change uses the
clean-refusal classification; storage failures retain their uncertainty.
It does not run a live model.

Local focused module/HTTP tests passed seven cases at `5d2d120e3`, with
independent execution and review. Removing clean refusal classification made
the real turn boundary remain active and failed the regression; restoring it
passed. The composer/client/route and existing Task view suite passed 58 cases
while the UI slice was in progress; SDK and UI typechecks passed after adding
the contract's real package export. These are controlled diagnostic receipts,
not final browser or release proof. Direct query-hook/HTTP tests and the real
room-runtime/history-worker suite passed 62 cases after covering readiness,
credential rotation, late acknowledgements and stale Task messages. A stronger
runtime control replaces the Task while the actual history write transaction
awaits principal resolution: it committed before the final reread fix and is
refused afterward, with the prior history unchanged. The full 58-case runtime
suite also preserves the existing not-found classification for moved transfer
rooms. The real
delegation test now verifies the persisted room-execution binding, pending-work
join and provider refusal after a real source seal. These remain controlled
principal/provider fixtures, not hosted or live-model acceptance.

Still required: final mutation controls and independent UI/SDK review;
runtime-composition authorization and browser proof; durable draft recovery;
actual-provider consumption of the selected brief and broader thread/reference context;
result artifacts and acceptance; multiple human principals, workspace conflict handling, remote
execution, public publication and actual provider/device acceptance.

## Local #3704 diagnostics (2026-10-15)

The room/session integration fixture uses the real EventStore, Session writer,
Task graph, room append path and delegation/continue commands. Its controlled
adapter advances Session timestamps like the real writer. The checks cover
canonical answer attribution to an exact Session/turn/run, bounded summaries,
same-Session continuation, thread records, status transition and revocation
before effects. Source mutations that remove those behaviors fail; restoring
the committed bytes restores green. These are local diagnostic checks.

The isolated `cd0080e2ac8` browser build used an explicitly labeled local ACP
process because the empty home had no authenticated live provider. Initial
answers, cold run opening in the dock, latest-brief attachment, Keep/Results,
Brief autosave, cancellation, title/status edits and dark/light/narrow layouts
were exercised. Cancellation produced a canonical `turn.aborted` event, a
`cancelled` room record and removal of the live agent. A prior `d894c593ddd`
walk returned a follow-up into the same thread.

The repeated latest-build follow-up completed its canonical turn but did not
publish the second answer: an approximately 5.2-second event-loop stall was
followed by HTTP 503 `Room unavailable` from history. A fresh home did not
eliminate this write-time failure. Latest-build end-to-end thread publication
is therefore **NOT_VERIFIED** pending investigation/integration with #3701's
storage lane. No history storage or worker internals were changed here. Live
provider, complete invited/public and native acceptance remain unverified.

## Fix-round implementation boundaries

Authorized history resolves human labels from the durable pairing registry and
Agent names and run identities from the Agent/Session owners. Shared guest history
keeps the pre-room anonymized Participant labels and excludes standalone status
and thread-reply fragments. Publication side-effect failures are logged and do
not turn an acknowledged dispatch or saved status into a client error. An answer
that cannot be published retains a blocked room line with Open full run. These
are local implementation contracts; rendered, live-provider and hosted evidence
remain separate receipts.

Details keeps identity and workspace fields in a disclosure. Basis opens on demand
from the kept-answer controls; it does not fetch or show a whole-Task error pane
before that action. Chromeless Basis omits the portable MCP App control. Keeping
a local file confirms it in Details; the Results count updates without changing
the active tab.

## Room polish behavior

The room and thread share Enter-to-send behavior with Shift+Enter for newlines
and IME composition preserved. Only the message scroller follows new messages;
readers above the newest message can jump back. Hidden presence facts do not
suppress the empty state. Failed run facts retain the original request and
same-Session retry, with the server's normal admission checks. Joining and
announcing are serialized with departure, including StrictMode remounts. The
server refreshes a viewer who is already published instead of refusing a repeat
announcement. Room dispatch carries the person's message as its display title;
the appended brief remains provider context. Guest history uses bounded pages
and continuation cursors instead of treating a second page as unavailable.
These are implementation claims; local checks, rendered fixtures, live-provider
acceptance and hosted qualification remain distinct evidence.

Expired viewer renewal settles the prior departure before minting replacement
presence handles. A legacy checkpoint with a retired departure handle may be
repaired only when an existing captured principal matches the original
announcement's retained history receipt, actor, Session and policy. Missing
history or a mismatched policy remains unavailable. Failed recovery is retryable
after its backing state changes; recovery never infers authority from a label.

## Draft acceptance diagnostics (2026-10-16)

The `eaabb0c266b` isolated production build fixes caller attribution on a room
follow-up: `continueDelegatedTask` retains the route's authenticated principal
and client origin. The existing route-to-runtime fixture fails without that
handoff. A rendered same-process follow-up on the Station-agent path now records
its admitted `room-reply` client turn ID and principal, then publishes the
subsequent agent answer into the same room thread. The deterministic upstream
is a local scripted model, not a real-provider qualification.

The acceptance run reproduced two blockers; green CI did not close them:

- Multi-chunk streaming can lose durable deltas during SQLite contention. A
  1,356-character response emitted in 32-character chunks produced only 1,292
  characters in canonical deltas and the room answer, alongside `Content delta
  could not be published: database is locked`. The terminal event retained all
  1,356 characters. An earlier complete run does not qualify this failure. The
  timer flush in `DeltaCoalescer` currently warns and drops failed text; unlike
  synchronous offer flushes, it does not retain retryable uncommitted content.
- Continuing the existing Session after a server restart is still refused with
  `Portable execution authority changed before forwarding.` The reply draft
  remains visible as Not delivered and no new turn is observed. The refusal came from shutdown closing the raw Session and continuation
  reserving a successor; the room correctly rejects that replacement.

These are local runtime observations, with raw event/history and build receipts
retained by the owning acceptance run. They establish neither native-device nor
public-sharing/provider acceptance. These observations kept the redesign in
draft until the corrections below were exercised through the rendered room.


## Acceptance corrections (2026-10-17)

`DeltaCoalescer` now retains timer-flushed text only when the runtime confirms a
retryable, uncommitted publication failure. It retries with the same event identity
and delivers that text before later events. Final disposal cancels all timers and
reports any remaining unpublished text as a shutdown failure; committed events
are not replayed. The regression suite covers timer recovery and turn-boundary
ordering, and a deliberate loss of rearming fails the timer case.

Shutdown parks idle, resumable room-bound Sessions through the existing lifecycle
lock before stopping their engines. Private native-output authority is revoked
first. Binding-read and recovery-disposal failures are collected while provider
cleanup and final delta disposal still run. A parked Session remains the exact
Session admitted by the room; active work, ended/replaced Sessions and engines
without a resume cursor keep their existing semantics. The restart regression
also refuses a reply when authority is revoked.

History paging waits for an in-progress query refresh to settle and never cancels
it to fetch the next page. This lets a reloaded room reach its newest checkpoint
before older messages are revealed locally.

The isolated production fixture used a local scripted model emitting 1,356
characters in 32-character chunks. A synchronized 6.3-second SQLite write lock
exceeded the five-second busy bound and produced the expected publication
warning. After recovery, canonical deltas and terminal output retained identical
text (SHA-256 `6f9c55a052401a16999a8a54a8c22a71deceaefb6a3893a7f868e388d81a9897`).
A real server shutdown and restart preserved the same raw room Session; its
rendered follow-up retained the same complete answer, authenticated principal,
and admitted client-turn identity. The final shutdown-review corrections are
verified separately against their new regression controls.

Desktop and 390px phone layouts were inspected in both themes, including Chat,
thread reply, Brief and kept Results. The fixture home uses its canonical path:
its earlier symlinked path correctly failed the answer-support ownership guard.
These results qualify the controlled local room journey. They do not establish
real-provider, native-device, public-sharing or installed-release behavior.


## Room action hierarchy and draft ownership

Overview is the default Task view and includes kept deliverables. Conversation
holds the shared discussion, Plan holds the shared document, Work chats links
separately authorized conversations, and Details holds identity and execution
inspection. Opening an
agent thread replaces its navigation button with answer-local Keep and run
inspection actions. Every answer in that thread can be kept, including its first
answer. The composer keeps one visible message prompt and an accessible label.

A selected person mention remains an ordinary room message, including full names,
agent-name collisions and newlines after the mention. Selecting an agent remains
an explicit execution request. Removing or editing the selected human prefix
returns subsequent input to the ordinary typed-mention rules.

Cancel preserves a thread draft. Confirmed Discard clears its text, operation
identity and delivery notice before another thread can open. A pending reply
holds its thread until acknowledgement settles, so its result cannot clear or
report status in another agent's thread. Results exposes Retry for failed reads
without removing results that are still available.

Focused regressions cover these boundaries with the real discard guard and
controlled request settlement; reverting the owners reproduces the failures.
Browser verification uses the isolated local scripted-provider fixture. These
claims do not extend provider, native-device or release qualification.
