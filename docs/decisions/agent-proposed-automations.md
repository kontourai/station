---
status: current
subject: An agent proposes Automation sources and rules; a person confirms
decided: 2026-11-12
evidence:
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4830
  - kind: issue
    ref: https://github.com/kontourai/station/issues/4832
  - kind: issue
    ref: https://github.com/kontourai/station/issues/3483
  - kind: issue
    ref: https://github.com/kontourai/station/issues/3439
  - kind: doc
    ref: docs/design/automations.md
  - kind: doc
    ref: src-server/services/automation/automation-proposals.ts
  - kind: doc
    ref: src-server/routes/orchestration/automation-proposals.ts
  - kind: doc
    ref: src-server/security/__tests__/automation-proposal-authority.routes.test.ts
---

# An agent proposes Automation sources and rules; a person confirms

## Decision

The owner reversed the [Automations design](../design/automations.md)'s §5
"Who can create rules" on 2026-11-12
([#4830](https://github.com/kontourai/station/issues/4830)). Asking an agent to
set up an automation is the obvious interaction, so an agent may now ask for
one. It still cannot create one: **an agent proposes, a person confirms.**
This is the `propose_job` pattern Station already uses for scheduled jobs.

- Station-control has `propose_automation_source`, `propose_automation_rule`
  and `list_automation_proposals`. A proposal is validated and recorded with
  a plain description that Station writes, not the agent: what it watches,
  what it opens, which agent it wakes, and with what authority. It creates
  nothing.
- The person sees the proposal as a card in the chat that proposed it, where
  job proposals already appear, and confirms or declines it. Confirming needs
  the Station operator in person, because sources and rules are Station-wide
  configuration. The source or rule is then created through the ordinary
  configuration store.
- **Default deny is kept.** A confirmed source starts disabled and a
  confirmed rule starts in `observe` mode, which records decisions but never
  acts. The person can tick "Turn it on now" in the same confirmation to
  create an enabled source or a `live` rule. Even then, polling waits for
  the GitHub automation observations preview, and Tasks wait for the GitHub
  automation Tasks preview.

## Rules

- **Never more than the proposing chat holds.** Each Project/Agent pair a
  proposal names must pass the dispatch scope rule for the proposing chat,
  as its recorded owner. That is the same check that would let the chat start
  work there itself. A proposal may name only `dispatch-task`, never
  `isolated-repair` or `publish-branch`. A rule cannot pin `auto` approval: an
  agent cannot loosen its own approvals, so it cannot ask for a rule that
  would. A body carrying `fullAccessGrant`, a credential binding, a secret,
  `enabled` or `mode` is refused as an escalation. Only credential-free
  `github-poll` sources can be proposed. A webhook source needs a secret
  that only a person may hold.
- **Confirm decides it again.** Confirm reruns the dispatch scope rule for
  the proposing chat's recorded caller, now. It requires each Agent to be the
  one named: the same slug, its own Project, and a digest of its whole
  definition. Agents have no identity beyond their slug, so the digest is
  what tells a moved, deleted or replaced Agent apart. Confirm checks before
  claiming the proposal, then again inside the configuration store's lock
  for creation and for enabling. A binding that changed or cannot be read
  creates nothing.
- **Only a turn a person typed may propose (fail closed).** An automation
  run still cannot change automations (§5 "Never"). A proposal is allowed
  only when the calling Session acts for a recorded owner and the turn making
  the call carries the shared, server-stamped person mark
  ([#4848](https://github.com/kontourai/station/pull/4848)). Station stamps
  that mark only on a turn the web, desktop or mobile composer sent with a
  person credential, and the decision reads that turn's own start, never a
  steer.
  - **Which turn is calling: inferred, not known.** An engine's
    station-control call carries only its Session's credential, never a
    turn. Proposals are gated on the calling turn being person-authored,
    and Station infers that turn from Session state: the turn the Session
    is running, by its persisted lifecycle fold (`stationControlCallingTurn`,
    the same lease `declare_pull_request` uses). While a send's start is not
    yet stored (in flight, accepted but not arrived, or held by origin
    propagation), the answer is `pending`; with no running turn it is
    `none`. Both refuse.
  - **Known race.** A concurrent steer, whether it fails or is accepted,
    clears an in-flight delegated continuation's pending reservation. That
    continuation's call is then judged by the person's earlier turn, so an
    agent continuation can create a proposal card. Confirmation by the
    operator in person remains required, and it is the authority boundary:
    the card shows the untrusted-content warning, the full agent text and
    the authority ceiling, all rechecked at Confirm. The fix is a
    turn-bound station-control credential, [#4882](https://github.com/kontourai/station/issues/4882).
  - **Known false refusal.** An invocationless legacy turn start can leave
    the Session reading `pending` after its turn has ended, so proposals
    from that Session wrongly refuse until it exits. This fails closed.
  - **Check to write.** The route decides again inside the SQLite
    transaction that stores the proposal and requires the same turn, so a
    turn that starts in between stores nothing.
  - Everything else refuses: an automation's run, a delegated child's result
    continuing in the person's chat, a peer Station's `/chat/delegated` send,
    a background run, the CLI, an MCP prompt, a Task dispatch, a check-back, a
    turn recorded before the mark, no turn at all, and an unreadable store.
  - `dispatchOrigin: 'interactive'` is not enough. It says whose chat a turn
    was placed in, and a child's result continuing in a person's chat
    inherits it (the #4850 re-review's finding).
  - A Session running for an `automation-rule` Task acts for no one, so it
    is refused earlier, by its missing recorded owner.

  A delegated `send_message` that names a conversation no Session holds yet
  now records `delegation`, not `unknown`.
- **Station's words and the agent's stay apart.** The description Station
  writes carries none of the agent's text. The card shows the name,
  conditions, reason and complete instructions apart, under "Written by the
  agent", with instructions in a scrollable disclosure. Nothing is truncated.
- **Untrusted content is shown.** The proposal records whether the proposing
  conversation, or a child it delegated to, had read content an integration
  classifies as untrusted
  ([#3483](https://github.com/kontourai/station/issues/3483)). The mark is
  read again when the chat lists proposals, so a chat marked later still
  warns. Confirm records the mark as it was then. The card warns if either
  mark is set.
- **One proposal, one object.** A confirmed source or rule is created under
  an id derived from the proposal. A retried or interrupted Confirm adopts
  what an earlier one created and never creates a second. Startup reconciles
  interrupted claims against that id.
- **Bounds.** A chat may have 3 proposals waiting and make 10 an hour.
  Beyond either, the proposal is refused.
- **A rule on a proposed source** names it by `sourceProposalId`. It can be
  confirmed only after that source is confirmed, and it then attaches to the
  created source.

## Where sources come from

Today's source kind is Station's own GitHub poll. Sources are moving to
[Telltale](https://github.com/kontourai/telltale), the suite's event actor,
tracked in [#4832](https://github.com/kontourai/station/issues/4832). Once a
source type's `plan()` can describe the source, it should write a proposal's
"watches" text. Nothing here depends on Telltale yet.

## Limits

- The calling turn is inferred from Session state, so the person-mark gate
  has the known steer race and stuck-`pending` case described above, until
  a turn-bound credential lands ([#4882](https://github.com/kontourai/station/issues/4882)). An agent can at most
  create a proposal card; nothing exists until the operator confirms it.
- Only the agent leaves are reachable by an agent. Confirm and Decline are
  person leaves that no station-control tool maps, and Confirm also needs
  the operator gate the isolated-repair setup uses.
- If a restart interrupts a Confirm after creation but before enabling, the
  object is adopted in its default-deny state. The person enables it
  separately.
- An Agent recreated with an identical definition under the same slug
  matches the recorded binding. It is indistinguishable, and it grants the
  same authority.
- A Station-engine Agent whose station-control connection carries no
  verified caller (for example one on a model connection) cannot propose:
  the guard refuses it (`station_control_caller_required`). Engines that
  carry a verified caller can.
- Station does not yet have a route that removes a source or rule (it is
  proposed in [#4646](https://github.com/kontourai/station/pull/4646)), so
  "removing a rule leaves things exactly as before" is not covered here.
