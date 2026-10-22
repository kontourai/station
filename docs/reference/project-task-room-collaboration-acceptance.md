# Project/Task room collaboration acceptance

`tests/project-task-room-collaboration.spec.ts` is the real-browser acceptance
lane for the personal Station Task room. It starts an isolated production
server/UI, creates a Project and Task through shipped HTTP/UI entry points,
pairs a second browser as a distinct device, and uses the rendered Task
workspace rather than injected pane props.

When it passes, the lane checks both browsers receive the same server-owned room generation;
implicit join and durable publication; symmetric named presence; autosave;
watch/follow fixture commands and local-input stop; exact revision-bound cursor/selection projection; message and
document convergence over the shared SSE connection; revoked-device cached
read-only behavior; immutable revision links in Details; and same-home SQLite
restoration after a full server restart. Reconnect checks the selected Brief tab
and converged preview before explicitly reopening the editor. It does not claim
draft or edit-mode continuity across authority re-verification. After restart,
the fixture waits for the viewer's published presence before issuing heartbeat;
recovered live snapshots must contain no old cursors or follow panes.

Chat and Brief are exercised through normal user actions. Retained watch/follow
protocol setup uses explicitly named real HTTP fixture commands because those
controls are not on the primary chat surface. The lane is not a claim that a
human watch/follow picker is currently shipped there.

The browser contract deliberately does not expose CRDT operations, writer
epochs, raw live-work receipts, document IDs, channels, recovery state, or
SQLite. Cursor state is ephemeral: the runtime binds it to the current Task,
derived document, room generation, and working revision; bounds selection,
rate, count, and TTL; reauthorizes every publication/delivery; and never writes
it to room history or recovery.

The lane also checks an authoritative Agent edit and its Session/Run links.
The private, non-HTTP
[acceptance control](../../src-server/runtime/diagnostics/task-room-acceptance-control.ts)
asks runtime composition to dispatch the Task, then calls
[publishAgentDocumentEdit](../../src-server/services/orchestration/project-task-room-runtime.ts)
with that dispatch's actual Session association. Its `task-dispatch` provider
uses the [seeded Session branch](../../src-server/services/projects/task-graph-service.ts),
so it does not start an external Agent runtime. Both browsers must show the
new text and links, which must survive restart. The fixture supplies the edit
text; this checks attribution and persistence, not an external model deciding
what to write. It does not forge Agent attribution in pane props or browser
room records.

Run the focused browser proof with:

```sh
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright test tests/project-task-room-collaboration.spec.ts --project=chromium --workers=1
```

The helper starts an isolated Station home and ports with deterministic E2E
readiness and a private control socket. This is a production server/UI fixture,
not proof of a deployed Station or native device. Keep the run's revision,
result and screenshots with any acceptance claim.

The #2892 synthetic command remains smoke evidence only. Reference performance
is verified only by the named Windows production target and bridge
described in `interactive-workspace-performance.md`; an absent target or bridge
is `NOT_VERIFIED`, never a substitute PASS.
