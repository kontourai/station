# Verified replay of Agent browser actions

> **Status: Proposal — not implemented, unscheduled; no tracking issue as of
> 2026-11-02.** Station cannot save an Agent's action sequence or replay one
> today. Sentences that describe current behavior link to its owner. Everything
> else is proposed. The current authority model belongs to the
> [Browser Agent actions decision](../decisions/browser-agent-actions-and-bound-channel.md),
> the [device Agent control decision](../decisions/device-agent-control.md), the
> [Browser workspace guide](../guides/browser-workspace.md) and the
> [Device workspace guide](../guides/mobile-device-workspace.md). This record
> does not change them.

## Problem

An Agent drives the Station browser one tool call at a time, and each call
costs a model turn. A Session that repeats a known flow, such as signing in to a
local app, opening a settings view or filling in a setup form, spends that model
time on every run, and its path can differ from run to run.

The open-source [e2e framework](https://github.com/tester-army/e2e)
(Apache-2.0) saves the actions of a verified `agent.act(goal)` step and later
replays them without a model. If replay stops matching the screen, it hands the
rest of the step to the agent. Its [cache](https://e2e.tester.army/docs/cache.md)
and [self-healing](https://e2e.tester.army/docs/self-healing.md) pages
describe the behavior. In one pilot run against Station, replaying a one-action
step took about 0.4 s, compared with about 6 s live. That figure comes from one
run of an external tool. It is not a Station measurement.

Two properties of that design matter more here than its speed:

- **It records only verified steps.** A step's actions are saved only after a
  later check passes. Assertions, waits and extractions always run live.
- **It refuses to claim an outcome it cannot attribute.** In the pilot, replay
  stopped with `end-mismatch`: every recorded action ran, but the recorded
  outcome was already showing on `/settings?view=appearance` before replay
  acted there. Nothing showed that the replay had produced it.

The pilot also showed two weaknesses. Replay depends on server state that
earlier runs leave behind. And a step phrased as a goal passes without doing
anything when the goal is already true: "switch to dark mode" passed with no
action because Station starts in dark mode.

## What Station has today

These are current behaviors that a replay would depend on or would have to
respect. Source inspection supports them, as cited. None of them saves or
replays a sequence.

- **Semantic locators.** Browser target tools accept a snapshot `ref`, a
  Playwright-style `locator` (for example `role=button[name="Save"]`) or a
  CSS-pixel point ([target schema](../../src-server/tools/station-control-browser-tools.ts)).
  [BrowserAutomation](../../src-server/services/browser/browser-automation.ts)
  resolves locators in an isolated world and hit-tests clicks, refusing
  `obscured`.
- **Refs do not last.** A human takeover expires snapshot refs. A snapshot
  taken without a bound lease, or one that overlaps a human hold, returns no
  usable refs ([guide](../guides/browser-workspace.md#agent-authority-and-human-input)).
  A recording therefore cannot store a ref.
- **Action history is not a recording.** History is capped at 200 entries
  (`BROWSER_SESSION_HISTORY_LIMIT` in the
  [session registry](../../src-server/services/browser/browser-session-registry.ts)).
  It records typed text, single printable key presses and scripts by size only,
  and records a select's method and text length rather than its value. List
  and summary URLs drop the query and fragment. That posture is deliberate,
  and this proposal keeps it.
- **Secret bindings.** Station stores metadata-only secret bindings with exact,
  typed grants: MCP integration environment, OAuth client, ACP provider header
  and telemetry destination ([contract](../../packages/contracts/src/secret-binding.ts)).
  No grant kind authorizes typing a secret into a page.
- **Device input is coordinate-based.** `device_input` sends pointer, text and
  key batches. `device_snapshot` reads a bounded accessibility tree, but input
  does not target elements. An accepted write proves only that the hub socket
  accepted bytes ([Device guide](../guides/mobile-device-workspace.md#view-control-and-end-a-session)).
- **"Replay" already means something else.** [Session tape replay](session-tape-replay.md)
  re-folds recorded chat events into a read-only view and runs no actions. The
  glossary calls that view **History**. Task captures, Browser
  [Task clips](walkthroughs.md) and Device `device_record_to_task` clips are
  video or image evidence, not executable steps.

Two existing rules already constrain any replay. The
[capabilities proposal](agent-interaction-capabilities.md#backend-resolution)
says not to replay a click, form submission or keystroke on another backend
after an uncertain result. The [Automations ledger](automations.md#6-dedup-and-episodes)
never replays an invocation whose result is unknown.

## Proposal

### Terms

An **action recording** is a saved, verified sequence of browser actions for
one goal. **Replay** means running a recording. Product copy needs a name that
does not collide with History replay; see [open questions](#open-questions).

### A bound Session runs every replay

Here, "without a model" means one model turn for the whole sequence rather than
one turn per action. It does not mean running without a caller. The decision
record's authority chain starts with a verified, bound Session owner, its
canonical Project, current operator/admin standing and the exact profile grant.
A replay outside a Session would need a new principal kind, so that is out of
scope here.

Replay would be a station-browser tool (working name `browser_replay`) that a
bound Session calls with a recording identifier. It is a sequencer over the
existing operations, not a second executor:

- Each replayed action calls the same BrowserAutomation operation a live tool
  call uses. That operation repeats the authority checks, selects the profile,
  runs through `withLive`/`withControl` and the captured fence, refuses
  `obscured`, and refuses `dialog-open` while a person's dialog is held. Each
  action writes its own history entry with the Agent as the actor and the
  values recorded by size only.
- Replay takes no special lease. A human takeover advances the fence and stops
  replay as it stops a live action. Replay never resumes after hand-back.
- Replay is a sensitive station-browser tool and follows the existing approval
  posture. The prompt shows the recording's actions: target descriptions,
  origins and value kinds, but not literal or secret values. Under the current
  rules, **Allow the Station browser for this session** would cover replay like
  any other station-browser tool. Whether one approval should authorize N
  effects is an [open question](#open-questions).
- A recording runs only on the Station browser in the caller's own profile. It
  never moves to another backend.

### What may be recorded

The first slice admits `browser_navigate`, `browser_click`, `browser_hover`,
`browser_select`, `browser_type` and `browser_press`. Any other operation in a
step makes that step a **gap**, and gaps are not recorded. That includes
`browser_evaluate`, drag, scroll by point, upload, dialog handling, popups and
color-scheme emulation.

A step is recorded only when all of the following hold:

1. **Every target is semantic.** It must be a locator, or a ref that Station
   resolved at action time to a role, accessible name and enclosing landmark
   (or another stable container). Point targets are gaps.
2. **A check passed afterwards, and the acting Agent did not choose it after
   the fact.** Station has no test runner. Candidates are a condition named by
   the request (a person's instruction or a Task's definition) and checked with
   `browser_wait_for`, or a person's confirmation. The Agent's own report of
   success does not count; the guide already warns against treating a tool
   response or screenshot as independent verification. Which signal counts is
   the main [open question](#open-questions).
3. **The live run observed a change.** At least one recorded end condition (a
   path change, an element appearing or an element disappearing) must have
   been false before the step and true after it. A step that changed nothing,
   such as "switch to dark mode" when the page is already dark, is not
   recorded and runs live every time.
4. **No action had an uncertain result.** A timeout, interruption, refusal or
   human takeover during the step prevents recording.
5. **Values are allowed and within bounds.** See [secrets and values](#secrets-and-values).

An entry stores the start origin and path, each action with its target
description and the source of its value (literal or secret handle), the end
path, end anchors (elements that must be present afterwards), gone anchors
(elements that must be absent afterwards), the schema version, provenance
(Session, Agent and principal) and a reference to the check that passed. It
stores no prompts, transcript, screenshots, snapshots or page text beyond the
target descriptions. Bounds on actions, bytes, anchors and value length are to
be decided. The e2e framework uses 50 actions, 1 MiB per entry, 8 anchors of
each kind and 4,096 characters per value; those numbers are a reference, not a
decision.

### Where recordings live and their scope

Recordings would live under `<STATION_HOME>`, outside Project roots (as Task
captures do), in an owner-only store. They are keyed by:

- canonical Project ID and principal: the same pair that keys a
  [browser profile](../guides/browser-workspace.md#profiles-and-network-reach);
- Agent;
- target origin;
- a digest of the goal and a digest of its parameters;
- an optional step name from the caller, used when one goal repeats within a
  flow. The e2e key uses a call index here; a position within one Session
  would never match in a later Session.

| Scope | Proposal |
| --- | --- |
| Session only | No. The recording would end with the Session it was meant to help. |
| Project + principal + Agent | Default. A recording reflects one profile's signed-in state and may hold that principal's literal values. |
| Shared across principals or Agents in a Project | Not in the first slice. See [open questions](#open-questions). |
| Committed to a repository | No. The e2e default stores entries in the project tree with typed values verbatim, which is a disclosure risk in a public repository. |

The owning principal and the operator can list and delete recordings; the
operator can already reach every profile's sessions. A Project admin sees only
their own.

### How replay runs

1. **Start state.** The browser session must be live, in the caller's
   authorized profile, at the recorded origin and start path. Otherwise replay
   stops before acting (`wrong-context`), and the call returns a miss.
2. **Resolve each target fresh.** Each target is resolved by its description
   with a bounded wait. No match stops replay with `target-not-found`; more than
   one stops it with `target-ambiguous`. Replay never acts on the nearest
   similar element.
3. **Act through the normal operation.** A refusal (`obscured`,
   `human-controlling`, `dialog-open`, `not-selectable` and so on) stops replay
   with that reason. A timeout or interruption stops it with `action-uncertain`.
   Replay never retries an action whose effect is unknown.
4. **End check.** The end path must match, every end anchor must be present
   and every gone anchor absent.
5. **Outcome attribution.** Replay reports success only if at least one
   recorded end condition was observed false before replay acted and true
   afterwards. Station samples the end conditions before the first action. If
   every condition was already true before replay acted, the result is
   `end-mismatch` even though every action ran, because nothing shows that the
   replay produced the outcome. This is the pilot's `/settings?view=appearance`
   case. The e2e framework exempts a step whose last action navigated; Station
   should accept that exemption only when it observed the navigation commit
   during the replay.

The tool returns one of three results:

- **Replayed:** every action ran and the outcome is attributed.
- **Handed off:** replay stopped after at least one action. The result gives
  the actions that ran, the stop reason, the current path and a short detail.
- **Missed:** replay stopped before its first action.

A replayed result is not verification of the application. The request's check
still runs live, and Station never caches assertions or judgments.

### Hand-off to a live Agent

The calling Agent is the live Agent; no second model is started. A handed-off
result tells the Agent to continue from the current page and not to repeat the
actions that already ran. After `end-mismatch` or `action-uncertain`, it tells
the Agent to check the current state before acting, because the effect may
already have happened. A missed result means the Agent runs the whole step
live.

Human takeover is not a hand-off. Replay stops as `interrupted`. The Agent
cannot act until control is handed back, and it must take a fresh snapshot
before acting by ref, as it must today.

**Re-recording.** A handed-off step can be recorded again only under the same
conditions as a first recording, including a passing check afterwards. A
replayed step never rewrites its own entry.

### Invalidation

- **Evict** the entry when replay ends in `target-not-found`,
  `target-ambiguous`, `action-failed` or `end-mismatch`, unless the live
  continuation re-records the step. Evict it when the Agent had to act to fix an
  `end-mismatch`, so that the next verified run records a clean flow.
- **Re-key** all entries when the recording schema or target-matching rules
  change.
- **Delete** a principal's recordings when they lose standing in the Project,
  when the Project is removed or when their profile is deleted. Delete an
  Agent's recordings when the Agent is deleted. Replay rechecks authority on
  every action anyway; deletion keeps stale literal values from lingering.
- **Refuse** a step whose secret binding was revoked or no longer grants that
  origin (`secret-unavailable`). Keep the entry, because the binding may be
  restored.
- **Do not invalidate** on human takeover, cancellation or an unavailable
  model. None of these shows that the recording is stale.

**Server-state limits.** The start and end checks cannot detect application
state that earlier runs left behind, apart from the already-true case that
attribution catches. A recording can still "succeed" against different data
than it was recorded with. Recording precondition anchors, meaning elements
that must look as they did when recorded before replay starts, would narrow
this at the cost of more misses. That choice is an [open question](#open-questions).

### Secrets and values

**Secret handles.** A new secret-binding grant kind (working name
`browser-field`) would name a canonical Project, a principal profile and an
origin. This follows the exact-grant pattern of the existing kinds. The model
sees only `<secret:name>`. Station resolves the value inside the Station
process when it types, and every replay re-authorizes the grant. The value
never appears in a tool result, the recording or history (history already
records typed text by size only).

**Literal values.** Values that come from the instruction, the parameters or
the Agent's own composition are stored verbatim in the recording. This is a
deliberate departure from the history posture of recording size only, and it
is why recordings are owner-scoped and kept outside Project roots. The owner
can review stored values in the recording, and Station would refuse to record
a value that contains a binding's current value. **Redaction stops at string
matching:** it does not catch a transformed, partial or encoded secret, or a
secret the page displayed and the Agent re-typed. Values read from the page or
a screenshot, and values computed from the date, are gaps and are not
recorded.

### Devices

Devices are out of the first slice. Device input targets coordinates, not
elements, so every device action would be a point target, which is a gap above.
Binding point targets safely would need host, device, orientation and
application build identity. The Device guide states that a visible screen does
not identify the foreground application or its build, and an accepted input
write does not prove the device applied it. Device Task clips now save the app
observed when recording starts; that observation might later help bind a
recording to an app ID, but it does not identify the build. Revisit this after device input
can target elements from the accessibility tree.

## Out of scope

- Caching assertions, waits used as checks, extraction or judgments.
- Model-free replay outside a bound Session, such as Automations or schedules.
- Replay on another backend, engine-native browser or profile.
- Recording human input.
- Sharing recordings across principals, exporting them or committing them to a
  repository.
- `browser_evaluate`, uploads, dialog answers, popups and drag.
- Device replay.
- Using a replay result as Task gate or review evidence.

## Open questions

1. **First consumer.** Which flow needs this first: setup steps an Agent
   repeats within Tasks, or Station's own regression flows? The
   [first alternative](#alternatives-considered) covers the second without any
   Station change. A tracking issue should name the consumer before
   implementation starts.
2. **What counts as verification** when Station has no test runner: a condition
   in the instruction or Task definition, a person's confirmation, or either.
3. **Approval granularity.** Should one replay approval cover every action in
   the recording, or should replay need its own prompt that the session-wide
   browser choice does not cover?
4. **Literal values.** Is owner-scoped verbatim storage acceptable, or should
   the first slice record only steps whose values are all secret handles or
   parameters supplied again at replay?
5. **Sharing.** May a Project admin replay the operator's recording in their
   own profile? The values and signed-in state differ between profiles.
6. **Product name**, so the feature does not collide with History replay.
7. **Bounds** on actions, bytes, anchors and wait time.
8. **Precondition anchors** to reduce sensitivity to server state, against the
   extra misses they cause.

## Alternatives considered

1. **Use the external framework and change nothing in Station.** This is how
   the pilot ran. It suits Station's own regression flows and costs no
   Station code, but it does nothing for Agents working in Sessions. Recommended
   for Station's own testing whatever happens to this proposal.
2. **Have the Agent write a deterministic test script into the Project.**
   Agents can already do this. A script is reviewable and versioned and runs in
   CI. It runs in its own browser, outside Station's profile, lease, fence and
   takeover controls, and it cannot hand off to an Agent. This suits test
   suites, not repeated work inside a Session.
3. **Build recordings from browser action history.** Rejected: refs do not
   last, values are recorded by size only, history is capped at 200 entries
   and has no verification signal. Widening history to keep values would
   weaken a deliberate privacy posture.
4. **Cache model responses or whole tool-call transcripts.** Rejected: this
   repeats model output against a page that may have changed, with no target
   or outcome check.
5. **Target by pixels or screenshots.** Rejected for the first slice: these
   targets are fragile under viewport, theme and layout changes, and they carry
   no semantic identity that can be checked.
6. **Record every successful step without a check.** Rejected: the pilot's
   dark-mode step shows that a goal can pass without doing anything.

## Acceptance, if implemented

Each case must reach the real BrowserAutomation and lease owners and fail when
its protection is reverted:

- revoking authority (Agent access, Project standing or the profile grant)
  partway through a replay refuses the next action;
- a human takeover partway through stops replay, writes no further history
  entries for the Agent and leaves the entry intact;
- an outcome that is already true returns `end-mismatch`, and the step is not
  reported as replayed;
- an ambiguous or missing target stops replay without acting;
- an action interrupted after dispatch returns `action-uncertain` and is not
  retried;
- a secret value never appears in the tool result, the recording, history or
  logs, and a revoked binding refuses the step;
- a recording made in one principal's profile cannot be replayed in another.

Fault injection should show, for each case, that the test fails with the
protection removed.
