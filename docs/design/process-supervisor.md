# Station process supervisor

> **Reading status: proposal (2026-10-17).** Nothing here is implemented. The
> current lifecycle is owned by the Desktop sidecar supervisor
> (`run_sidecar_supervisor` in [`src-desktop/src/lib.rs`](../../src-desktop/src/lib.rs)),
> [`station service run`](../../packages/cli/src/commands/service-run.ts), the
> [archive launcher](../../packaging/portable-server/bin/station-launcher.mjs),
> and [owned-child tracking](../../src-server/services/infra/process-utils.ts).
> Claims about current behavior are from source inspection on 2026-10-17, not
> from executed journeys. A decision record superseding parts of
> [ADR 0015](../adr/0015-restore-desktop-owned-command-station-sidecar.md) is
> required before the first phase lands.

## Why

Every way Station restarts interrupts running work.

- The server owns its listeners, agent engines, and terminals, so stopping it
  stops all three. Upgrade paths stop it abruptly:
  - The in-app git-pull update calls `process.exit(0)` without graceful
    shutdown.
  - Desktop allows its sidecar about one second before killing it.
  - `station upgrade` allows five seconds and refuses to run under a service.
  - The archive launcher stops the old version before starting the new one.
- Boot kills engines left by the previous server
  (`sweepOrphanedOwnedProcesses`) and marks their turns interrupted. Claude
  Code is not even an owned child; it dies with its stdin pipe.
- No engine can be reattached mid-turn. Claude Code, Codex, ACP agents, and
  Muse all speak over the stdio of the process that spawned them, so only a
  new turn can resume their session.
- Three supervisors exist with three behaviors: a Rust thread in Desktop, a
  Node loop in `service run`, and the archive launcher's update transaction.
  None of them keeps work alive.
- One instance binds four ports (API, terminal `+1`, voice `+2`, consent
  `+3`), and `station start` adds a separate UI server process.

## Goals

1. Restart or upgrade the core server without interrupting running turns,
   terminals, or client connections.
2. One supervisor implementation for every launch mode and operating system.
3. No added hop on HTTP, SSE, or WebSocket traffic; bounded memory everywhere.
4. A supervisor protocol that does not assume a shared machine, so execution
   can later move to another machine.
5. Crash isolation and resource limits per kind of work.

Not goals: surviving a machine reboot (covered by session resume and layout
restore), and upgrading the supervisor itself without disruption.

## Process model

```text
launcher: Desktop app | launchd | systemd | Task Scheduler | station start | tini
  └─ station supervisor        stable, small; owns listeners, workloads, journals
       ├─ core server  gen N    replaceable; all product logic
       ├─ core server  gen N+1  only during a handoff
       └─ workloads             agent engines, terminals
```

A Station instance becomes the supervisor and its core server generations.
The instance registry records the supervisor's pid. The topology vocabulary
in [station-topology.md](station-topology.md) is updated when this lands.

### Supervisor responsibilities

The supervisor is deliberately thin. It makes no authorization, routing, or
product decisions.

- **Listeners.** It binds the instance's ports and passes the listening
  handles to the active core server over IPC. Node supports handle passing on
  macOS, Linux, and Windows; it is what the `cluster` module is built on.
  Connections go straight to the core server, so there is no proxy hop.
- **Generations.** It starts a new core server as a trial, waits for
  readiness, hands it the listeners, then tells the old generation to stop
  accepting and drain. If the trial fails, the old generation keeps serving.
  This absorbs the archive launcher's pending, trial, commit, rollback
  transaction. It also restarts a crashed core server with backoff, absorbing
  the Desktop and `service run` restart loops.
- **Workloads.** It spawns agent engines and terminals and owns their stdio
  and PTYs. Output is journaled with sequence numbers into a bounded memory
  tail and append-only disk segments. A core server attaches to a workload
  from a sequence number, writes to it, signals it, and lists workloads.
  Resource limits use systemd scopes on Linux, job objects on Windows, and
  process groups everywhere.
- **Registry.** It holds the home's single-owner claim and the
  `instances.json` record. Because it owns every engine, the boot sweep only
  matters after a supervisor crash.
- **Control channel.** A versioned protocol on a local socket in the Station
  home (mode 0600), or a named pipe on Windows. The core server, the CLI, and
  the tray are its clients.

### Implementation

The supervisor is a separate Node package with minimal dependencies, released
with Station but versioned on its own protocol. Node runs in every launch
mode, including containers. Desktop already requires Node 24. A Rust
supervisor would cover only Desktop.

Its protocol has two parts:

- A small, stable core (attach, write, signal, list, generation handoff) that
  minor versions never break.
- Optional capabilities negotiated at handshake.

Compatibility is tested by running old and new versions against each other as
real processes.

The supervisor is replaced only when its protocol major version changes. If
work is running, the user chooses between waiting for it and stopping it.

### Performance

- **HTTP, SSE, and WebSocket:** handle passing means zero added hops.
- **Workload I/O:** one local socket hop between supervisor and core server,
  with binary framing. Engine JSON-RPC lines and terminal bytes pass through
  as bytes, never re-encoded.
- **Journaling:** a ring buffer plus appends. Nothing rewrites a whole file.
- **Budget:** the added hop must stay under 1 ms at p99 on a local machine,
  measured before and after the engine phase. If it does not, the transport is
  fixed before engines move.
- **Backpressure** follows the workload's nature:
  - Engines block on a full pipe, which pauses them rather than losing
    output.
  - Terminals keep reading. Their memory tail drops the oldest bytes once the
    disk journal holds them.

### Engine reattach

Core server adapters talk to a workload stream instead of a child's stdio.
For Claude Code this is the custom spawner the Agent SDK already accepts. For
Codex, ACP, and Muse it is the stdio transport behind `spawnOwnedChild`.

On startup, before interrupted turns are consumed, the core server:

1. Lists the supervisor's live engine workloads.
2. Attaches each one to its session from the last sequence that was applied
   to the event store. That sequence is persisted atomically with the events
   it produced.
3. Replays the engine log since then to rebuild adapter state: open
   approvals, child work, and stream position.

Only turns whose engine is gone take the interrupted path.

As a safety net for every engine, an interrupted turn can be resumed
automatically from its `resumeCursor`, with a bounded retry. This is the
"bounded auto-resume" slice already anticipated in
[`interrupted-turn-recovery.ts`](../../src-server/services/orchestration/interrupted-turn-recovery.ts).
In-process engines (Ollama, Bedrock, station-agent) rely on it, since they
live in the core server.

### Launch modes and the tray

| Mode | Launcher | Change |
| --- | --- | --- |
| Desktop | Tauri app | Starts or attaches to the supervisor instead of owning the server. The Rust restart loop is removed. |
| Installed service | launchd `KeepAlive`, systemd `Restart=always`, Windows Task Scheduler | Runs the supervisor instead of `service run`. |
| Archive install | Fixed launcher | Starts the supervisor, which owns the update transaction. |
| `station start` | CLI, detached | Starts the supervisor. The separate UI server becomes a core server route. |
| Container | `tini` | Runs the supervisor. |
| Mobile | None | No change; mobile never runs a server. |

The tray becomes a control-channel client in every mode. Today it owns the
sidecar but only observes an installed service. With the change it shows the
same status and controls whoever launched the supervisor, including running
turns, terminals, and pending updates.

Quitting Desktop no longer has to stop work. If turns or terminals are
running, Desktop offers to keep Station running in the background and
remembers the answer.

### Upgrade paths

Every path becomes a generation handoff:

- the Desktop updater;
- the archive launcher;
- the in-app git-pull update and `install.sh --relaunch`;
- `station upgrade`, which no longer needs the service stopped.

### Per operating system

- **macOS:**
  - The supervisor runs under launchd or as a detached child of Desktop.
  - Node is an external binary, so hardened-runtime entitlements are
    unaffected.
- **Linux:**
  - Under systemd the supervisor is the unit's main process, so stopping the
    unit stops everything.
  - Workloads run in memory-limited scopes when systemd is available.
  - node-pty builds from source until Linux prebuilds ship.
- **Windows:**
  - A ConPTY cannot change parents, so the supervisor creates every PTY.
  - Job objects make kill-tree reliable.
  - Task Scheduler does not relaunch a process that exits. The supervisor
    therefore restarts core servers itself, and the logon task's wrapper
    restarts the supervisor.

### Failure modes

| Failure | Outcome |
| --- | --- |
| Core server crash | Supervisor restarts it; workloads keep running and reattach. |
| Trial generation fails readiness | Old generation keeps serving; the update is rolled back and reported. |
| Supervisor crash | Workloads end, because their stdio and PTYs die with it. Boot behaves as today: interrupt, then auto-resume. Keeping the supervisor small keeps this rare. |
| Disk journal full | Oldest closed segments are trimmed; a running workload's tail is never dropped silently. The trim is reported. |

### Later: remote workloads

The workload protocol avoids local-only assumptions: no descriptor passing,
and paths relative to the workload's binding. A supervisor on another machine
can therefore offer workloads over an authenticated connection, under an
explicit execution offer (see [station-topology.md](station-topology.md)).
Not built here.

## Delivery

Each phase is its own lane and pull request, with independent review,
verification, and fault injection.

1. **Supervisor core:** package, control protocol, listener handle passing,
   generation handoff with trial and rollback, crash restart. Adopted by
   `station start`, `service run`, and containers first.
2. **Workloads and terminals:** workload host and journals, then the terminal
   redesign on top of it (see [terminal.md](terminal.md)).
3. **Engines:** workload-stream transport per adapter, reattach before
   interrupted-turn consumption, bounded auto-resume.
4. **Launch modes and upgrades:** Desktop, archive launcher, tray as control
   client, keep-running on quit, every upgrade path as a handoff.
5. **Consolidation:** voice and consent onto the main origin; old supervisors,
   restart loops, and the UI server process removed.

## Verification

- **Handoff journey:** a real live terminal and a scripted engine turn, handed
  from generation N to N+1. Same PIDs, no sequence gap, and the turn recorded
  exactly once.
- **Rollback journey:** generation N+1 fails readiness; N keeps serving and
  clients see no error.
- **Compatibility:** old and new supervisors and core servers in every
  pairing, run as child processes.
- **Per OS:** journeys run on real macOS, Windows, and Linux hosts.
- **Latency:** the hop budget measured against its own baseline.
- **Fault injection:** removing reattach makes the handoff journey fail with
  an interrupted turn; removing handle passing makes a client see a refused
  connection.

## Open questions

1. Whether the browser-pane host and device hub become workloads.
2. The default answer when Desktop quits with work running.
