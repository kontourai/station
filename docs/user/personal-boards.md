# Personal Boards

A Personal Board is your dashboard across Projects on one Station. It belongs to
your signed-in identity, so devices connected as that person see the same saved
Board. Its live sections read work you can access; saving a Board does not copy
Tasks, approvals or conversations into it.

## Create and edit

Choose **+** beside **Personal Boards**, name the Board, and open it. Start with
**Daily brief**, **Project watch**, **Review desk**, or **Start blank**. Project
watch asks you to choose an available Project first.

Use **Edit Board** to change its name and description, add or remove sections,
move sections up or down, and choose half or full width. Live sections can show
Tasks, items needing attention, recent Station work, or available Projects. Task,
attention and recent-work sections can filter by Project; list sections have an
item limit. Notes contain your own text. Links accept Station paths and HTTP or
HTTPS addresses.

**Preview** shows the draft with real live data. It does not save it. Choose
**Save Board** when ready, or **Cancel** to retain the existing Board. Leaving
with unsaved edits asks whether to discard them. Narrow panes and phone screens
stack the sections vertically.

Task and attention sections refresh about every ten seconds. Recent work
shares the session list: live stream updates invalidate it, with a 60-second
safety poll even while the stream is connected. Project sections refresh about
every fifteen seconds. Failed reads show Retry rather than an empty success. Attention can
report that an underlying source is unavailable. Links open the owning feature;
review and approve requests there. A Board never approves work on your behalf.

## Build through chat

Choose **Build with chat**. Station opens its new-chat picker without a Project
and offers the Board context as a removable draft. Choose an Agent allowed to
use Station Control, with `list_personal_boards`, `get_personal_board` and the
mutating `propose_personal_board` action enabled. In the Agent's **Tools**
section, choose **Add tools**, search for `propose_personal_board`, then open
the matching source to select its actions and review their approval choices.
Send your request after choosing the Agent.
If Station Control is unavailable to your Agent, use the visual editor.
The built-in Station assistant exposes these tools when ready and authorized.
For example:

> Make this my morning dashboard: pending decisions, active Tasks across my
> Projects, recent work, and a note reminding me to review the release.

The Agent can list and read Personal Boards, then propose a new dashboard or a
revision. It cannot apply that proposal through the authoring tools. An existing
saved Board stays visible until you choose **Review proposal**, inspect the
preview, and choose **Apply Board**. You can edit the proposal before applying
it, or dismiss it. A newly proposed Board is marked **(draft)** in the sidebar.
Proposals appear in an open Board within about five seconds; the sidebar list
refreshes within about ten seconds.

Follow-up requests such as “put recent work first” or “show only this Project’s
Tasks” use the same proposal and review path. If the Board changed since the
Agent read it, Station refuses the stale proposal. Ask the Agent to reread it.

Conversation and Task board faces use separate `board_pin` tools. Those tools
pin cards to that conversation or Task; they do not build the Personal Boards
listed in the sidebar.

## Recover and organize

If another device or chat changes a Board while you are editing, your draft
stays visible and Save is blocked. **Reload current Board** lets you inspect the
new version after confirming whether to discard your draft. A lost save response
may have committed: refresh and inspect the Board before trying again.

The Board’s sidebar menu offers **Rename**, **Open in** a region, **Move to
project…**, and **Delete**. Moving makes it a Project Layout and removes the
personal copy. If an interrupted move leaves two copies and either was edited,
Station retains both and asks you to inspect them; retrying cannot discard the
newer contents. Apply or dismiss a pending proposal before moving; unpublished
content cannot travel into a Project. Saved dashboard sections and existing
Layout tabs render in Main, a docked region, and the destination Project.

Existing Boards with configured Layout tabs keep those tabs when you add a
dashboard. Arbitrary plugin-pane composition still follows the existing Layout
and Workspace Pane contracts; the dashboard editor offers the bounded built-in
sections above. Instance-wide shared Boards are not part of this feature.
