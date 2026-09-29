# Work Board security boundary

Work Board is a first-party Workspace Pane. Opening it does not select it as
Home. The current [Home-role eligibility contract](../../packages/contracts/src/workspace-home-role.ts)
admits standalone plugin-component descriptors, so the built-in Work Board
does not qualify through that grant path. A future Home integration must use
an explicit authority contract; the built-in Home remains the recovery floor.

The Pane is a trusted React renderer in the application realm, selected by the
[built-in registry](../../src-ui/src/workspace-panes/builtinWorkspacePaneRegistry.tsx).
The [Pane frame](../../src-ui/src/workspace-panes/WorkspacePaneFrame.tsx) catches
rendering failures; this is an error boundary, not an iframe/process sandbox
against malicious code. The separate granted-Home recovery path can show the
built-in Home with a reason and explicit retry/revoke actions; it does not
silently rewrite the grant or repeatedly retry a broken renderer.

The Board persists identity-only work references plus its own title, camera,
pin geometry/order and bounded undo metadata. Its
read seam accepts only references already pinned on the personal Board and
asks their owner for a bounded current projection. It is not a discovery API,
does not create a cross-product query authority, and never copies linked
receipt, verdict, title or status authority into Board storage. The owning
[store](../../src-server/services/spatial-board/spatial-board-store.ts) validates
the closed reference shape; the [resolved read route](../../src-server/routes/spatial-board.ts)
passes the request to the owner resolver. A pinned ID is not an authorization
grant. Cached UI projections and cleanup limits are described in the
[user guide](../user/work-board.md).
