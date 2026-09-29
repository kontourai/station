# Whole Task Basis MCP App

Station serves the read-only `station-control/get_task_basis` portable App at
`ui://station/basis/task/v3`. It is self-contained with network-denying CSP and
is available only in Station web hosts; native shells keep the native Basis pane.

A private code-issued read session binds each page to the exact Task,
authenticated caller, and read authority. Result metadata carries opaque
occurrence and continuation values only for the matching session. Tokens rotate,
expire, and are revoked through the host's teardown request. Failed teardown
requests still have the server's expiry bound. The App replaces bounded pages rather than
accumulating protected data. Missing, stale, revoked, malformed, or failed
state is generic unavailable, never an inferred empty or partial collection.

Station owns task collection chrome and selected-answer identity. Surface owns
all selected answer Basis semantics. Whole Task has no aggregate standing.
Pages carry separate bounded streams for answers, retained task records, kept
tool results, and Flow-owned kept gate evaluations. An exact association to an
answer on another page is labelled
as such; it is never described as a missing association. An empty association
list means no association with a currently available answer, not proof that no
historical or restricted answer exists.

The [read owner](../../src-server/services/projects/task-basis-app-read-module.ts)
admits at most 128 active sessions, 16 per caller, with a five-minute expiry
renewed by each successful page. Each page has a 120 KiB budget. The owner
rereads authority and collection state before publication; a semantic collection
change invalidates its continuation rather than mixing snapshots. Hosted tenant
authority is currently unavailable on this path.

[BasisMcpWorkspacePane](../../src-ui/src/workspace-panes/BasisMcpWorkspacePane.tsx)
supplies the narrow host adapter to
[MCPToolUIFrame](../../src-ui/src/components/mcp-ui/MCPToolUIFrame.tsx).
The iframe asks that adapter for pages; its CSP blocks direct network access.
Ordinary read-only App calls do not gain this special Task capability. The
[route](../../src-server/routes/orchestration/tasks.ts) rechecks current
principal and returned Session identities after owner reads.
[Owner boundary tests](../../src-server/services/projects/__tests__/task-basis-app-read-module.boundaries.test.ts)
and [route tests](../../src-server/routes/orchestration/__tests__/task-basis-app.routes.test.ts)
cover stale tokens, changed authority and unavailable reads.
