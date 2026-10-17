# Integrated terminal

> **Reading status: proposal (2026-10-17).** Replaces the current terminal
> stack end to end. Nothing here is implemented yet; the current behavior is
> owned by [`TerminalService`](../../src-server/services/terminal/terminal-service.ts),
> the [terminal WebSocket server](../../src-server/services/terminal/terminal-ws-server.ts),
> and [`TerminalPanel`](../../src-ui/src/components/coding-layout/TerminalPanel.tsx).
> Prior art was read at pingdotgg/t3code `13aa882c2`; claims about it are from
> source inspection, not execution.

## Why

The terminal is a core surface, not a Coding-layout accessory. The current
stack has structural problems that incremental fixes would not remove:

- Output fans out to every connected socket, and commands act on any session
  ID a socket names (stopgap fix tracked separately; this design removes the
  shape that allowed it).
- A second listener on `port + 1` breaks same-origin proxies and the relay.
- Shells die 60 seconds after their last viewer leaves; the client never
  reconnects on its own.
- History is a raw string split on `\n`, rewritten whole on every chunk, and
  replayed with terminal queries intact, so a reattach can type junk at the
  prompt.
- The working directory is whatever the client sends.
- xterm.js runs with only the fit addon and a hard-coded palette.
- Terminals belong to no thread, chat, or worktree, and the agent cannot use
  them.

## Goals

1. A terminal is a first-class pane in any layout, with a fuller drawer in the
   Coding layout.
2. Shells survive page reloads, network drops, and Station server restarts.
3. Reattach is gapless and costs only what the client missed.
4. The server, not the client, decides where a shell runs.
5. The agent can read a terminal the user shares and run commands in a
   terminal the user can see, under the normal approval posture.
6. One emulator everywhere Station renders a terminal: desktop, browser, and
   the mobile webview.

## What we take from t3code

Adopted, with Station names:

- Server-owned sessions behind a PTY adapter, with ordered per-session event
  queues and kill escalation that subscribes to exit before signalling.
- Subscribe-then-snapshot attach: buffer live events, send the snapshot,
  flush the buffer dropping anything already covered. No lost or doubled
  output.
- Separate operate and observe scopes; observers get a read-only surface.
- History bounded by both lines and bytes, never splitting a code point, with
  terminal query/reply sequences (DA, DSR, DECRQM, XTVERSION, kitty keyboard,
  OSC 10/11/12) stripped before storage, and the reply writer detached while
  replaying.
- One shared process-table poll for subprocess activity instead of a
  per-terminal `execSync`.
- Shell resolution with fallback only on not-found errors; zsh
  `-o nopromptsp`; `COLORTERM=truecolor`; scrubbed server-private variables.
- The `libghostty-vt` WebAssembly emulator and its browser surface (input,
  IME, selection, links, Canvas renderer), ported with attribution (both
  projects are MIT).
- Splits and groups, thread-scoped layout reconciled against the server's
  session list, keep-mounted recent drawers.
- "Add to chat" as a composer chip with line ranges; URL and `path:line:col`
  links routed to the preview pane and the editor.
- Script runs whose completion is detected by a per-run random end marker
  that output cannot forge.

## Where we go further

| t3code limitation | Station design |
| --- | --- |
| Every attach resends up to 8 MiB of history | Resume from the client's last sequence number; full snapshot only when the journal no longer covers it |
| Whole history file rewritten every 250 ms while busy | Append-only journal segments with background compaction |
| One RPC per keystroke, JSON strings | Coalesced input, binary frames on one multiplexed socket |
| Shells die with the server | Shells are supervisor workloads that outlive core server restarts and upgrades |
| Re-opening with a changed cwd or env silently wipes history | Explicit restart with history kept as a prior segment |
| No find in terminal | Search over the emulator's scrollback |
| Agent cannot read or drive terminals | Shared-terminal read and visible run tools behind approval |

## Architecture

```text
 Ghostty surface (WASM)  ──┐
 Ghostty surface (WASM)  ──┼─ client terminal runtime (SDK) ── one WebSocket ──┐
 mobile webview surface  ──┘                                                   │
                                                  Station server (same origin) │
                                     TerminalGateway ◄─────────────────────────┘
                                            │ authorize, route by channel
                                     TerminalSessions (identity, binding, cwd authority)
                                            │ ShellHost interface
                          ┌─────────────────┴─────────────────┐
                 InProcessShellHost                  SupervisorShellHost
                                                           │ workload protocol
                                                  Station supervisor
                                                  (PTYs, journals)
```

### Shell host

Terminals are workloads of the
[Station process supervisor](process-supervisor.md). The supervisor creates
every PTY, owns it for its whole life, and journals its output, so a shell
survives a core server restart or upgrade. On Windows this is required as
well as useful: a ConPTY cannot be handed to a new parent.

`ShellHost` is the core server's interface to those workloads: spawn, write,
resize, signal, list, and journal reads. Two implementations:

- **Supervisor** talks to the supervisor's workload protocol. This is the
  default once the supervisor ships.
- **In-process** runs node-pty inside the core server. Tests use it, and it
  is the fallback when no supervisor is present.

The supervisor survives a core server restart or upgrade, not a machine
reboot. After a reboot, Station restores the layout instead: the same
terminals reopen in the same working directories with their journals shown
above a "restored after restart" divider. Nothing is re-run automatically.

#### Session kinds

The supervisor runs two kinds of terminal session, both journaled and
visible in the UI:

- **Interactive** is a PTY: user shells and interactive agent CLI tabs. Both
  survive server restarts.
- **Command** runs without a PTY by default (no colors, pagers, or isatty
  prompts unless the caller asks), with an output cap. Agent-requested
  commands (ACP terminal create, output, wait, kill) use this kind, so the
  user can watch them and take over. Their journals are kept for the
  owning turn. They outlive a core server restart together with the engine
  that started them (see engine reattach in the supervisor design).

Policy, authorization, and binding live in the core server; the supervisor
only spawns, relays bytes, and writes journals.

### Sessions

A session's identity is `(projectId, bindingKey, terminalId)`, where
`bindingKey` is a thread, a worktree, or the project itself. The server
resolves the working directory from the binding: thread worktree, else the
configured project working directory. A client may request a subdirectory,
which is accepted only if it resolves inside that root. Every operation
authorizes the caller's principal against the session's project, so a socket
can never act on a session it was not granted.

Restart and cwd changes are explicit operations. They end the shell and open
a new journal segment; earlier segments stay readable.

### Journal

Each session writes an append-only journal of numbered output records.
Sanitizing (query stripping) happens before a record is numbered, so every
reader sees the same stream. The supervisor keeps a bounded in-memory tail (lines
and bytes) and appends segments to disk; compaction trims segments past the
retention limit. Attach asks for `fromSeq`: served from the tail when
covered, from disk when not, and a fresh snapshot otherwise.

Retention is configurable in Settings, with these controls:

| Setting | Default | Notes |
| --- | --- | --- |
| Keep terminal history | On | Off keeps only the in-memory tail; nothing is written to disk |
| Storage location | `<home>/terminal-journals` | Any local directory; moving it migrates existing journals |
| Maximum age | 30 days | Journals of closed terminals older than this are deleted |
| Maximum size per terminal | 16 MiB | Oldest segments are compacted away first |
| Maximum total size | 1 GiB | Least recently attached terminals are trimmed first |

Settings shows current usage and a clear-history action per project and for
everything. Each limit has a rejection path: a value outside its allowed
range is refused, not clamped. Defaults are starting points to tune once real
usage is measured.

### Transport

One authenticated WebSocket per client at `/api/terminal/socket` on the main
origin, multiplexing every terminal the client has open as channels. This
costs one of the browser's per-origin HTTP/1.1 connections (see
[ADR 0018](../adr/0018-sse-is-the-realtime-transport-because-resume-rides-last-event-id.md))
and retires `port + 1` and `GET /api/system/terminal-port`. Auth uses the
existing first-frame gate and pairing scopes, with `terminal:operate` joined
by a new `terminal:observe`.

- Control messages are small JSON frames (attach, detach, resize, restart,
  close, list, error).
- Output and input are binary frames: a fixed header (kind, channel, sequence)
  followed by raw bytes. No JSON-escaping of terminal data.
- Input is coalesced per animation frame on the client.
- Flow control is a per-channel credit window acknowledged by the client, so
  a flooding shell cannot starve other channels or grow server memory.
- Reconnect is automatic with backoff, and every channel resumes from its
  last acknowledged sequence.

A decision record will supersede the terminal exception in ADR 0018 when the
transport lands.

#### Remote devices

Terminals work fully over every route Station serves, including the relay
and broker, governed only by permissions. A paired device or principal gets
what its scopes grant: `terminal:observe` to watch, `terminal:operate` to
type, resize, restart, and close, each checked per project. The relay and
broker carry the terminal socket like any other authenticated stream; their
current refusal of raw terminal egress is replaced by this scope check. The
remote-access threat model is updated with the new egress before the relay
route ships.

### Client runtime

A terminal session store in `@kontourai/station-sdk` owns sockets, channels, sequence
tracking, the bounded client buffer, and command serialization (lifecycle
commands in order, resize latest-wins). UI components subscribe to it; React
state never enters the render loop.

### Emulator

Port t3code's `libghostty-vt` browser adapter into `src-ui` with its tests,
pinned to the same Ghostty revision, built by a reproducible Zig script with
the WebAssembly committed as a vendored asset and its revision checked by a
test. Additions:

- Themes from `--k-*` tokens, following light and dark changes.
- Find in terminal.
- Station link routing: URLs to the browser pane, paths to the editor pane.
- Context menu: Copy, Paste, Select all, Add to chat, Jump to latest, Clear.
- Mobile webview: the existing key toolbar, with Ctrl as a sticky modifier.

Native mobile terminal views are out of scope; Station's mobile app renders
the web surface.

### Layout

- A `terminal` pane descriptor usable in any layout region, plus a standalone
  terminal route.
- The Coding layout keeps a resizable lower drawer with tabs, groups, and up
  to four splits per group.
- Layout state (open, height, groups, active terminal) is stored per binding
  on the server and reconciled with the live session list. This replaces the
  unscoped `coding-terminal-tabs` sessionStorage key.
- Default shortcuts: toggle drawer, new terminal, split, split vertical,
  close, find. Registered in the shortcut registry so they appear in the
  shortcut list.

### Agent integration

- **Add to chat** attaches a selection with its line range and cwd, through
  the existing credential scan.
- **Script runner** runs project scripts and chat code blocks in a visible
  terminal, opening a new one if the active terminal is busy, and reports
  exit codes through the end marker.
- **Agent tools:**
  - Read a terminal: only a terminal the user has shared with the thread;
    returns sanitized journal ranges.
  - Run in a terminal: types into a visible terminal and waits for the
    marker, subject to the thread's approval posture.

  Both are recorded in the thread's activity.

## Migration

| Current surface | Outcome |
| --- | --- |
| `port + 1` WebSocket, `GET /api/system/terminal-port`, SDK `fetchTerminalPort` | Removed after the new socket ships |
| `DELETE /api/projects/:slug/terminals/:terminalId` | Kept, backed by the new session store |
| `/api/orchestration/processes/terminals*` and `TerminalProcessSummary`/`Detail` | Re-pointed at the journal; contract shapes kept |
| `POST /api/coding/exec` fallback | Kept for hosts without node-pty |
| `PAIRING_SCOPE_TERMINAL_OPERATE` | Kept; `terminal:observe` added |
| `terminalShell` setting, `TerminalCapability`, system-status `terminal` | Kept |
| `coding-terminal-*` sessionStorage keys | Migrated once into server layout state, then ignored |
| `terminal-history/<id>.txt` | Imported as a first journal segment on first attach |
| `pane:builtin:coding:terminal` | Kept as an alias of the new terminal pane |
| `station.terminal.operations` metric, `station doctor` PTY probe | Kept; doctor also reports shell hosts |
| ACP agent interactive tabs | Interactive supervisor workloads |
| ACP agent terminal commands | Command supervisor workloads |

## Delivery

Each phase is its own lane and pull request, with independent review and
verification.

1. **Shell host and sessions:** `ShellHost` with both implementations,
   both session kinds, cwd authority, journal, retention settings, layout
   restore after reboot, and doctor support. Depends on the supervisor's
   workload phase; the in-process host lets this phase start in parallel.
2. **Transport and client runtime:** multiplexed socket, resume, flow
   control, observe scope, relay and broker routes, SDK store.
3. **Emulator:** Ghostty port, theming, find, links, context menu.
4. **Layout:** terminal pane, standalone route, Coding drawer with groups and
   splits, server-side layout state, shortcuts.
5. **Agent integration:** add to chat, script runner, agent tools.
6. **Removal:** old listener, endpoints, client components, and the dead
   `.coding-terminal-fallback` end-to-end check; documentation and the
   decision record.

## Verification

- Server: attach without gaps under concurrent output; resume from a sequence;
  journal sanitizing; cross-session and cross-project isolation; kill
  escalation; core server handoff with a live shell, run as child
  processes.
- Client: the ported Ghostty suites, plus resume and flow-control tests
  against a real server.
- End to end: open, reload, restart the server, and confirm the same shell
  (same PID) and no lost output; repeat on the mobile webview and Windows.
- Fault injection for each isolation check and for the query stripping.

## Open questions

1. Retention defaults, once usage is measured.
