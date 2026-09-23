# Issue class prevention

**Status:** active execution plan, 2026-09-23. The scoped governance routes
are implemented; the broader runtime, browser, platform, and resource exit
checks below remain open. GitHub issues own live priority and delivery state.
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
affected files at `Require` level. For a changed named file, `evidenceCheckIds`
selects the corresponding focused suite in the same readiness run. Missing,
skipped, failed, or unbound results block. `gate:for` presents matching
`explain` guidance before edits. The Veritas Governance Kit declares a Codex
`PreToolUse` hook; Flow Agents provisions it through Conduit, preserving other
handlers and recording the installed bytes. Codex must trust the project hook
before it executes. The first matching edit in a host session gets full
guidance; repeat edits with the same path guidance and policy hashes still run
the decision but do not repeat the prose. A missing session ID or cache error
repeats the briefing. Hook delivery cannot prove that an agent followed the
guidance, and tools outside the host's hook coverage still require post-change
readiness. These checks prove their named tests ran and passed, not every
behavior suggested by the rule text. Other behavioral gates remain `npm run test:focused -- <selected files>`,
`npm run test:connected-agents`, relevant browser journeys, and `npm run
ci:fast`, followed by the hosted completion gate when a promotion requires it.
Use `npm run gate:for -- <paths>` to select the lane. Further expansion of the
blocking scope needs catch evidence under
[the proof-family promotion workflow](../strategy/veritas/proof-family-promotion-workflow.md).

### Catch evidence for the scoped rules

At base revision `cba7bc608`, the session boundary and operational delivery
tests passed (44 tests across two files). Replacing the rejected provider
start's `indeterminate` transition with `started` made the previous session
suite stay green. A new restart/replay test caught the unsafe transition
(one failing assertion out of 20 tests); restoring production code returned
all 20 to green. Changing the delivery attempt ceiling from five to one made
four of 25 delivery tests fail; restoring it returned all 25 to green. These
mutations prove the focused commands catch those representative regressions.
They do not establish long-duration memory bounds, physical-device behavior,
or every provider adapter's lifecycle.

### Route contract and installation evidence

The Repo Map schema names routed graph nodes with `nodeIds`. Veritas runtime
must use that same field to select checks; the Station Repo Map test calls the
published routing function and fails if a changed server file no longer selects
`connected-agents`. Legacy `componentIds` remains a compatibility input in
Veritas, but new Repo Maps use the schema field. This runtime and schema
agreement is separate from the rule-linked required Evidence Checks above.

Structured `explain --json`, the Codex and Claude pre-edit hooks, and
rule-linked Evidence Checks live in Veritas. Flow Agents owns Kit activation
and provisioning; Conduit owns host capability and installation receipts.
An installed hook config proves only the projected bytes. A host trust review
and a real hook invocation are separate observations. The independent
`veritas readiness` gate catches changes made through uncovered tools or
sessions that never ran a pre-edit hook.

On this branch, Flow Agents 6.3.0 installed the Veritas v1.7.2 Governance Kit
from its Git tag and provisioned `.codex/hooks.json` through Conduit 0.7.1.
The tracked config has one Veritas `PreToolUse` command; a repeated provision
kept one command and the same receipt digest
`sha256:0b4b8164d668905f799f658696343d1b34bf7570a81a336165eab50770443bb8`.
An installed-command probe returned 2,269 guidance characters on the first
matching edit and zero on a repeat while evaluating both edits; a pathless
patch was denied. Station declares no strict Work Area boundary, so an
untrusted actor's otherwise valid edit was advisory rather than denied.
Normal Codex project-hook trust and UI status-message noise remain
`NOT_VERIFIED` until the host's hook review and live invocation are observed.
