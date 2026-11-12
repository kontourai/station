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
- **An automation run still cannot change automations** (§5 "Never"). A
  proposal is refused in three cases:
  - the calling Session acts for no one (it has no recorded owner, like a
    Session an automation, a webhook or another agent started);
  - the Session runs for a Task an automation rule created;
  - its current turn was sent by an automation (a rule's action or a
    scheduled run), or delegated by unattended work. This uses the #4512
    `dispatchOrigin`.

  Anything Station cannot read counts as started by an automation.
- **Untrusted content is shown.** If the proposing conversation, or a child
  it delegated to, had read content an integration classifies as untrusted
  ([#3483](https://github.com/kontourai/station/issues/3483)), the
  proposal records that, and the card says so before the description.
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

- Only the agent leaves are reachable by an agent. Confirm and Decline are
  person leaves that no station-control tool maps, and Confirm also needs
  the operator gate the isolated-repair setup uses.
- If a restart interrupts a Confirm after the record was created but before
  the proposal was marked confirmed, the proposal reopens, and confirming
  again creates a second copy. The configuration store has no idempotency key
  to match on.
- Station does not yet have a route that removes a source or rule (it is
  proposed in [#4646](https://github.com/kontourai/station/pull/4646)), so
  "removing a rule leaves things exactly as before" is not covered here.
