# Work Board

Work Board is a personal Workspace Pane for arranging links to work you already
own in Station. It stores a reference and layout only. Titles, gate state,
receipts, and availability are always read from their owning feature.

## Pin and arrange work

Open a Project, expand **Open workspace**, then choose **Add pane** and
**Work Board**. Enter the
exact reference ID and any required owner scope. A Task's owner scope is the
exact Station Project **slug** (not its UUID); a Flow run's scope is the exact
Project ID. You can pin Projects, Tasks, Sessions, approval requests, gate or
Flow runs, scheduled outcomes, receipts, artifacts, and Agents. Station keeps
the typed identity you entered and never tries to repair a mismatched owner.

Each card keeps its linked title separate from its **Drag** handle, so opening
work never starts a move. Drag that handle to move a pin, and use the small
corner grip to resize it. Arrow keys move the focused handle; Shift+Arrow
resizes it. A card stays in front while you tab through its controls. The
ordered list is always available for keyboard use. In a narrow
Pane or on a touch device, it comes first and the canvas stays hidden until you
choose **Open canvas**; this avoids duplicate canvas controls in the compact
focus path.

Use the zoom controls to zoom in or out, or **Reset** to restore the default
camera. Drag an empty part of the canvas to pan. Motion is not animated when
your system requests reduced motion.

## Name, clean up, and restore

Edit the Board title and choose **Save title**. **Undo** restores the prior
Board snapshot. **Remove missing** appears for references reported missing by
the last loaded owner resolution. The cleanup request checks the Board revision
and asks the owners again about the selected pins. If any are no longer
confirmed missing, Station refuses the whole cleanup. When it succeeds, it
removes the pins and leaves the linked work untouched. The owners can change
again after this observation.

The title, camera, pin geometry, and pin order are saved on the Station.
Opening a new instance of the Pane requests the Board and owner resolutions
again. Cached observations may appear while those requests run. **Refresh
Board** requests both again while the Pane stays open. A save uses the Board
revision shown on screen. If another writer changes the Board first, Station
refuses the write and requests both current observations without retrying the
write. If a response is lost, the
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

For architecture and implementation evidence, follow the
[Work Board module](https://github.com/kontourai/station/blob/main/docs/architecture/module-map.md#personal-work-board).
