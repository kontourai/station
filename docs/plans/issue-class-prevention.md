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
affected files at `Require` level. For a changed named file, `evidenceCheckIds`
selects the corresponding focused suite in the same readiness run. Missing,
skipped, failed, or unbound results block. `gate:for` presents matching
`explain` guidance before edits; the installed Claude Code hook does so for
path-bearing edit tools. Codex has no native PreToolUse hook, and no tool can
prove that an agent read or followed guidance. These checks prove their named
tests ran and passed, not every behavior suggested by the rule text. Other
behavioral gates remain `npm run test:focused -- <selected files>`,
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

### Veritas contract improvement to pursue upstream

The current Repo Standards schema binds `required-artifacts` to existence,
while the Repo Map routes evidence checks by broad work area. This leaves no
declarative way for a rule to say, "when this source path changes, this named
behavioral check must execute at this revision and prove this claim." Propose
an opt-in rule-to-evidence link with these semantics:

Veritas 1.7.0 has a Claude Code `PreToolUse` policy hook that presents matching
`explain` guidance. The current Codex integration
has Stop/session feedback hooks and no `PreToolUse` hook. Station has neither
runtime hook installed. Flow Agents defines an optional governance adapter;
its contract delegates rule meaning to Veritas but does not require a path
briefing before edits. The path briefing and rule-linked Evidence Check
selection now live in Veritas rather than being duplicated in each agent pack.

The first three contract pieces are implemented upstream: structured
`explain --json`, matching guidance through the installed Claude Code edit
hook, and `evidenceCheckIds` whose selected check is bound to the current
readiness run. The Veritas test suite proves a baseline pass, injected failure,
restored pass, skipped-check refusal, and unrelated-path negative control.
Remaining product work is a native pre-edit hook for Codex and an explicit
Flow Agents task-admission adapter that invokes the structured briefing.
Until those runtimes expose and install those seams, the Station `gate:for`
route is the required pre-edit briefing for this repository.
