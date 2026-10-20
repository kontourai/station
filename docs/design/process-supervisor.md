# Station process supervisor

Status: Proposal — unscheduled; no tracking issue as of 2026-10-20 (phases 2–4; phase 1 shipped in #3811).

> **Reading status: proposal (2026-10-17), phase 1 core implemented.** The
> supervisor package ([`packages/supervisor`](../../packages/supervisor/src/generation-manager.ts))
> implements the control channel, listener handoff, sequential generation
> handoff with rollback, and crash restart, verified against a fixture core
> server. No launch mode runs it yet, and the core server has no supervised
> mode. The [process supervisor decision](../decisions/process-supervisor.md)
> records the ownership change. Until adoption, the
> current lifecycle is owned by the Desktop sidecar supervisor
> (`run_sidecar_supervisor` in [`src-desktop/src/lib.rs`](../../src-desktop/src/lib.rs)),
> [`station service run`](../../packages/cli/src/commands/service-run.ts), the
> [archive launcher](../../packaging/portable-server/bin/station-launcher.mjs),
> and [owned-child tracking](../../src-server/services/infra/process-utils.ts).
> Claims about current behavior are from source inspection on 2026-10-17, not
> from executed journeys.

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
launcher: launchd | systemd | Task Scheduler | station start | tini
  └─ station supervisor        stable, small; owns listeners, workloads, journals
       ├─ core server  gen N    replaceable; all product logic
       ├─ core server  gen N+1  only during a handoff
       └─ workloads             engines, terminals, browser host, device hub

clients: Desktop window and tray, CLI, browsers, paired devices
```

A Station instance becomes the supervisor and its core server generations.
The instance registry records the supervisor's pid. The topology vocabulary
in [station-topology.md](station-topology.md) is updated when this lands.

### Supervisor responsibilities

The supervisor is deliberately thin. It makes no authorization, routing, or
product decisions.

- **Listeners.** The supervisor holds every listening socket open but never
  accepts on it. The first core generation binds its ports normally and sends
  each raw listening handle (`server._handle`) to the supervisor over the
  Node IPC channel. Later generations receive the held handle and call
  `server.listen(handle)`. Because the socket stays in the listening state
  while no generation accepts, connections made during a swap or a crash
  restart wait in the kernel backlog instead of being refused. Connections
  go straight to the core server, so there is no proxy hop.
  - A `net.Server` listening in the supervisor would accept connections
    itself, so the supervisor holds only the raw handle. A core must send
    `server._handle`, not the server: Node turns a sent `net.Server` into a
    listening server in the receiver. The supervisor refuses anything but a
    raw TCP or Pipe handle, closes it, and fails that generation.
  - Node's `cluster` module was prototyped and rejected: sibling
    generations' ephemeral `listen(0)` calls collided.
  - `_handle` is a Node internal. A guard test
    ([`handle-guard.test.ts`](../../packages/supervisor/src/__tests__/handle-guard.test.ts))
    fails if a Node upgrade breaks sending, holding, or adopting it.
- **Generations.** Phase 1 swaps generations one at a time
  (hold-and-swap), because two generations cannot share a Station home yet:
  boot consumes interrupted-turn boundaries, runs the schema gate, and opens
  single-writer stores. A handoff from generation N to N+1:
  1. Start N+1, which loads its code and reports `parked` before touching
     the home. If it fails to park, N was never disturbed and keeps serving.
  2. Send `drain` to N. N closes its copies of the listeners, finishes
     in-flight requests, and exits. A drain deadline then escalates to
     SIGTERM and SIGKILL. An active voice call extends the deadline up to a
     cap, so a live call finishes on N instead of dropping. Voice therefore
     stays in the core server rather than becoming a workload.
  3. When N has exited, `promote` N+1 and send it each held handle with
     `listener.adopt`. N+1 boots and reports `ready` with its boot id.
  4. Commit, once N+1 has stayed up for a short grace after `ready`. If N+1
     exits before then or misses its readiness timeout, the supervisor kills
     it, starts N's entry again as a new generation, and reports
     `rolled-back`.

  Clients wait during the swap but are not refused. Draining sets
  `Connection: close` on every response, so busy keep-alive connections
  close after their response and reconnect into the backlog. Connections
  still idle after a short grace are then closed with
  `closeIdleConnections()`. Closing idle connections immediately, which
  `http.Server.close()` does on Node 19 and later, resets keep-alive clients
  whose next request is already in flight: the fixture saw every
  connection reset on every handoff until the grace was added. SSE and
  terminal clients reconnect and resume.

  Overlapping generations, where N+1 boots while N still serves, need a
  home-writer lease that hands the home from one generation to the next. That
  is a later phase; the `parked` and `promote` steps exist so the protocol
  does not have to change for it.

  A crash of the active generation, outside a drain, restarts it with
  exponential backoff: 1s doubling to a 30s cap, reset after 60s of stable
  serving. A crash during a handoff counts toward the same failure budget.
  After five failures within five minutes the supervisor gives up and exits
  nonzero, so its launcher's restart policy takes over. Stopping the
  supervisor (SIGTERM, SIGINT, SIGHUP, or the `stop` request) drains the
  active generation and exits zero. That drain, voice calls included, is capped at 30 seconds
  by default, below service managers' stop timeouts; the long voice cap
  applies only to handoffs.

  One supervisor runs per home and instance, enforced by lock epochs and
  process identity. The argument is written out in
  [`instance-lock.ts`](../../packages/supervisor/src/instance-lock.ts).
  - Lock files are `<home>/run/instance-<instance>.lock.<n>`, with n written
    without leading zeros, created only with `wx`, so each epoch n has
    exactly one winner. The highest n is the current lock. Its content is
    the holder's pid, a random nonce, its process start fingerprint, its
    creation time, and its control endpoint.
  - The holder is live while its pid exists with the start fingerprint it
    recorded. It is dead only when its epoch is marked released, its pid is
    gone, or the pid now belongs to a process with a different fingerprint.
    A fingerprint that cannot be read counts as live. An empty or
    half-written lock counts as live for 30 seconds. Reaching the holder is
    never part of the decision, so a holder that is stopped, has a full
    accept backlog, or has lost its socket file is still live. A stopped
    holder therefore keeps the instance until it is continued or killed.
  - A starter refuses while the holder is live. If it is dead, the starter
    creates the next epoch; if another starter created it first, it starts
    over and finds that one live.
  - The winner binds its control socket. An existing socket file is
    replaced only by the holder of the top epoch, and only if connecting to
    it is refused or finds nothing; a successful connect or any other error
    refuses. The winner then confirms the top epoch is still its own,
    collects older epochs, publishes the token, reaps, and serves.
  - Node unlinks a Unix socket's bound path when the server closes, whoever
    owns that path by then. So the socket is bound at a private name in the
    same directory and published at the real path with `link()`, which
    refuses an existing path. Closing the server removes only the private
    name; the real path is removed only after it is moved aside and found
    to be the inode this process bound.
    Filesystems that refuse `link()` (some FUSE, SMB, or 9p mounts) make
    the bind fail closed, and a control path whose directory leaves no room
    for the private name within the socket path limit is refused at start.
    A third process that binds the path in the instant it is moved aside
    loses it when this process puts it back; its self-check then sees the
    conflict and it exits with status 1 (an accepted gap). While holding the
    lock, the supervisor removes leftover private names of exactly its own
    pattern that are sockets older than a minute, so names from a killed
    process do not accumulate.
  - Every 5 seconds the holder confirms the top epoch is still its own,
    draining and exiting with status 1 if not. If its socket file was
    deleted or replaced (on Windows, if the pipe server stopped listening)
    it re-binds, but only when nothing else listens on the path; if another
    process does, it refuses to take the path back, logs the conflicting
    path, drains, and exits with status 1.
  - A clean exit never deletes the top epoch. It marks its own epoch
    released, by rewriting it through a temporary file, and only while the
    file still holds its nonce and pid. Epoch numbers therefore never go
    backwards.
  - Earlier designs decided liveness by reaching the holder, or by comparing
    `ps` output that follows the time zone and locale. Each let a second
    supervisor take over a live one.

  A core must exit when its IPC channel disconnects, which is how it learns
  the supervisor has died. What backs that up differs by platform:
  - **POSIX.** Each generation leads its own process group. The supervisor
    records each generation's pid and process start time in its run
    directory (on Linux the start time includes the boot id). The next
    supervisor, holding the lock, sends SIGTERM to a recorded generation's
    group that is still the same process, waits briefly, then sends SIGKILL,
    and reports it reaped only once the group is gone. If it survives, the
    supervisor refuses to start rather than fail on a held port. A pid whose
    start time differs has been reused and is left alone; one whose start
    time cannot be read is left alone and kept on record. `ps` runs with
    `TZ=UTC` and `LC_ALL=C`, so the recorded value does not depend on the
    environment. This covers the generation and processes in its group; a
    process that left the group is not covered. If a generation's leader is
    gone but its group still has members, the group cannot be verified (the
    id may since belong to an unrelated group), so it is logged and left
    alone: an accepted gap.
  - **Windows.** Node starts non-detached children inside a job object that
    is killed when the parent exits (libuv's `src/win/process.c`), so a core
    dies with its supervisor even if it ignores disconnect. That is verified
    on a Windows host with `taskkill /F` on the supervisor. The job does not
    include the core's own children, and when the supervisor already runs
    inside a job that forbids breakaway the assignment silently fails; both
    are gaps. A recorded generation that escaped anyway, for example from
    an older build, is reaped with `taskkill /T /F`. Reading a process start
    time there takes one PowerShell call, about 145 ms. PowerShell exits 1
    on any failed statement, so the call prints a sentinel instead: `GONE`
    only when `Get-Process` reports no such process; the start time from
    `Get-Process` or, if that is denied, from CIM's `Win32_Process`
    CreationDate, truncated to microseconds so both agree; anything else is
    unknown, which counts as live. On a Windows host both sources returned
    the same instant for a live process at the same integrity level; under
    a restricted token CIM was denied while `Get-Process` succeeded. A
    non-elevated query of an elevated process is not verified.

  This absorbs the archive launcher's pending, trial,
  commit, rollback transaction and the Desktop and `service run` restart
  loops.
- **Workloads.** A workload is a process whose lifetime the supervisor owns,
  so it outlives core server generations. The rule for what becomes one:
  anything that holds live external state across a turn. Request-scoped work
  (indexing, search workers) stays in the core server. A workload has one of
  two attachment styles:
  - **Stream:** agent engines and terminals. The supervisor owns their stdio
    or PTY and journals output with sequence numbers into a bounded memory
    tail and append-only disk segments. A core server attaches from a
    sequence number, writes, signals, and lists.
  - **Endpoint:** the browser-pane host and the device hub. The workload
    serves its own local socket (the Chrome DevTools Protocol for the
    browser host), and the supervisor reports the endpoint to the core
    server, which connects to it directly with no extra hop. A new core
    generation reconnects to the same endpoint, so live pages and device
    streams survive. The device hub's own restart loop is removed.

  Resource limits use systemd scopes on Linux, job objects on Windows, and
  process groups everywhere. The browser host gets a memory limit of its own.
- **Registry.** It holds the home's single-owner claim and the
  `instances.json` record. Because it owns every engine, the boot sweep only
  matters after a supervisor crash.
- **Control channel.** A versioned protocol on a local socket in the Station
  home (mode 0600 on Unix), or a named pipe on Windows. The core server, the CLI, and
  the tray are its clients.
  - The socket is `<home>/run/supervisor-<instance>.sock`. When that path
    exceeds the platform's socket path limit (104 bytes on macOS), a hashed
    path in a private temporary directory is used instead. Clients derive the
    same path.
  - On Windows the pipe is `\\.\pipe\station-supervisor-<hash>`, named from
    a hash of the home and instance.
  - Every connection starts with `hello`, carrying the protocol version and
    the token from `<home>/run/supervisor-<instance>.token` (mode 0600 on
    Unix; Windows relies on the home directory's ACL). A different major
    version or a wrong token is refused, and the supervisor disconnects a
    refused client promptly so it cannot hold a connection slot.
  - The supervisor creates its run directories at 0700 and refuses an
    existing one that is a symlink, belongs to another user, or is open to
    group or others; it never changes the mode of a directory it did not
    create. On Unix the client checks the same of the socket's directory
    before sending the token.
  - Requests are `status`, `handoff` (streams progress, then a result of
    `committed`, `rolled-back`, or `refused`), `stop`, and, with the
    `events` capability, `subscribe`.
  - A handoff entry must be a `.js` or `.mjs` file whose real path is inside
    the supervisor's build root; otherwise it is refused as
    `entry-outside-build-root` without starting a process. This bounds where
    the entry file lives, not what code runs: a process that can write into
    the build root can still change what the supervisor starts. Same-user
    write access to the build root is out of scope here and tracked for
    phase 4.
  - The types and constants are exported from
    [`@kontourai/station-supervisor/protocol`](../../packages/supervisor/src/protocol.ts).

### Recovery

The lock fails closed: when the supervisor cannot prove the holder is gone,
it refuses to start. Its refusal names the lock file, the holder's pid, and
the remedy. A holder that is running as this instance's supervisor is
stopped with SIGTERM or the control channel's `stop` request. Anything else
goes through the guarded command:

```sh
station-supervisor --break-lock --home <home> --instance <id> [--force] [--reason <text>]
```

It re-checks the holder itself. Its output shows only the holder's
executable name and first argument, without control characters, since later
arguments can carry secrets. A holder that is live by its recorded
process fingerprint is refused. A holder whose identity cannot be verified,
or a lock still being written, needs `--force`; the refusal shows the
holder's pid and command line so an operator can decide. Otherwise it marks
the top epoch released, recording `releasedBy: break-lock` and the reason.
It never deletes an epoch, so the next starter takes the next one.

- **A zombie holder.** A zombie's pid still exists and keeps its start time,
  so it reads as live until its parent reaps it. Reap or kill the parent;
  `--break-lock --force` is the fallback once the operator has confirmed it
  is not running.
- **A holder that recorded no fingerprint and then crashed.** Its lock reads
  as live while any process holds its pid. Once the pid is gone it is dead;
  if the pid was reused, use `--break-lock --force` after checking the
  command line.
- **Windows with PowerShell blocked or slow.** Fingerprints are unknown, so
  every holder whose pid exists reads as live. Use `--break-lock --force`
  after checking the pid.
- **PID namespaces, or a home shared across hosts or containers.** Process
  ids and start times mean something only on one host in one pid namespace.
  Sharing a Station home across hosts or containers is not supported: the
  lock may refuse a start, or, if pids collide with a different
  fingerprint, allow one.

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
| Desktop | Per-user login service | Desktop no longer owns a server. On first launch it asks to install the per-user service, then is a client of it. The Rust sidecar supervisor and restart loop are removed. |
| Installed service | launchd `KeepAlive`, systemd `Restart=always`, Windows Task Scheduler | Runs the supervisor instead of `service run`. The same service Desktop uses. |
| Archive install | Fixed launcher | Starts the supervisor, which owns the update transaction. |
| `station start` | CLI, detached | Starts the supervisor. The separate UI server becomes a core server route. |
| Container | `tini` | Runs the supervisor. |
| Mobile | None | No change; mobile never runs a server. |

Station runs in the background by default, through the service, and the tray
controls it. This removes the split between a Desktop-owned sidecar and an
installed service, and supersedes the sidecar ownership decided in
[ADR 0015](../adr/0015-restore-desktop-owned-command-station-sidecar.md).

- The service starts the tray at login in tray-only mode, so the tray is
  present without the window.
- The tray is a control-channel client. It shows instance status, running
  turns, terminals, and pending updates, and offers start, stop, restart,
  and update.
- Closing or quitting the Desktop window never stops work. Stopping Station
  is an explicit tray or CLI action, and asks for confirmation if turns or
  terminals are running.
- First launch explains the background service before installing it. If the
  user declines, or the machine does not allow a per-user service (for
  example, some managed Windows machines), Desktop runs the supervisor as its
  own child for that session only, and quitting Desktop stops it. Desktop
  shows that Station stops on quit in this mode.
- macOS shows its standard notice when the login item is added. On Linux,
  tray indicators cannot open their menu programmatically, so the window
  also exposes the same controls.

### Upgrade paths

Every path becomes a generation handoff:

- the Desktop updater;
- the archive launcher;
- the in-app git-pull update and `install.sh --relaunch`. Under supervision
  the core server sends `handoff.request` over its IPC channel instead of
  exiting, so the update is not disabled when supervised. The supervisor
  answers `handoff.refused` when it cannot run one, for example while a
  handoff is already in progress;
- `station upgrade`, which no longer needs the service stopped. A rollback
  relaunches the previous generation's entry, so that entry must still exist
  unchanged after the new build. This needs build directories pinned per
  generation (phase 4) instead of rebuilding `dist-server/` in place.

### Per operating system

- **macOS:**
  - The supervisor runs under a per-user launchd agent.
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
| Trial generation fails to park | The old generation was never drained and keeps serving; the handoff is reported as rolled back. |
| Trial generation fails readiness | The old generation has already exited in phase 1, so its entry is started again as a new generation. Connections wait in the backlog; the handoff is reported as rolled back. |
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
   sequential generation handoff with rollback, crash restart. The package is
   implemented; a supervised mode in the core server and adoption by
   `station start`, `service run`, and containers follow in their own pull
   requests. Handle passing must be verified on a real Windows host before
   adoption.
2. **Workloads and terminals:** workload host and journals, then the terminal
   redesign on top of it (see [terminal.md](terminal.md)).
3. **Engines:** workload-stream transport per adapter, reattach before
   interrupted-turn consumption, bounded auto-resume.
4. **Launch modes and upgrades:** Desktop as a service client with first-run
   service setup, tray as control client, archive launcher, every upgrade
   path as a handoff.
5. **Endpoint workloads:** browser-pane host and device hub move to the
   supervisor; the device hub restart loop is removed.
6. **Consolidation:** voice and consent onto the main origin; old supervisors,
   restart loops, and the UI server process removed.

## Verification

- **Handoff journey:** a real live terminal, a scripted engine turn, and an
  open browser-pane page, handed from generation N to N+1. Same PIDs, no
  sequence gap, the turn recorded exactly once, and the page still loaded.
- **Rollback journey:** generation N+1 fails readiness; the previous entry
  serves again and clients see no refused connection.
- **Compatibility:** old and new supervisors and core servers in every
  pairing, run as child processes.
- **Per OS:** journeys run on real macOS, Windows, and Linux hosts.
- **Latency:** the hop budget measured against its own baseline.
- **Fault injection:** removing reattach makes the handoff journey fail with
  an interrupted turn; removing handle passing makes a client see a refused
  connection.
- **Phase 1 evidence:** the package's real-process tests run a fixture core
  server that speaks the IPC protocol. Under keep-alive HTTP load and an SSE
  client, repeated handoffs, rollbacks, and crash restarts produce no refused
  connection, and handoffs produce no reset connection, on one port
  throughout. They do not yet cover the real core server or Windows.
