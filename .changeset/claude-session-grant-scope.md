---
'@kontourai/station-shared': minor
---

Say what an approval's "for this session" answer grants (#2915, #2916).
`tool-request-preview` adds `toolRequestSessionGrant` and
`toolRequestSessionGrantFromPayload`, which compute a
`ToolRequestSessionGrant` (`tool`, `edit-mode`, `read-folder`, `folder` or
`none`) from a request's tool name, suggestions, blocked path and matched ask
rule, and from the engine's permission mode (a file edit in `plan` or
`bypassPermissions` offers none). It also adds
`sessionGrantPermissionUpdates`, which returns the suggestions each grant
forwards, and `directoryPermissionUpdateKind`.
`toolRequestGrantLabel(toolName, grant)` now takes the grant as a required
second argument and returns `undefined` when no session grant is offered.
Callers that passed only a tool name must compute the grant first. The
conversation `MessagePart` gains an optional `approvalSessionGrant`, set by
the runtime event projection on a part bound to an open request.
