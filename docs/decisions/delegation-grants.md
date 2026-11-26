---
status: current
subject: Operator-controlled access for delegated sessions
decided: 2026-11-26
evidence:
  - kind: url
    ref: https://github.com/kontourai/station/issues/5589#issuecomment-7183493367
  - kind: url
    ref: https://github.com/kontourai/station/issues/5590#issuecomment-7183494397
---

# Delegation grants

The operator can opt a Project into confined coding work and grant named
delegations full access. The **Delegation grants** Feature Preview is off by
default. With the preview off or no applicable grant, delegation uses the
existing workspace floor.

## Authority and defaults

- The operator sets grants in person. Agent credentials can read grants within
  their authorized scope. Only the operator can create, change, or revoke them.
- A grant can cover the Station, a Project, or one parent conversation. Project
  is the default. The narrowest matching scope wins.
- Targets are explicit lists of Agents, models, and Projects. The default lists
  are empty. A managed policy ceiling takes precedence over every grant.
- Full access requires a parent currently at full access under its own
  operator or qualified paired-device grant. Project members and shared Agents
  cannot confer full access. A delegated child cannot pass the grant to another
  delegation.
- Expiry defaults to the end of the parent session. The operator can choose a
  duration or keep the grant until revoked. Recheck standing authority before
  each new turn. Loss of authority, including loss of the parent device grant,
  returns the child to workspace confinement before its next turn.

## Worktree and network

The child's own worktree is on by default. Station provisions it before
starting the child, using the fetched default branch as its base. For confined
coding work, the child receives the worktree's own Git directory and the
minimum object and ref write paths needed to commit and push. The operator can
configure additional Git write paths per Project. Hooks and configuration
require an explicit addition. The primary checkout and sibling worktrees stay
outside the child's writable workspace.

Egress defaults to an editable allowlist on engines that can enforce it. The
initial list covers the Project forge, model endpoint, and package registries.
Where the engine supports only open or disabled network, the default is open
and the effective posture identifies it as open. If the operator explicitly
requests an unsupported restriction, report the refusal. Any fallback must
preserve or narrow the requested access.

## Visibility and evidence

Settings and configuration output show active grants with their scope, targets,
worktree and Git write choices, egress, expiry, operator, time set, and running
children. Settings offers revoke on each grant. Each child session and Task
shows the effective posture and its reason, derived from the start record and
current enforcement. Report a refusal or fallback before the first turn. Audit
creation, widening, use, expiry, and revocation in the diagnostics log.
If Station cannot read the grant file, it treats all standing grants as
inactive and reports the outage in Settings and the diagnostics log.

Promotion requires real provider and forge evidence, negative filesystem and
delegation tests, revocation through a live session harness, and independent
security review. The control surface carries the cost of additional checkouts
and makes any expanded network or host access visible.
