# Settings you may not have found

Most Settings rows explain themselves. This page covers five sections that
change what Station offers rather than how it looks. Open **Settings**, pick a
page in the left rail, or search for a setting by name. You can also find any
Settings row from the [command palette](../guides/keyboard-shortcuts.md#command-palette)
(⌘K or Ctrl+K).

| Section | Page | Saved |
| --- | --- | --- |
| Feature previews | **Advanced** | On this Station |
| Developer tools | **Advanced** | To your account when you are signed in, otherwise on this device |
| Shared answers | **Privacy & sharing** | On this Station |
| Browser & devices | **Advanced** | On this Station, per Project for the Browser rows |
| Device hosts | **Advanced** | On this Station |

## Project settings

Open a Project's settings to change its defaults, sources and access. Desktop
uses the same vertical section navigation as Settings; on a narrow screen,
choose a section from the picker. One section is shown at a time. Section
links remain bookmarkable, and moving between sections keeps unsaved edits.

**Save** applies project defaults. Layout, source, access and knowledge actions
apply separately when confirmed. A saved model connection that is no longer
available stays visible until you choose a replacement; an unrelated edit does
not reset it to the Station default.

Folder paths identify the Station that owns them. A path shown while using a
phone or remote browser belongs to that Station, rather than to the viewing
device. **Sources** shows repository links and checkout locations. Use
**Add a repository** to attach a checkout and **Advanced: checkout repair**
for filesystem repair. **Workspace** edits the Project's local working folder.

## Feature previews

**Paired Station chats** lets New Chat use another paired Station. Choose its
Project; the chat header says **Via <Station>**. Full access, folder selection,
mentions, offline copies and local integrations are unavailable over relay.
Turning it off keeps text and drafts visible and stops remote chat operations.
Older held chats require confirmed **Reconnect chat** before continuing. See
[starting a chat](getting-started.md#start-your-first-chat).

Feature previews are features that are still being evaluated. Each one has a
switch, a name and a description of what turning it on does. A preview is listed
only when this Station's build can run it; if none is, the section says
"No previews are currently offered". Previews start off unless noted below.

| ID | Name | What turning it on does | Notable cost/risk |
| --- | --- | --- | --- |
| `durable-station-agent` | Crash-durable Station Agent | Keeps Station-engine text turns running after a client disconnect and resumes journaled steps after restart. Stop still cancels. | Experimental; writes every model/tool step to private SQLite and can add substantial latency. An uncertain model request is surfaced without automatic resend; pending approvals still require an answer. |
| `reviewed-usage-tariffs` | Reviewed usage tariffs | Lets the operator review exact Bearing source bytes and route/model tariff bindings for later usage capture. | No default price or live fetching. Retail values remain separate from billing, subscription fees and quota. Historical snapshots stay frozen. |
| `codex-bound-browser-device-tools` | Codex browser and device tools | Offers eligible Codex Sessions the built-in browser and device tools over a bound channel. | Calls require current Project access and tool approval policy; browser pages and device contents can contain private data. Changing this choice retires existing bindings; start a new Session to use it again. |
| `station-orchestration-instructions` | Station orchestration instructions | Tells Agents that have Station control tools when and how to use them (delegating to another Agent, waiting on Sessions, browser and device tools). It rides the Agent's system prompt on Claude when the Agent has one, otherwise the first message of a new Session. | Adds a few thousand characters to each new Session's prompt. Applies to Sessions started after the change; resumed Sessions are not re-sent. Station control tool approval and access rules are unchanged. |
| `learning-lifecycle-review` | Learning lifecycle review | Shows evidence, decisions, active guidance, effects and retirement in Project Sources. | Personal POSIX hosts only. Owner-reviewed activation can change future Task context; it does not install or deploy a Skill. |
| `context-compaction` | Context compaction | Offers a bounded summary cold start and opt-in threshold compaction where supported. | Summary generation can spend model tokens. Old messages stay retained; native tool and approval state is omitted, not transferred. Unknown capacity prevents automatic compaction. |
| `project-supervision` | Project supervision | Retains opted-in Task supervision and reconciles missed next actions through the conversation inbox. | Needs Coordinator chat. May queue model turns; current access, Task incarnation, waits, capacity and original delivery keys still govern placement. |
| `github-automation-actions` | GitHub automation actions | Dispatches explicitly granted, matching rules into durable Tasks and their first inbox turn. | Can spend model tokens under retained budgets. Off by default; observation alone grants no execution authority. Repair publication requires credential separation. |
| `isolated-github-repairs` | Isolated GitHub repairs | Runs explicitly granted GitHub repairs in Docker, retaining a Task and exact proposal for operator review. | Can spend provider credits. Separate single-use publication grants open drafts only; audit and cleanup remain available when disabled. |
| `session-goals` | Session goals | Adds engine Goal inspection and paused-objective editing to Chat settings. | The current Codex adapter supports read, save paused, pause and clear. Activation and Station-managed goal loops are unavailable; reads do not start an engine. |
| `coordinator-session` | Coordinator chat | Lets you make one chat your personal agent ([Houston](https://github.com/kontourai/station/blob/main/docs/user/houston.md)), shown on Home and woken when work you can read needs you, fails or finishes. | Each wake is a model call. On an engine with Station tools it acts with your permissions. Turning it off keeps your choice of chat; nothing is woken and queued updates are not sent. |
| `coordinator-picture` | Coordinator working picture | Lets the designated coordinator keep short notes about readable work, shown on Home. | Needs Coordinator chat. Notes can contain work details; access to each source is rechecked. Finished notes expire after seven days. |
| `conversation-resolution` | Open and Settled inbox | Keeps conversations Open until explicitly settled. Task closure follows the existing Task close-on-merge setting. | Personal resolution state syncs across devices. Turning it off preserves saved choices and restores turn-based grouping; no provider cost. |
| `attention-snooze` | Attention snooze | Lets the attention API temporarily hide any inbox item until a chosen time, up to 30 days. A newer source version resurfaces immediately. | Local per-user state only; no provider cost or background jobs. Off by default; disabling keeps saved snoozes but omits their effect while off. |
| `private-memory` | Private memory | Private memory you can check and search. New chats start with what you confirmed. No erasure yet. | Memory can contain personal information. Off by default. Only chats on the Station engine get the brief. Create it through the API. Disabling hides access but retains the store. Hosted Stations do not offer it. |
| `fleet-consumer-probes` | Fleet consumer probes | Sends a test request to a peer-contributed model before routing work to it. | Can spend a completion on another Station. |
| `integration-content-trust` | Integration content trust | Shows trust classification and after-untrusted-content permissions for integrations in Connections. | Saved choices remain effective when the preview is off; enforcement depends on the engine and integration path. |
| `browser-experience` | Browser experience | Adds Browser shortcuts, per-tab zoom and appearance, float over chat, and agent action visualization. | Off by default on personal hosts; ordinary Browser authority and control checks still apply. |
| `inline-browser-activity` | Inline browser activity | Shows the browser beside its calls in a conversation, with floating and Browser pane placements. | Off by default. Uses the existing browser session and access checks; recording remains explicit. |
| `plugin-recovery-inventory` | Plugin recovery inventory | Enables the operator's retained plugin backup listing and manual recovery guidance. | The listing reveals local backup paths to the operator; it does not restore backups. |
| `browser-artifacts` | Browser artifacts | Enables Browser annotation, chat attachment, recording and network diagnostics. | Images and clips can contain page content; recording uses FFmpeg and temporary storage; network query values are redacted. |
| `walkthroughs` | Walkthroughs | Imports narrated recordings and enables Task-bound Browser and Device clips. | One-time consented media/speech tool download; CPU use; recordings may contain private information. |
| `device-developer-loop` | Device developer loop | Enables app-filtered logs, Device clips and agent-open auto-float. | Device clips also require Walkthroughs; logs and recordings may contain private information. |
| `local-speech` | Local speech | Offers Station (local) in Voice → Speech-to-text: record a message, then transcribe it on this Station. | One-time consented tool/model download; English batch dictation only; microphone permission; shares one recognizer and a bounded wait queue with Walkthroughs. |
| `chat-host-images` | Chat images from the host | On by default. Shows images an agent saves on this Station and names by absolute path in its reply, on any device, and tells agents where to save them. | Station copies each admitted image (up to 5 per reply, 512 KiB each) into the chat's attachment storage; engines started while it is on get a per-session temporary folder. |
| `stale-project-checkout` | Stale checkout warning | Warns in a Project's Workspace settings, and in `get_project` for agents, when the Project's checkout is far behind its upstream branch. | Reads local git refs (cached for ten seconds); never fetches or updates the checkout. |
| `task-tracker-follow-ups` | Task tracker follow-ups | Every five minutes, reads new comments, reviews and check results on the GitHub items of tracker-backed Tasks (the issue and pull requests a person kept on the Task) and shows them in the Task brief, labeled member, bot, other or CI. A member's comment or review, or a failing check, sends the Task's lead agent one message. | Uses the host's `gh` login and GitHub API requests. Off by default, personal Stations only. The message waits for the lead's running turn, or starts a turn when it is idle; bots and other authors never send one. Comments made with the same GitHub account Station's `gh` uses never send one either, because agents post with it: on a single-user Station your own GitHub comments are recorded but do not wake the lead, so steer it in Station instead. If that account cannot be determined, only failing checks send one. Turning it off stops polling and waking; recorded follow-ups stay in the brief. |
| `github-automation-observations` | GitHub automation observations | Observes configured GitHub workflow runs without starting agents. | Uses GitHub API requests and bounded private delivery storage. Off by default; management configuration is separate. Turning it off stops new observation effects and discards in-flight results; existing history remains. |
| `task-capabilities` | Task capabilities | Adds a capability and evidence path to Task Overview, with searchable Project tool setup. | Opening tool inspection reads configured catalogs and may contact their providers. It starts no Agent and changes no tools or permissions. |
| `task-review` | Task review | Adds a Review tab and Overview Timeline to Tasks for Screens and anchored comments that can be sent to the lead agent. | Sending starts or queues a lead-agent turn; Screen capture needs a committed workspace. |
| `member-passkeys` | Member passkeys | Lets invited people with Station accounts create an account, sign in and recover with a passkey (see [member passkeys](https://github.com/kontourai/station/blob/main/docs/guides/deployment-authentication.md#member-passkeys-feature-preview)). | Passkeys work only at the configured sign-in address, selected in Settings or supplied by `STATION_AUTHENTICATION_ORIGIN`; changing its hostname orphans them. Turning it off keeps stored passkeys, but they cannot sign in. |
| `apps-library` | Apps library | Adds a searchable launcher for your personal Boards and plugin layouts, with name, icon and description editing. | Uses existing personal-layout permissions; does not install plugins or grant access. |
| `task-collaboration` | Task collaboration | Shows member names and presence in shared Task rooms. | Project membership and an explicit Task share are still required. |
| `chat-apps` | Chat apps | Shows integration capability status in Connections and write-back history in Task Details. | Status checks can run `gh auth status` on the Station host; an unverified result does not prove delivery. |
| `repository-auth-details` | Repository sign-in details | Shows the current Station’s GitHub CLI account, health and reported scopes in Project Sources. | Runs a bounded `gh auth status --json hosts --no-refresh`; no token refresh, credential transfer or repository-permission proof. |
| `continue-interrupted-turn` | Continue after restart | Offers **Continue** on a chat turn a Station restart cut off, which sends the agent a short note to pick up where it stopped. | Continue starts an ordinary agent turn, once per interrupted turn; it is never sent on its own. |
| `continue-unattended-after-restart` | Continue unattended work after restart | After a restart, continues Task and delegated work the restart cut off, once, with the restart note, oldest Task first. | Starts an agent turn per interrupted turn on its own; never for your chats, Automations or Tasks that are done, canceled or blocked. Waits for engine-start capacity. |
| `paired-station-chats` | Paired Station chats | Starts text chats on a paired Station from New Chat, with that Station’s Project picker, transcript, replies and approvals. | Personal hosts only. Uses the destination’s providers and credits. Off disables reads and new operations; saved tabs and unconfirmed messages remain. Existing remote Tasks keep their separate flow. |
| `visual-skills` | Visual skills | Offers installed visual skills in the start composer (**⋯ → Use a visual skill**) and the New Chat agent list. | Only the entry points are the preview: installing, validating and authoring visual skills work either way, and a chat already started with one keeps its skill view and any unsent next stage. Turning it off mid-draft stops New Chat showing or starting a chosen, unsent visual skill; turning it back on restores that choice. |
| `workload-budget-settings` | Workload budget settings | Shows a memory budget editor under **Settings → Advanced → Host options**: per-engine and total memory for engine workloads, beside the host's memory and where each value comes from. | Only the editor is the preview; budgets themselves are enforced either way. On a Linux Station service a lower budget kills memory-heavy commands sooner, and a total below current use is refused; an environment variable still overrides the saved value; elsewhere the values are only saved. Turning the preview off keeps saved values in force (save empty fields first to clear them). |
| `project-sharing-setting` | Project sharing setting | Shows **Project sharing with local accounts** under **Settings → System**, where the Station operator turns on invitations with username and password accounts and picks the sign-in address. | Only the control is the preview. Applying restarts Station through its process supervisor. Turning the preview off keeps the saved choice in force; environment variables set by the deployment always win. See [deployment authentication](https://github.com/kontourai/station/blob/main/docs/guides/deployment-authentication.md#turn-it-on-from-settings). |
| `session-cli-reads` | Session reads from the station CLI | Lets a person wait on, digest and list their own Sessions from the CLI: `station sessions wait`, `station sessions digest` and `station activity`. | Read-only. A wait holds one connection for up to 50 seconds at a time, from a bounded per-person pool. |

For **Crash-durable Station Agent**, an output-limit message means you should start a new turn to continue. Recovery replay for finished turns (completed, failed or cancelled) expires after seven days; this cleanup does not delete conversation history.

**Task review** (`task-review`): turn this on in **Settings → Advanced →
Feature previews**, then open a Task and choose **Review**, after Conversation.
Choose its plan, Brief, output or answer, select text and comment. Expand a
thread for its history; use **Send** or **Send + Resolve** to ask the live lead
agent to act, or **Copy for agent** to copy the discussion. Outdated means the
quoted text can no longer be relocated; a changed revision alone is separate.

Choose **Capture** beside **Screens**, then select a Browser or Device session
from the Task's Project and capture it. Commit workspace changes first. Place a
region pin with the pointer, or focus the image target, use the arrow keys and
press Enter, then comment. Captures retain the commit and appear through the
Task's authorized image route. Overview shows captured Screens in the Timeline;
select a thumbnail to open it in Review. **Show more** reveals older Screens
after the latest 12. A bound agent can also capture an
authorized device Screen; see [device capture](https://github.com/kontourai/station/blob/main/docs/guides/mobile-device-workspace.md#capture-a-device-screen-to-a-task).
Turning the preview off hides Review and Timeline; a
`taskView=review` link then opens Overview.

With **Walkthroughs** also enabled, Browser clips made by the Task's bound
agent appear under **Screens** with their commit and duration. With **Device
developer loop** enabled too, people and bound agents can record Device clips.
Open a clip to
load its video; close the player to release it. See [Task clips](https://github.com/kontourai/station/blob/main/docs/guides/walkthroughs.md#record-a-task-clip).

**Chat images from the host** (`chat-host-images`): when a reply finishes,
Station copies the PNG, JPEG, GIF and WebP images it names by absolute path or
`file:` URL, from the chat's working folder, a verified worktree of it, or the
chat's own temporary folder, and shows them in the reply on every device. See
[visual replies](html-replies.md#images-saved-on-the-host) for what is admitted
and what each "not available" message means. Turning it off stops new copies;
copies already made stay with their chat. The default applies to new and existing
Station homes unless an operator has explicitly turned it off.

**Continue after restart** (`continue-interrupted-turn`): when Station
restarts while an agent is working, the chat marks the cut-off turn ("Station
restarted mid-turn" or the restart notice). With the preview on, that marker
offers **Continue** while it is still the chat's latest message, the chat has
caught up, and no turn is running. Continue sends the agent a fixed note, as your message, asking it to
first check its working directory (`git status`, `git log`), the Task's pull request and
issue, and any background processes, not to repeat a push, pull request,
comment or other outside action until it has confirmed that did not already
happen, and then to continue from where it stopped.
Anything you were writing stays in the composer. A second tap, here or on
another device, does not send it again. A newer message retires the button.
If the agent refuses it as busy, that Continue cannot be sent again; type a
message instead.

**Continue unattended work after restart** (`continue-unattended-after-restart`):
with the preview on, after Station restarts it continues work nobody was
watching. That covers a turn Station itself sent into a Task's Session (such as
a Task question wake) and a delegated Session's work, including a result a
delegated child returned to a Task's Session or to another delegated Session.
A result returned into your own chat, or an agent's message into it, belongs
to your chat and is not continued. Each such turn the restart cut off gets one turn with the same note
**Continue** sends, oldest Task first, as the Session's owner. The chat shows it
as **Continued after restart**. It is never sent for a turn you sent yourself
(including Station's automatic continuation of your turn after a memory kill),
an Automation's run (Station never repeats a run a restart cut off; the run is
recorded with its outcome unknown, see [Automations](automations.md)), a coordinator, or a
turn whose cause Station did not record. It also skips a Task that is done,
canceled or blocked, a chat that has moved on since, and a turn that was itself
such a continuation, so a second restart does not continue it again. It uses
the same key as **Continue**, so the agent is continued once whichever comes
first. A continuation that needs to start the agent's engine waits for
engine-start capacity.

**Stale checkout warning** (`stale-project-checkout`): an agent started in a
Project reads that checkout's instructions, so a checkout far behind its
upstream can give it rules the upstream has since dropped. With the preview on,
Project settings → **Workspace** warns when the current branch is at least
**Stale checkout after commits** (default 50) behind its upstream, has lacked
an upstream commit for **Stale checkout after days** (default 3), or was last
fetched at least that many days ago, and shows `git -C <directory> pull
--ff-only` to copy. Station never runs it. The counts come from the last
fetch, whose time the warning shows; Station does not fetch. A checkout whose
git config sets options Station does not run git with (for example a
credential helper) shows a line saying it was not compared, and one Station
could not read says it could not compare it. A folder that is not a git
checkout, a detached HEAD, or a branch without a local upstream shows nothing.
The two thresholds are in **Settings → General → Agent runs**.

**Settings → General → Agent runs → Chats without a project** chooses where a
new chat with no project runs: **Private folder** (the default, a folder of
its own in Station's data) or **Home folder**. A chat that already ran keeps
its folder. With **Home folder**, a Codex chat that runs in Codex's sandbox
still gets a private folder from Station, because rooting that sandbox in your
home folder would let it change access to everything there.

**Isolated GitHub repairs** (`isolated-github-repairs`) adds the personal operator
repair API. Configured rules may spend provider credits in Docker; exact review
and a separate single-use grant are required to publish a draft PR. It starts
off and enables no source by itself. Disabling it stops new work; operator audit
and cleanup remain available. See [setup and recovery](https://github.com/kontourai/station/blob/main/docs/guides/agent-efficiency.md#run-an-isolated-github-repair).

Turning a preview on affects everyone who uses this Station.

For **Local speech**, choose **Station (local)** in **Settings → Voice →
Speech-to-text** after enabling the preview. Click the composer microphone to
record and click again to stop; final text appears after transcription. Missing
tools require the Station operator’s explicit `station media-tools download
--yes` consent against this instance; there is no download settings panel yet.
Disabling the preview removes the provider when the UI observes the change and
cancels pending client dictation. See [local speech](https://github.com/kontourai/station/blob/main/docs/guides/local-speech.md)
for requirements, limits and error recovery.

## Developer tools

**Enable developer tools** shows the **Developer** page in **Customize** and
the command palette, and its **Monitoring** page in the command palette. It is
off by default; a direct `/developer` link still opens when it is off.

Enabling it also reveals five independent previews: **Flow delivery preview**,
**Veritas readiness preview**, **Trust preview**, **Sheet gestures preview**,
and **Station routes preview**. Each starts off and is saved on this device. The tools require both Developer tools and their own
preview switch to be on. Turning Developer tools off makes them unavailable
without clearing those saved choices. These device previews are separate from
the Station-wide Feature previews above.

**Sheet gestures preview** adds a drag handle to the top edge of sheets that
open from the bottom of a phone-width screen. Drag it up to expand the sheet to
nearly full height, drag it down to close the sheet, or tap it to switch
between the two heights. Closing this way is the same as choosing the sheet's
close button. Confirmation prompts and sheets that cannot be dismissed get no
handle, and the handle can only be dragged with touch or a pointer; the close
button and Escape still close every sheet.

The same preview lets you swipe a conversation left in the inbox to reveal
**Snooze** (clock) and **Dismiss** (×), with larger touch targets and labels.
Swiping reveals the controls; tap one to act. Swipe right to hide them.
The row’s Details menu offers the same actions with the preview off.

**Station routes preview** adds **Routes** to the Devices page: every address
this device reaches the current Station on, which one is in use, which failed
and why, and **Add route** for an address you type. **Edit** removes routes you
added. While connected, the app also learns the LAN, Tailscale and Tailscale
HTTPS addresses the Station reports, marked "found automatically". The app saved on a phone or desktop
lists those addresses but still connects only through its saved one; see
[Station routes](https://github.com/kontourai/station/blob/main/docs/design/station-routes.md).

## Shared answers

This section lists the answer links you have created, with their state and
expiry, and lets you revoke them. See [Share an answer](sharing-answers.md).

## Browser & devices

Configuration the Browser and Device panes keep out of their toolbars. The
Browser's **⋯ › Browser settings…** opens it on that Browser's Project.

- **Agent JavaScript** lets agents run scripts in the chosen Project's
  pages. It is off by default, and only the operator or a Project admin can
  change it.
- **Shared local servers** (operator only) lists the local servers the
  Project's admins can open in the Browser. **Find local servers** suggests
  some, and nothing is shared until you choose it. Shared servers appear as
  buttons on an empty Browser.
- **Open device setup** opens the device setup wizard: the device helper,
  sharing devices with Projects, and agent device access.

## Device hosts

A device host is another Mac or Linux computer that runs iOS simulators or
Android emulators for Station over SSH. Station uses your SSH agent and
configuration and never stores a key. Only the Station operator sees this
section, and only on a personal Station.

1. Confirm the host key once in a terminal: `ssh user@host`.
2. Choose **Add device host** and enter a **Name** and an **SSH target**, such
   as `me@build-host.example` or an alias from your SSH config.
3. Choose **Test connection**. Station checks that it can reach the host and
   that Node.js, Xcode simulators and the Android SDK are available.
4. Choose **Enable device helper** and confirm **Install and enable**. Station
   installs its device helper on the host under `~/.station-device-host`.

Each host's menu also offers **Share devices…**, **Disable helper**, **Edit** and
**Remove**. A Station can have up to 32 hosts. The
[mobile device workspace guide](https://github.com/kontourai/station/blob/main/docs/guides/mobile-device-workspace.md)
explains what you can do with the devices once a host is ready.

## Nearby Stations

On the computer running Station, **Settings → Pairing → Discover this Station
nearby** makes its name and local address visible to nearby devices. It starts
off and only the computer's local operator can change it. The status below the
switch says whether publication succeeded; enabling it does not change your
network or firewall. Connecting still needs your approval. See
[Connect your phone](getting-started.md#connect-your-phone).

A server connection loss shows a brief reconnecting notice after three failed
checks. Recovery shows a notice only if a loss was announced; an active event
stream must catch up first. Pairing and other blocking failures still need the
action shown in Station details.

## Updates and changelogs

Open **Updates** in the sidebar to review an app or server update. **What’s
new** shows release notes for the installed server and any offered update. **Previous versions and
changelogs** lets you browse published releases without starting an update.
The circle around the sidebar update icon fills as a download progresses.

After an app or connected-server upgrade, its changelog opens once on this device.
A browser served by the updated server shows one popup for that upgrade.
In-app changelogs omit installation instructions; those remain on GitHub.
Long lists show the first 50 changes. **See all changes** opens the full release.
Server versions are remembered separately for each server. To turn that
off, clear **Show changelog after updates** in the dialog, Updates, or
**Settings → System**. Release history stays available. The first launch on a
new device establishes the starting version without showing an upgrade dialog.

## About

**Settings → About** shows the app version, links to **Build details** and
**Diagnostics**, the open source packages bundled into the app with their
licenses, and links to the privacy policy, license and support. Development
servers have no license list.

## Settings your organization manages

On a machine your organization manages, some rows carry a **Managed by
<organization>** badge. Your organization fixed that value: the control is
disabled, and **Get help** opens its support page. A row marked
**<organization> default** uses a value your organization suggested; change it
like any other setting. Your own earlier values are kept and come back if the
organization removes its policy. A managed value fixes the Station-wide
setting only: what you set on an Agent, for a conversation, or on your own
account (such as your chat font size) still applies. See the
[managed policy guide](https://github.com/kontourai/station/blob/main/docs/guides/managed-policy.md#settings).

## Link to a setting

Every Settings row has a stable address of the form
`/settings?view=<section>&highlight=<row>`, for example
`/settings?view=feature-previews&highlight=feature-previews`. See
[Settings deep links](https://github.com/kontourai/station/blob/main/docs/reference/settings-deep-links.md).
