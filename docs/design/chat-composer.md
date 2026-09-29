# Design: Chat composer & the agent-navigability principle

> **Reading status: interaction policy with dated design evidence.** Section 2
> records the 2026-07-26 audit; the sequencing and shipped-status statements
> belong to their recorded work. Section 4 below describes the current public
> HTTP entry points. Current control rendering and sending are owned by
> [ChatDockBody](../../src-ui/src/components/chat-dock/ChatDockBody.tsx) and
> [foreground dispatch](../../src-ui/src/lib/foregroundMessageDispatch.ts).
> The mobile product decisions remain binding; this document is not a fresh
> browser, accessibility, or native-device test result.

> Status: **composer hierarchy, the provider/model picker, prerequisite
> guidance, shortcuts, and final Settings polish shipped through #1354.**
> This is the contract for the chat composer/dock and for the principle it
> enforces. Revise this doc — not just the code — when direction changes.

## Interaction stability and conversation continuity

Every conversation uses the chat dock's reading surface and header, including
conversations discovered in another coding app. A quiet "Started in Claude Code"
(or the observed app name) identifies origin. Discovery is not evidence of running
work; history uses source-event time and remains separate from active work.

Opening a conversation or typing does not migrate it. The composer accepts a
normal draft. Send (or Enter, except during IME composition) opens a one-time
"Continue here?" confirmation; Cancel preserves the draft and Shift+Enter adds a
line. Confirmation opens the continuation through the normal dock controller
and hands the exact draft to the normal sender once. The original conversation
remains available in its original app. A failed opening retains the reader and offers a
retry that does not create another continuation. Metadata is available through
an explicit Details action.

Message action rows reserve their layout space. Hover and keyboard focus may
reveal controls, but must not change bubble size or the position of later messages.
During an authorized active-turn continuation wait, the composer accepts and
preserves a draft. Sending and queueing stay blocked until continuation is writable.
The shared popover shell opens toward the roomier viewport edge, including when
the dock is maximized. A narrow Activity region shows its list or its selected
detail, with a Back to list control, instead of squeezing both columns.

## 1. The principle: if an agent can't drive it, it's broken

Station's thesis is agents doing real work with receipts. That obligates Station's own UI
to be **agent-navigable**: every action a human can take in the composer must be equally
available to an agent, a script, and assistive technology. Navigability failures during
the 2026-07-26 MCP-passthrough spike are the motivating evidence — each one is an
architecture signal, not automation flakiness:

- **Pointer interception:** the session model menu rendered with unrelated layers
  (task-panel empty state, task input) intercepting its clicks. The repo's own e2e suite
  works around this class with a `forceClickRole` synthetic-dispatch helper — when the
  tests can't click the buttons, humans are getting marginal hit targets too.
- **No API parity (discoverability):** programmatic chat must accept the same persisted
  Agent identity the picker exposes and enter the same binding-based orchestration
  path. Capability that only the UI can reach is invisible to agents, automation, and
  the scheduler.
- **Missing semantics:** the model/connection selector is text, not a labeled control —
  reachable only by fuzzy text match, invisible to `getByRole` and screen readers.

Enforcement posture: the existing a11y ratchet (counts only decrease) plus the repo rule
that Playwright specs use role-based selectors. A new spec that needs `forceClickRole` or
a text-match against an interactive control is treating a defect as a convention — fix
the control instead.

## 2. Current-state audit (chat dock, 2026-07-26)

The composer row carries, at roughly equal visual weight: Delegate, Commands, Files,
Task-context buttons; attach; mic; Send; a model/connection selector rendered as three
lines of small text ("OpenCode · OpenCode Zen/Big Pickle", "runtime", "Connection
default"); a context-percent meter; plus the session tab strip above. Problems:

- No hierarchy: the input competes with eight peer affordances.
- The model selector is the highest-consequence control (spike: the default selection was
  an unauthenticated provider while an authenticated one existed) and the least legible.
- Vocabulary leak: the selector surfaces internal words ("runtime") banned from
  user-facing strings.
- Agent identity is ambiguous where sessions/agents render (two entries named "OpenCode":
  the engine-managed external agent and the ACP-connected one).

## 3. Target composer

1. **Input primary.** The textarea is the visually dominant element; everything else is
   secondary chrome.
2. **One grouped secondary-actions affordance.** Delegate / Commands / Files /
   Task-context collapse into a single "+" (or overflow) menu next to attach + mic;
   Send stays a labeled primary button. Every item: real `button` role, accessible name,
   44px target (the ResponsiveDialogSurface/actions floor already owns this on mobile).
3. **Model/connection selector is a value-only dialog button.** Its accessible name names Model and the active Provider/model;
   popover on the dialog-surface layer (no interception); shows model + connection with
   auth state; glossary vocabulary only. Default selection must prefer an
   *authenticated* provider when one exists (spike finding).
4. **Agent-type badges — superseded.** This item is superseded by
   `agent-engine-unification.md` §8.1: every resolved agent gets one **engine chip**
   naming its engine ("Station", "Claude Code", "OpenCode · GLM-4.7") instead of an
   External/ACP badge pair; "External" and "ACP" never render. Shipped in #894. The
   navigability principle (§1) and the §4 API-parity table remain binding as written.
5. **Context meter and session chrome** move to the session header/tab area, out of the
   input row.

### 3.1 Provider and model picker

- Agent and Model selectors show their selected values without repeating the field labels.
  Their accessible names and tooltips retain the field name, exact Provider/model identity,
  selection source, and any unavailable reason. The picker distinguishes duplicate model
  names by Provider identity. Compact neutral controls use clear hover/focus states and
  preserve the 44px mobile touch floor.
- Search spans all ready Providers. A compact rail exposes Favorites, All, and
  each Provider without teaching internal connection categories.
- Unavailable Providers explain their status and are disabled. They can never
  create a new invalid chat selection.
- Favorites, recents, hidden models, and explicit order use one versioned
  device-settings record. Provider details own favorite/hide/reorder controls;
  the picker consumes the same record.
- Compact value pickers use the shared `.choice-trigger` / `.choice-caret` styles
  and `ArrowDownGlyph`, also used by the layout switcher and scheduler agent picker.
  Standard actions continue to use `Button`.
- Agent, Model, and approval mode share control geometry and chevrons. Values size
  naturally and truncate when needed; Model does not stretch into unused space.
- The capsule owns one textarea focus ring. Keyboard-focused toolbar controls retain
  their individual focus indicator.
- Drafts and the labeled Clear action belong in the secondary action row, leaving
  the textarea its full width. Clear appears only when there is text.
- Model controls render only when the Provider reports support. A named reset
  restores the original default Provider and model for the chat.
- Station-managed chats may switch Model Providers. Externally managed agent
  chats remain bound to their engine so resume semantics stay intact.
- An ACP engine applies a model only when its session starts, so Model stays
  closed on an ACP conversation that has run a turn. In the chat dock, a
  conversation that has never run one (a Draft, or one whose only sends were
  refused or failed) keeps Model open. The next send starts a successor session with the chosen
  model, and there is no engine history to carry over.

### 3.2 Attachments

- The composer decides image support before Send from the engine's declared
  and observed answers (`resolveComposerImageSupport`). When images cannot be
  sent, image chips say so and Send is disabled with the reason until the
  images are removed. When nothing can be attached, tapping the paperclip
  shows the reason instead of opening a file picker, so a touch user sees it
  too.
- When support is not confirmed (an ACP engine that has not reported its
  answer yet, or one that accepts images while the selected model's support is
  unknown), attaching an image shows a non-blocking note below the draft.
- Each chip shows one short status that names what happened, such as
  **Upload expired** or **Upload didn't finish**, and its action (**Upload
  again**, **Retry**, **Remove**). Validation messages flow below the draft
  instead of covering it.
- A send the engine refuses because of its attachments
  (`attachment_input_unsupported`) is shown as one chat error with **Remove
  attachments** instead of Retry, because the same send would be refused
  again. On a conversation whose sends never took, the session failure banner
  defers to that error instead of repeating it.

## 4. API parity contract

Composer sends use the canonical foreground execution surface. The internal
orchestration command union is broader than the public `/commands` schema:
`startSession` and `sendTurn` are not accepted public HTTP commands.

| Composer action | Programmatic surface |
| --- | --- |
| Start/send through an authored Agent, including an external-engine binding | `POST /api/orchestration/chat` with `target` and `message` |
| Continue an existing conversation | `POST /api/orchestration/chat/:conversationId/continue` with `message`; the persisted binding owns execution identity |
| Request model/options for a turn | `target.model.override` / `target.model.options` on `/chat`, or a `model` object on `/continue`; support is engine-specific |
| Respond to permission request | `POST /api/orchestration/commands` with `type:'respondToRequest'`, `threadId`, `requestId`, and `decision` |

The [Session API](../reference/session-api.md) owns request details and refusal
behavior. `POST /api/agents/:id/chat` is the Station-engine route; an
external-engine binding receives HTTP 409 with orchestration guidance, not a
forwarded request. The [public schemas](../../src-server/routes/orchestration/orchestration.ts)
and [per-Agent route](../../src-server/routes/chat/chat.ts) enforce this distinction.
The original slice's proof standard—a scripted nonce round-trip using only
documented endpoints—is retained as an acceptance criterion, not a new live result.

## 5. Sequencing

Owner-directed API-first: session-api parity slice → detection/back-end slices → this
composer overhaul + badges land together in the final UI-confirm pass, verified live
with role-based Playwright selectors (no forceClickRole in the new specs) and
screenshots.

## Mobile conversation focus (2026-09-05)

Owner-directed revision (clarified 2026-09-05): project switching and
conversation switching are primary phone-header actions. Both stay directly
reachable with readable current context and 44px touch targets at 320px,
390px, and 412px widths. Neither requires opening Chat actions first.
New chat, Activity, connection management, and dock sizing remain explicit
actions in Chat actions. The collapsed dock also keeps a direct Expand chat control. No
resize or navigation action requires a gesture.

Mobile message rows prioritize the authored text and essential live approval or
error state. A separate 44px actions button opens attribution, model facts,
provenance, copy, ratings, and Task references on demand. These details retain
their original event-backed identities. Desktop attribution stays inline.

The executable contracts are `ChatDockMobileHeader.test.tsx` and the mobile
project-switcher journey in `tests/cross-runtime-chat-switching.spec.ts`.
Changing or removing these primary actions requires an explicit product-contract
change; a fixed button count is not the acceptance criterion. The required
pre-merge browser smoke must exercise the journey rather than wait for Nightly.

An indeterminate wait may show elapsed observation time, clearly identified as time waiting in this view. It must not invent a completion estimate. Access requests with a persisted expiry show a countdown from that expiry; the clock itself is not a live-region announcement.

Discovered Codex rollouts continue through app-server `thread/fork`, returning a distinct native child ID. Cleanup archives the confirmed child. This is separate from resuming an existing Station-owned Codex session, which uses `thread/resume`.
