# Integrated terminal

Status: In progress under #3994. The scoped in-process foundation is implemented on this branch; a personal-operator same-origin gateway is added in part b1; paired-device/remote admission, SDK runtime, Coding cutover and Ghostty remain proposed.

> **Reading status: proposal (2026-10-17).** Replaces the current terminal
> stack end to end. The bounded implementation below precedes that replacement; the current Coding UI behavior is
> owned by [`TerminalService`](../../src-server/services/terminal/terminal-service.ts),
> the [terminal WebSocket server](../../src-server/services/terminal/terminal-ws-server.ts),
> and [`TerminalPanel`](../../src-ui/src/components/coding-layout/TerminalPanel.tsx).
> Station's implementation is written independently; no code is ported from
> other products.

## First implementation boundary (#3994, part a)

The new [TerminalSessions service](../../src-server/services/terminal/terminal-sessions.ts) owns server-generated UUIDs, immutable
Project/binding scope, realpath-confined launch directories, durable session
metadata, and sanitized sequence journals. `ShellHost` returns a process handle
whose write, resize, signal and exit operations can later proxy a supervisor
workload. [InProcessShellHost](../../src-server/services/terminal/shell-host.ts) uses the existing node-pty adapter. The [journal](../../src-server/services/terminal/terminal-journal.ts), [stream filter](../../src-server/services/terminal/terminal-output-sanitizer.ts), and [real PTY tests](../../src-server/services/terminal/__tests__/terminal-sessions.process.test.ts) own the storage/filter evidence. Journals are
owned by the service in this tranche; moving their ownership into the supervisor
and providing its list/read protocol remain later workload work.

A personal-operator HTTP control seam at
`/api/projects/:slug/terminal-sessions` exercises the production service without
shipping another emulator. It supports project bindings and `thread:<id>`
bindings resolved through the existing authorized session/worktree resolver.
Standalone worktree keys are refused until a server-owned binding resolver
exists. The API reference describes its requests and limits.

This seam admits only a current operator acting in person on a personal host.
Account, hosted, paired-device, agent and plugin access is refused. Its service
checks observe versus operate authority separately. HTTP list/journal reads
explicitly require `terminal:observe`; creation, input, resize and deletion
require `terminal:operate`. Operate also permits observing. The observe token
is explicit operator promotion only; no preset, default or existing grant is
changed. The in-person operator restriction still applies after ingress. Observer tests exercise that service
boundary with an injected authority; they do not prove pairing or remote grants.
The old socket, Coding UI, process projections, and project close endpoint
continue to use `TerminalService` and retain their existing behavior, including
#3781's connection ownership checks. This does not claim that legacy socket
commands have acquired Project-principal authorization.

Session metadata and journal output survive disposal and a new service instance;
in-process shells do not survive server exit. Restored sessions are ended and
never execute their old input again. Opening with a legacy terminal id imports
a provenance-bound history filename once and retains the mapping in the durable
record. The legacy writer emits a receipt only for a fresh file or a previously
verified receipt; it records the Project id captured when the shell opened,
original session id and
a digest of the bytes. A pre-existing raw file is never retroactively assigned
an owner on rewrite. Unowned files, a wrong first claimant, colliding old
filenames, changed receipt bytes and interrupted imports are refused. Existing
unowned history stays on disk for explicit ownership recovery, which remains
follow-up work. Stored browser tabs
are not migrated by this tranche.

The journal retains known cursor, editing, scrolling, SGR, mode, charset, title
and hyperlink controls. Other control functions, including DCS graphics,
clipboard/palette extensions and terminal queries/replies, are omitted. ESC and
C1 introducers restart pending parsing consistently, including across callbacks.
This conservative rendering subset is not full VT/emulator fidelity; extending
it requires a rendering contract and security review.

Journal limits are constructor configuration: disk defaults to 16 MiB and 5,000
lines; memory to 2 MiB and 5,000 lines, with 64 KiB disk segments. Whole records
and oldest segments are evicted, so retained history can be smaller than a limit.
`persist: false` keeps only the memory tail. Output records never split Unicode
code points. A resume older than retained output reports `reset`; the caller
must replace its replay. Reads serialize with appends and compaction. Ordinary PTY
bursts pause read delivery at half of the bounded writer capacity and resume
below a quarter. Queued callbacks coalesce into segment appends; reads seal
the pending batch and remain ordered between surrounding appends. A genuine
storage failure ends the session instead of silently dropping output.
Incomplete/corrupt disk segments make that journal unavailable. A 1 MiB writer
queue bounds pending output. NodePtyProcess forwards node-pty pause/resume;
a backend that ignores backpressure or an explicitly undersized queue can
still exceed that hard bound. Such overload is latched and uses the same owned
HUP-to-KILL escalation as close. This is distinct from an ordinary burst under
default limits. The real PTY suite sends 8 MiB through disk and memory modes,
checks continued shell life and retained bounds, then recreates the disk-backed
service and reads its journal after clean disposal. This provides
filesystem persistence across service recreation, not power-loss qualification.

The Settings controls for persistence/location, age and aggregate retention,
clear-history actions, supervisor survival, doctor reporting, explicit restart,
and command sessions remain follow-ups within phase 1. Part b1 adds the personal-operator socket below.
Part b2 retains remote egress changes, SDK runtime and Coding cutover. Ghostty remains
phase 3; no interim TerminalView is introduced.

## Transport implementation boundary (#3994, part b1)

[TerminalGateway](../../src-server/services/terminal/terminal-gateway.ts) mounts
`/api/terminal/socket` on the main API listener through the
[Station Hono provider](../../src-server/runtime/frameworks/voltagent-hono-runtime.ts).
Every connection, including loopback, must pass the existing first-frame auth
protocol. The runtime sends its credential through the normal HTTP admission
pipeline and retains that authenticated Request for per-operation checks.
This tranche admits only the current personal operator in person, as part (a)
does. Account, hosted, paired-device, agent and plugin admission stays refused.
No request-supplied principal, cwd or executable is accepted.

[TerminalChannelConnection](../../src-server/services/terminal/terminal-channel-connection.ts)
serializes open, attach, list, input, resize, close and detach. Only adjacent
resizes on the same channel coalesce; input and lifecycle commands are barriers.
Restart is refused until the session service owns explicit restart semantics.
The [wire contract](../../packages/contracts/src/terminal-transport.ts) carries
input/output as UTF-8 binary frames with a 13-byte header (one-byte kind,
four-byte channel, eight-byte sequence, big-endian). JSON controls and the
bounded credit protocol are described in the [API reference](../reference/api.md#terminal-socket-personal-operator-transport).

The journal remains the single output source. Invalidation subscribes before
attach reads, and reads serialize with appends/compaction. Gateway reads are
paged to 64 KiB; live and replay output both use the journal's sanitizer.
A retained resume sends only records after `fromSeq`. Lost retention sends an
explicit reset after outstanding output drains. Clients must acknowledge
replay before input is accepted. Input sequences start at one on each new
channel; duplicate or skipped input is refused. Input is never retried by the
server, and channel ids cannot be reused on a socket. A reconnect replays only
output; callers must not resend input with an uncertain outcome.

`terminal:observe`, added by the part (a) ingress hardening, uses explicit operator
promotion only. No default grant, preset or stored credential gains it. The
shared scope predicate permits observe to read and operate to read/write;
the production personal-operator gate remains an additional restriction.
The [real-socket suite](../../src-server/services/terminal/__tests__/terminal-gateway.process.test.ts)
uses injected identities and current grants with real PTYs. Its observer and
revocation evidence qualifies that gateway/service boundary, not live pairing.
The listener integration suite proves the registered gateway mounts and stops
on the API listener. Windows/ConPTY and remote/native routes remain unqualified.

The proposed split stops this review at b1. Part b2 owns Project/principal
admission for paired devices, remote relay/broker egress and its threat model,
the SDK session store and public-entry proof, Coding's xterm adapter and saved
terminal migration. The legacy listener, port discovery, Coding UI, saved tabs,
process projections and close endpoint remain on TerminalService until that
cutover. A Coding render before b2 can qualify only legacy compatibility.

### Whole-store retention and process custody

The service reserves each retained record's configured journal disk limit and
raw in-memory tail limit against whole-store budgets (defaults: 1 GiB disk,
64 MiB of raw tail payload and 32 records). The smallest budget-derived slot
count governs admission; a single journal that cannot fit is refused. These
are core constructor controls, not shipped Settings controls or a measured
process-RSS bound. With the default per-journal limits, at most 32 journal
instances/tails and 512 MiB of journal files can be retained.

When a slot is needed, the oldest ended or failed record eligible for the
caller's operate authority expires: its journal and cache entry are discarded
and its metadata is removed. Live/stopping sessions are pinned. Closed/failed
records therefore do not consume admission forever. A caller cannot evict
another Project/binding it cannot operate. Startup applies the same fixed
retention policy as trusted store maintenance, including to older homes with
more records or larger previous per-journal settings. Expired UUIDs are refused;
retention does not implicitly launch a replacement. Legacy raw history retains
its separate migration ownership and limits.

The [node-pty backend](../../src-server/adapters/node-pty-adapter.ts) now exposes
an owned termination operation. On POSIX it uses a bounded process census,
freezes the PTY leader and each discovered descendant process group, then kills
the quiescent groups with children before parents. Job-control groups, nohup
and HUP-ignoring jobs no longer rely on the shell's HUP handler. Cleanup
failures are reported; missing census support cannot become successful close.
Adapters without this operation retain the owned handle's HUP/KILL fallback.
The real PTY tests qualify macOS cleanup of the tested descendants. Windows,
other POSIX hosts and already-daemonized workloads are not newly qualified;
supervisor workload custody remains the route to stronger survival/cleanup.

### Replay controls before Ghostty

The transport applies a second streaming filter to stored and live output.
OSC 8 hyperlinks admit only absolute `http:` and `https:` URLs; `file:`,
`javascript:`, malformed URLs and URI control bytes are omitted while link text
remains visible. Filtering preserves journal sequence identities. Credit is
charged for transmitted bytes, and parser state advances only after a record
fits. The minimum window is 16 KiB so a buffered allowed rendering control can
complete inside one credit window.

A current observer's complete mouse/focus reports are acknowledged as discarded,
including while replaying. They never reach the shell. Ordinary observer input
and all observer lifecycle mutations remain refused. Fragmented or unsupported
reports are refused rather than forwarded. Permission checks still use the
stored session's Project/binding and the current authority.

Ghostty must treat OSC 0/1/2 titles as untrusted terminal state, never as HTML,
a Station identity, browser navigation or native-window authority; replay must
not overwrite application chrome. ESC c reset, CSI repeat counts and mouse,
focus and paste modes remain part of the conservative rendering subset. The
Ghostty adapter needs bounded parsing/rendering work, an explicit reset/title
contract and detached reply/report writers during replay. This tranche does
not qualify those emulator behaviors or establish full VT fidelity.

## Why

The terminal is a core surface, not a Coding-layout accessory. The legacy
Coding stack motivates the replacement:

- #3781 confines output and commands to sessions opened on the connection;
  opening a session still lacks a Project-principal authorization seam.
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

## Design principles

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
- Ghostty's official `libghostty-vt` emulator compiled to WebAssembly, with
  a Station-owned browser surface (input, IME, selection, links, rendering).
- Splits and groups kept in a per-binding server record reconciled against
  the live session list, keep-mounted recent drawers.
- "Add to chat" as a composer chip with line ranges; URL and `path:line:col`
  links routed to the preview pane and the editor.
- Script runs whose completion is detected by a per-run random end marker
  that output cannot forge.

## Performance and capability targets

| Concern | Station design |
| --- | --- |
| Reattach cost | Resume from the client's last sequence number; a full snapshot only when the journal no longer covers it |
| History writes | Append-only journal segments with background compaction; never a whole-file rewrite |
| Input and output encoding | Coalesced input and binary frames on one multiplexed socket; no JSON-escaped terminal data |
| Server restarts | Shells are supervisor workloads that outlive core server restarts and upgrades |
| Changing a session's cwd or environment | An explicit restart that keeps earlier history as a prior segment |
| Finding text | Search over the emulator's scrollback |
| Agent use | Shared-terminal read and visible run tools behind approval |

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
reboot. After a reboot, Station restores instead: the server record reopens
the same terminals, groups, and splits, and the pane workspace restores where
they are shown. The terminals reopen in the same working directories with their journals shown
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

Every session has a server-generated `terminalId` that is unique across the
instance; today's ids are unique only within a project and are replaced. The
session also records `(projectId, bindingKey)`, its authorization scope, where
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

`@kontourai/station-sdk` exports the whole client terminal:

- A terminal session store that owns sockets, channels, sequence tracking,
  the bounded client buffer, and command serialization (lifecycle commands in
  order, resize latest-wins). UI components subscribe to it; React state
  never enters the render loop.
- The terminal view component: the emulator adapter below, its input, and
  its accessibility mirror.

The Coding layout uses only this public surface and the `terminal` pane
target described under Plugins, the same surface a plugin gets. A boundary test fails if anything
under `src-ui/src/components/coding-layout/` imports terminal internals. A
sample plugin opens and renders a terminal pane, which proves the parity.

### Emulator

Station writes its own browser adapter for Ghostty's official
`libghostty-vt` C ABI, independently and from Ghostty's public headers and
documentation. The WebAssembly is built from a pinned Ghostty revision by a
reproducible Zig script, committed as a vendored asset with Ghostty's MIT
license, and its revision is checked by a test. The adapter owns:

- A per-terminal handle over the C ABI and a render snapshot of rows and
  styles.
- A renderer that batches backgrounds and style runs per frame, with React
  state kept out of the render loop.
- Browser input: keyboard encoding, IME and composition, paste, mouse
  reporting, selection with multi-click, wheel and scrollbar, and focus.
- Terminal replies (device attributes, status reports) written back to the
  PTY, detached while replaying a journal.
- A symbols-only Nerd Font loaded lazily so prompt glyphs render without a
  local install.

Station additions on top:

- Themes from `--k-*` tokens, following light and dark changes.
- Find in terminal.
- Station link routing: URLs to the browser pane, paths to the editor pane.
- Context menu: Copy, Paste, Select all, Add to chat, Jump to latest, Clear.
- Mobile webview: the existing key toolbar, with Ctrl as a sticky modifier.

Native mobile terminal views are out of scope; Station's mobile app renders
the web surface.

#### Accessibility

A canvas-rendered terminal is invisible to assistive technology unless the
adapter exposes its text separately. xterm.js's screen reader mode covers
this today, so shipping the Ghostty surface without an equivalent would be a
regression. The emulator phase does not ship until this exists:

- **Accessible output buffer.** A visually hidden, focusable text mirror of
  the screen and scrollback, built from the emulator's rows (not from raw
  bytes), so cursor movement and redraws produce the text a sighted user
  sees. Screen reader users navigate it line by line and character by
  character.
- **Announcements.** New output is announced through a polite live region,
  coalesced and rate-limited so a flooding command does not drown the
  reader. Bell, shell exit, and a finished script run are announced.
- **Screen reader mode** in terminal settings, defaulting on when the
  operating system reports a screen reader. When off, the mirror is not
  kept, so sighted users pay nothing for it.
- **Keyboard parity.** Everything in the context menu, find, links, splits,
  and the drawer is reachable from the keyboard, with visible focus and
  shortcuts listed in the shortcut registry. Focus can always leave the
  terminal with a documented key, since the terminal otherwise captures Tab.
- **Contrast and motion.** Theme colors meet the design system's contrast
  rules in light and dark; cursor blink follows reduced-motion settings.
- **Mobile.** The mirror works with VoiceOver and TalkBack in the mobile
  webview.

### Layout

- A `terminal` pane descriptor usable in any layout region, plus a standalone
  terminal route.
- The Coding layout keeps a resizable lower drawer with tabs, groups, and up
  to four splits per group.
- State has two owners, and no field is written by both:
  - **Presentation** belongs to the pane workspace contract (#3875): whether
    the terminal pane or drawer is shown, where, its toggles, and its size or
    height. Coding's panel writer and the region arrangement keep these.
  - **Content** belongs to the terminal server record, stored per binding and
    reconciled with the live session list: which terminals and groups exist,
    the split arrangement and sizes inside the terminal pane, and the active
    terminal. This replaces the unscoped `coding-terminal-tabs`
    sessionStorage key.
- Terminal identity is the server's `terminalId`. Presentation state is keyed
  by Station and `terminalId`, never by a pane key. The pane keys
  `workspace-coding-terminal` and `pane:builtin:coding:terminal` become
  presentation aliases that resolve to the binding's terminal group; nothing
  infers a process from equal pane keys.
- Default shortcuts: toggle drawer, new terminal, split, split vertical,
  close, find. Registered in the shortcut registry so they appear in the
  shortcut list.

### Plugins

A plugin opens a terminal through the pane workspace's open, reveal, and
close capability. The pane relationships contract (#3875) specifies it; it is
not yet implemented. The terminal is a closed built-in target rather than a
plugin-supplied key:

- The target shape is plain data declared in the pane host contract,
  `{ kind: 'terminal'; binding; terminalId?; new?: { profile? } }`, where
  `binding` is a session's `bindingKey`. The terminal contracts module
  re-exports it. It carries no working directory: the server decides the cwd
  from the binding.
- The pane host stamps the opener, the exact Station, and the occurrence's
  captured context. The binding, and the session of any `terminalId`, must
  fall inside that captured Project on that Station. Otherwise the open is
  reported as the contract's context mismatch, so a plugin cannot name a
  thread in another project even where it holds a grant.
- Station's terminal host binding then checks the caller's own grants for
  that project. Creating a terminal (`new`) needs `terminal:operate`. Opening
  an existing `terminalId` needs `terminal:observe` and is read-only unless
  the caller also holds `terminal:operate`. Holding a pane or plugin grant
  never implies terminal access.
- The pane host reports the outcome (opened, focused, replaced, unavailable,
  or context mismatch) in the same form it uses for its other targets.

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
| `DELETE /api/projects/:slug/terminals/:terminalId` | Kept, backed by the new session store; the server rejects an id whose session is not in `:slug` |
| Project-scoped terminal ids | Mapped once to new instance-unique ids when their history and stored tabs are imported |
| `/api/orchestration/processes/terminals*` and `TerminalProcessSummary`/`Detail` | Re-pointed at the journal; contract shapes kept |
| `POST /api/coding/exec` fallback | Kept for hosts without node-pty |
| `PAIRING_SCOPE_TERMINAL_OPERATE` | Kept; `terminal:observe` added |
| `terminalShell` setting, `TerminalCapability`, system-status `terminal` | Kept |
| `coding-terminal-*` sessionStorage keys | Content (tabs, active terminal) migrated once into the server record; presentation (open, height) imported once by Coding's panel writer; then ignored |
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
3. **Emulator:** Station's Ghostty adapter, theming, find, links, context menu, and the
   accessibility requirements above.
4. **Layout:** terminal pane, standalone route, Coding drawer with groups and
   splits on the pane workspace's presentation seams, server-side content
   state, shortcuts, the SDK view export with its boundary test, the terminal
   pane target, and the sample plugin. The pane target and the sample plugin
   depend on the pane workspace capability specified in #3875, which is not
   yet implemented.
5. **Agent integration:** add to chat, script runner, agent tools.
6. **Removal:** old listener, endpoints, client components, and the dead
   `.coding-terminal-fallback` end-to-end check; documentation and the
   decision record.

## Verification

- Server: attach without gaps under concurrent output; resume from a sequence;
  journal sanitizing; cross-session and cross-project isolation; kill
  escalation; core server handoff with a live shell, run as child
  processes.
- Client: adapter suites (C ABI layout against the pinned revision, input
  encoding, selection, rendering, reply handling), plus resume and flow-control tests
  against a real server.
- Accessibility: automated checks that the mirror matches rendered rows after
  cursor-addressed redraws, that announcements are coalesced under load, and
  that focus can leave the terminal; a manual pass with VoiceOver on macOS
  and iOS, NVDA on Windows, and TalkBack on Android before the emulator phase
  merges.
- End to end: open, reload, restart the server, and confirm the same shell
  (same PID) and no lost output; repeat on the mobile webview and Windows.
- Fault injection for each isolation check and for the query stripping.

## Open questions

1. Retention defaults, once usage is measured.
