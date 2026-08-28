# Project/Task room collaboration acceptance

`tests/project-task-room-collaboration.spec.ts` is the real-browser acceptance
lane for the personal Station Task room. It starts an isolated production
server/UI, creates a Project and Task through shipped HTTP/UI entry points,
pairs a second browser as a distinct device, and uses the rendered Task
workspace rather than injected pane props.

The lane proves both browsers receive the same server-owned room generation;
join and durable announce; symmetric published presence; watch, follow, and
local-input stop; exact revision-bound cursor/selection projection; message and
document convergence over the shared SSE connection; revoked-device cached
read-only behavior; immutable revision-link presentation; and same-home SQLite
restoration after a full server restart.

The browser contract deliberately does not expose CRDT operations, writer
epochs, raw live-work receipts, document IDs, channels, recovery state, or
SQLite. Cursor state is ephemeral: the runtime binds it to the current Task,
derived document, room generation, and working revision; bounds selection,
rate, count, and TTL; reauthorizes every publication/delivery; and never writes
it to room history or recovery.

Agent participant session/run links are rendered when the authoritative live
participant is an agent. A real agent-authored edit remains `NOT_VERIFIED` in
this browser lane: creating that evidence requires an actually associated
agent session/run and dispatch receipt. Tests must not forge agent attribution
through pane props or browser-authored room records.

Run the focused browser proof with:

```sh
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright test tests/project-task-room-collaboration.spec.ts --project=chromium --workers=1
```

The #2892 synthetic command remains smoke evidence only. Reference performance
is verified only by the named Windows production target and bridge
described in `interactive-workspace-performance.md`; an absent target or bridge
is `NOT_VERIFIED`, never a substitute PASS.
