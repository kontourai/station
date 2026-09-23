# Issue class prevention

**Status:** proposed execution plan, 2026-09-22. The named modules and tests are
current at this revision; GitHub issues own live priority and delivery state.
This plan does not claim that an existing test proves a desktop, mobile, or
provider behavior it does not execute.

## Why this plan exists

Reports across agent workspaces repeatedly involve the same boundaries: a
session that cannot stop or resume, a client that loses an event after reconnect,
work that retries forever or grows without limit, environment differences that
break an otherwise healthy provider, and a control whose visible state disagrees
with the underlying operation. Station has owners for many of these boundaries,
but a local change can still miss a sibling entry point or the user journey.

## Current Station controls and remaining risks

| Failure class | Existing owner and evidence | Remaining proof to add |
| --- | --- | --- |
| Stop, replace, resume, and late provider outcomes | `SessionLifecycleModule`, `SessionTurnBoundaryAuthority`, `ConversationSessionLineage`; their direct tests and connected agent lane | One table driven integration suite through canonical command, EventStore, and route for Stop during preparation, accepted late result, provider crash, replacement, and restart. Assert the same outcome after reconnect. Track current #2324 and #2303. |
| Event and UI state drift | Session query projection, operational event delivery, outbound dispatch, SSE client | Browser journey that drops and restores the stream while a child Session runs, then checks working state, Stop, event order, and recovery without reload. Track #2301 and #2303. |
| Resource growth and futile retries | Bounded operational delivery, outbound queue, large EventStore projection test, turn stall watchdog | Profile a large history and a slow client; fault inject permanent and transient failures; assert queue, bytes, child count, disk use, retry interval, and shutdown cleanup against declared ceilings. Establish a baseline before choosing numbers. |
| Platform and provider compatibility | Connected agent contract, route, and browser tests; desktop and mobile build gates | For each changed adapter or native bridge, test path discovery, startup, auth, and recovery on the platforms it claims. Use packaged shell/device proof for claims that depend on the shell; keep missing platforms `NOT_VERIFIED`. |
| Visible interaction and accessibility | Product laws, focused components, mobile browser journeys | Exercise error, pending, empty, long text, keyboard, IME, and narrow viewport states with ordinary user actions. Check that an action reaches its owning operation and reports refusal. |
| Security and durable data boundaries | Exact scoped authorization, revisioned storage, event receipts | For each new read or mutation path, pair an allowed control with a cross-scope refusal, corrupt or stale input, and post-commit uncertainty. Do not infer that a successful UI render proves authorization or durable persistence. |

## Execution order

1. **Lifecycle and reconnect, P1.** Reconcile #2301, #2303, and #2324 with
   in-flight branches and claim ownership. Add a controlled provider fixture
   that can pause before invocation, accept then delay a result, crash, and
   resume. Pin durable command and route outcomes before changing behavior.
   The exit check is one command history and one UI state after restart and
   reconnect for each transition, with no duplicate provider effect.
2. **Resource bounds, P1.** Inventory background queues, polling, provider
   monitors, Git operations, and process children from their actual callers.
   Record size, concurrency, retry, retention, and cleanup limits. Profile the
   worst observed path, then add a failure and slow-consumer regression at the
   owning seam. The exit check is bounded resource use plus a visible failure
   state under a permanent fault; a transient fault must recover.
3. **Platform and interaction matrix, P2.** For each changed provider/native
   path, select the impacted OS and device journeys. Add real startup and
   capability checks before claiming parity. For changed controls, test
   keyboard, IME, error, and 320/390/412 px layouts against the affected
   product law. The exit check is a revision-bound receipt that separates
   `CONFIRMED`, `FAIL`, and `NOT_VERIFIED` per platform.
4. **Repeatable intake, P2.** At issue triage, classify the observed failure
   by boundary and link its owning module, reproducer, and nearest existing
   test. Before closing a fix, search sibling adapters and entry points, add
   a regression that fails on the old behavior, and record any newly exposed
   gap as an issue. Promote advisory governance only after a real catch and
   low-noise evidence under the Veritas proof-family workflow.

## Governance and evidence

Veritas rules `session-lifecycle-recovery-contract` and
`bounded-background-work-contract` route the two highest-risk reviews to
affected files at `Guide` level. They check artifact presence and provide
just-in-time instructions **when `veritas explain` is run**. Neither Veritas nor
`gate:for` currently forces that command. A content edit to a still-present
module can pass both rules without executing a behavioral test; these rules
**do not** prove the behavior. The behavioral
gates remain `npm run test:focused -- <selected files>`,
`npm run test:connected-agents`, relevant browser journeys, and `npm run
ci:fast`, followed by the hosted completion gate when a promotion requires it.
Use `npm run gate:for -- <paths>` to select the lane. Do not promote either
rule to `Require` until a deletion catch or other direct rule catch justifies
the exact blocking semantics; see
[the proof-family promotion workflow](../strategy/veritas/proof-family-promotion-workflow.md).

### Veritas contract improvement to pursue upstream

The current Repo Standards schema binds `required-artifacts` to existence,
while the Repo Map routes evidence checks by broad work area. This leaves no
declarative way for a rule to say, "when this source path changes, this named
behavioral check must execute at this revision and prove this claim." Propose
an opt-in rule-to-evidence link with these semantics:

Veritas has a Claude Code `PreToolUse` policy hook, but its allowed-edit result
does not present matching `explain` guidance. The current Codex integration
has Stop/session feedback hooks and no `PreToolUse` hook. Station has neither
runtime hook installed. Flow Agents defines an optional governance adapter;
its contract delegates rule meaning to Veritas but does not require a path
briefing before edits. Make the path briefing a Veritas-owned product contract
that those runtimes can consume, rather than duplicating rule selection in
each agent pack.

1. A rule declares path scope, claim scope, and one or more existing
   `evidenceCheckIds`. Veritas validates that every referenced check exists and
   is reachable for each changed path; an unreachable or skipped check is a
   visible `NOT_VERIFIED` result, never a `PASS`.
2. Readiness binds each check receipt to the exact source revision, command,
   test selection, and outcome. A passing unrelated suite or an older receipt
   cannot satisfy the rule. `Guide` reports a gap; `Require` blocks only after
   catch evidence and owner approval.
3. A pre-edit runtime hook or task-admission adapter requests a machine-readable
   `explain` result for the exact intended paths and presents the matching
   `mustDo` guidance. A command or patch with unknown paths must first declare
   its scope. The result includes rule ID and standards hash; a missing hook is
   reported as an integration gap. `veritas explain` remains the detailed view.
   A guidance receipt must not masquerade as test evidence.
4. Prove the contract with one known-bad mutation that the selected test
   catches, plus a negative control showing that an unrelated change does not
   run the expensive check. Start with the session transition matrix above.
