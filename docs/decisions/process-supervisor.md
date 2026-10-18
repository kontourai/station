---
status: current
subject: Station process ownership and the process supervisor
decided: 2026-10-17
evidence:
  - kind: adr
    ref: docs/adr/0015-restore-desktop-owned-command-station-sidecar.md
  - kind: doc
    ref: docs/design/process-supervisor.md
  - kind: doc
    ref: packages/supervisor/src/generation-manager.ts
  - kind: doc
    ref: packages/supervisor/src/entry-boundary.ts
---

# Station process ownership and the process supervisor

## Decision

Station runs as a per-user background service, and the tray controls it. The
service runs the Station process supervisor, which owns the instance's
listening sockets and its core server generations. Desktop, the tray, and the
CLI are clients of the supervisor's control channel.

Desktop runs the supervisor as its own child only when the user declines the
background service, or the machine cannot install a per-user service (for
example, some managed Windows machines). In that mode Station stops when
Desktop quits, and Desktop says so.

This supersedes the Desktop-owned sidecar ownership decided in
[ADR 0015](../adr/0015-restore-desktop-owned-command-station-sidecar.md):
Desktop no longer owns a server process in its normal launch. ADR 0015 stays
frozen as history.

## Rationale

Every restart path today interrupts running work, and three supervisors (the
Desktop sidecar loop, `station service run`, and the archive launcher) behave
differently. One supervisor that holds the listeners lets the core server be
restarted or upgraded while connections wait in the kernel backlog instead of
being refused, and gives every launch mode the same rollback and crash
restart behavior. The [design](../design/process-supervisor.md) has the full
reasoning, phases, and verification plan.

## Boundary

- Phase 1 hands off one generation at a time. Overlapping generations wait
  for a home-writer lease.
- The supervisor makes no authorization, routing, or product decisions.
- A handoff runs only a `.js` or `.mjs` entry whose real path is strictly
  inside the supervisor's build root (`--build-root`, by default the
  directory of the initial entry). Anything else is refused before a process
  starts, so holding the control token does not let a client start an
  arbitrary program as the Station server. A rollback relaunches only the
  previously committed entry.
- Still open for delivery phase 4: ADR 0015's finding applies when Desktop
  becomes a client. Desktop must not trust a listener because it answers on
  loopback, and a capability readable by agent-controlled processes is not
  proof of the backend's identity. The control token lives in the Station
  home, which agents running as the same user can read. How Desktop verifies
  its backend must be settled before Desktop adopts the service.
- Until the core server has a supervised mode and the launch modes adopt the
  supervisor, the lifecycle described in ADR 0015 remains what ships.
