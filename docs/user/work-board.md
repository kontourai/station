# Work Board

Work Board is a personal Workspace Pane for arranging links to work you already
own in Station. It stores a reference and layout only. Titles, gate state,
receipts, and availability are always read from their owning feature.

## Pin and arrange work

Open a Project, choose **Add Pane**, then choose **Work Board**. Enter the
exact reference ID and any required owner scope. A Task's owner scope is the
exact Station Project **slug** (not its UUID); a Flow run's scope is the exact
Project ID. You can pin Projects, Tasks, Sessions, approval requests, gate or
Flow runs, scheduled outcomes, receipts, artifacts, and Agents. Station keeps
the typed identity you entered and never tries to repair a mismatched owner.

Each card keeps its linked title separate from its **Drag** handle, so opening
work never starts a move. Drag that handle to move a pin, and use the small
corner grip to resize it. Arrow keys move the focused handle; Shift+Arrow
resizes it. The ordered list is always available for keyboard use. In a narrow
Pane or on a touch device, it comes first and the canvas stays hidden until you
choose **Open canvas**; this avoids duplicate canvas controls in the compact
focus path.

Use the zoom controls to zoom in or out, or **Reset** to restore the default
camera. Drag an empty part of the canvas to pan. Motion is not animated when
your system requests reduced motion.

## Name, clean up, and restore

Edit the Board title and choose **Save title**. **Undo** restores the prior
Board snapshot. **Remove missing** appears for references reported missing by
the last loaded owner resolution. It removes pins, not the work they refer to.
Stale, ambiguous, unavailable, and unconfirmed results are not selected for
cleanup. Refresh before cleanup if the linked work may have changed: the
cleanup request checks the Board revision and pin identities, but does not
query each owner again.

The title, camera, pin geometry, and pin order are saved on the Station.
Returning to the Pane can reuse cached Board and resolution data; it does not
guarantee a new read. **Refresh Board** requests both again. A save uses the
Board revision shown on screen. If somebody else changes the Board first,
Station refuses the conflicting write and asks you to refresh. It does not
automatically show the other writer's changes. If a response is lost, the
result is unconfirmed until you inspect the Board again; Station does not guess
whether the mutation happened or retry it automatically.

## Linked work states

**Linked** means the owner could resolve the exact reference. **Not found**,
**Moved**, **Can’t load**, **Multiple matches**, and **Unconfirmed** describe
the last loaded owner resolution. **Unconfirmed** means an individual reference has not
yet produced a resolution; it is different from the visible resolver loading
or error notice. Use **Retry resolution** when that lookup fails. These states
are not copied status stored on the Board, and a linked item is not evidence
that a gate passed or work is complete.

For the implementation, follow the
[Pane](../../src-ui/src/workspace-panes/SpatialBoardWorkspacePane.tsx),
[SDK queries and mutations](../../packages/sdk/src/spatial-board.ts), and
[revisioned store](../../src-server/services/spatial-board/spatial-board-store.ts).
The refresh and cleanup recommendations are tracked in
[#2736](https://github.com/kontourai/station/issues/2736).
