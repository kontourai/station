# Settings you may not have found

Most Settings rows explain themselves. This page covers four sections that
change what Station offers rather than how it looks. Open **Settings**, pick a
page in the left rail, or search for a setting by name. You can also find any
Settings row from the [command palette](../guides/keyboard-shortcuts.md#command-palette)
(⌘K or Ctrl+K).

| Section | Page | Saved |
| --- | --- | --- |
| Feature previews | **Advanced** | On this Station |
| Developer tools | **Advanced** | To your account when you are signed in, otherwise on this device |
| Shared answers | **Privacy & sharing** | On this Station |
| Device hosts | **Devices** | On this Station |

## Feature previews

Feature previews are features that are still being evaluated. Each one has a
switch, a name and a description of what turning it on does. A preview is listed
only when this Station's build can run it; if none is, the section says
"No previews are currently offered". Previews start off.

| ID | Name | What turning it on does | Notable cost/risk |
| --- | --- | --- | --- |
| `reviewed-usage-tariffs` | Reviewed usage tariffs | Lets the operator review exact Bearing source bytes and route/model tariff bindings for later usage capture. | No default price or live fetching. Retail values remain separate from billing, subscription fees and quota. Historical snapshots stay frozen. |
| `project-working-configuration` | Project working configuration | Discovers repository guidance and lets an operator review the rules, checks and completion criteria used in Task briefs. | Reads bounded repository files. Applying defaults runs no command and grants no setup authority. Stale sources refuse dispatch until reviewed again. |
| `progressive-station-tools` | Progressive Station tools | Offers an index and on-demand tool families to eligible runtime credentials. | Experimental engine notification support; ordinary tool authorization still runs on each call. Turning it off restores the static catalog. |
| `learning-lifecycle-review` | Learning lifecycle review | Shows evidence, decisions, active guidance, effects and retirement in Project Sources. | Personal POSIX hosts only. Owner-reviewed activation can change future Task context; it does not install or deploy a Skill. |
| `context-compaction` | Context compaction | Offers a bounded summary cold start and opt-in threshold compaction where supported. | Summary generation can spend model tokens. Old messages stay retained; native tool and approval state is omitted, not transferred. Unknown capacity prevents automatic compaction. |
| `project-supervision` | Project supervision | Retains opted-in Task supervision and reconciles missed next actions through the conversation inbox. | May queue model turns; current access, Task incarnation, waits, capacity and original delivery keys still govern placement. |
| `github-automation-actions` | GitHub automation actions | Dispatches explicitly granted, matching rules into durable Tasks and their first inbox turn. | Can spend model tokens under retained budgets. Off by default; observation alone grants no execution authority. Repair publication requires credential separation. |
| `isolated-github-repairs` | Isolated GitHub repairs | Runs explicitly granted GitHub repairs in Docker, retaining a Task and exact proposal for operator review. | Can spend provider credits. Separate single-use publication grants open drafts only; audit and cleanup remain available when disabled. |
| `session-goals` | Session goals | Adds engine Goal inspection and paused-objective editing to Chat settings. | The current Codex adapter supports read, save paused, pause and clear. Activation and Station-managed goal loops are unavailable; reads do not start an engine. |
| `coordinator-picture` | Coordinator working picture | Lets the designated coordinator keep short notes about readable work, shown on Home. | Notes can contain work details; access to each source is rechecked. Finished notes expire after seven days. |
| `attention-snooze` | Attention snooze | Lets the attention API temporarily hide any inbox item until a chosen time, up to 30 days. A newer source version resurfaces immediately. | Local per-user state only; no provider cost or background jobs. Off by default; disabling keeps saved snoozes but omits their effect while off. |
| `fleet-consumer-probes` | Fleet consumer probes | Sends a test request to a peer-contributed model before routing work to it. | Can spend a completion on another Station. |
| `integration-content-trust` | Integration content trust | Shows trust classification and after-untrusted-content permissions for integrations in Connections. | Saved choices remain effective when the preview is off; enforcement depends on the engine and integration path. |
| `plugin-recovery-inventory` | Plugin recovery inventory | Enables the operator's retained plugin backup listing and manual recovery guidance. | The listing reveals local backup paths to the operator; it does not restore backups. |
| `walkthroughs` | Walkthroughs | Imports narrated recordings and enables Task-bound Browser clips. | One-time consented media/speech tool download; CPU use; recordings may contain private information. |
| `local-speech` | Local speech | Offers Station (local) in Voice → Speech-to-text: record a message, then transcribe it on this Station. | One-time consented tool/model download; English batch dictation only; microphone permission; shares one recognizer and a bounded wait queue with Walkthroughs. |
| `chat-host-images` | Chat images from the host | Shows images an agent saves on this Station and names by absolute path in its reply, on any device, and tells agents where to save them. | Station copies each admitted image (up to 5 per reply, 512 KiB each) into the chat's attachment storage; engines started while it is on get a per-session temporary folder. |
| `stale-project-checkout` | Stale checkout warning | Warns in a Project's Workspace settings, and in `get_project` for agents, when the Project's checkout is far behind its upstream branch. | Reads local git refs (cached for ten seconds); never fetches or updates the checkout. |
| `github-automation-observations` | GitHub automation observations | Observes configured GitHub workflow runs without starting agents. | Uses GitHub API requests and bounded private delivery storage. Off by default; management configuration is separate. Turning it off stops new observation effects and discards in-flight results; existing history remains. |
| `task-review` | Task review | Adds a Review tab and Overview Timeline to Tasks for Screens and anchored comments that can be sent to the lead agent. | Sending starts or queues a lead-agent turn; Screen capture needs a committed workspace. |
| `member-passkeys` | Member passkeys | Lets invited people with Station accounts create an account, sign in and recover with a passkey (see [member passkeys](https://github.com/kontourai/station/blob/main/docs/guides/deployment-authentication.md#member-passkeys-feature-preview)). | Passkeys work only at the address in `STATION_AUTHENTICATION_ORIGIN`; changing its hostname orphans them. Turning it off keeps stored passkeys, but they cannot sign in. |
| `task-collaboration` | Task collaboration | Shows member names and presence in shared Task rooms. | Project membership and an explicit Task share are still required. |
| `chat-apps` | Chat apps | Shows integration capability status in Connections and write-back history in Task Details. | Status checks can run `gh auth status` on the Station host; an unverified result does not prove delivery. |
| `visual-skills` | Visual skills | Offers installed visual skills in the start composer (**⋯ → Use a visual skill**) and the New Chat agent list. | Only the entry points are the preview: installing, validating and authoring visual skills work either way, and a chat already started with one keeps its skill view and any unsent next stage. Turning it off mid-draft stops New Chat showing or starting a chosen, unsent visual skill; turning it back on restores that choice. |
| `workload-budget-settings` | Workload budget settings | Shows a memory budget editor under **Settings → Advanced → Host options**: per-engine and total memory for engine workloads, beside the host's memory and where each value comes from. | Only the editor is the preview; budgets themselves are enforced either way. On a Linux Station service a lower budget kills memory-heavy commands sooner, and a total below current use is refused; an environment variable still overrides the saved value; elsewhere the values are only saved. Turning the preview off keeps saved values in force (save empty fields first to clear them). |
| `project-sharing-setting` | Project sharing setting | Shows **Project sharing with local accounts** under **Settings → System**, where the Station operator turns on invitations with username and password accounts and picks the sign-in address. | Only the control is the preview. Applying restarts Station through its process supervisor. Turning the preview off keeps the saved choice in force; environment variables set by the deployment always win. See [deployment authentication](https://github.com/kontourai/station/blob/main/docs/guides/deployment-authentication.md#turn-it-on-from-settings). |
| `session-cli-reads` | Session reads from the station CLI | Lets a person wait on, digest and list their own Sessions from the CLI: `station sessions wait`, `station sessions digest` and `station activity`. | Read-only. A wait holds one connection for up to 50 seconds at a time, from a bounded per-person pool. |

**Task review** (`task-review`): turn this on in **Settings → Advanced →
Feature previews**, then open a Task and choose **Review**, after Conversation.
Choose its plan, Brief, output or answer, select text and comment. Expand a
thread for its history; use **Send** or **Send + Resolve** to ask the live lead
agent to act, or **Copy for agent** to copy the discussion. Outdated means the
quoted text can no longer be relocated; a changed revision alone is separate.

Choose **Capture** beside **Screens**, then select a Browser session
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
agent appear under **Screens** with their commit and duration. Open a clip to
load its video; close the player to release it. See [Task clips](https://github.com/kontourai/station/blob/main/docs/guides/walkthroughs.md#record-a-task-clip).

**Chat images from the host** (`chat-host-images`): when a reply finishes,
Station copies the PNG, JPEG, GIF and WebP images it names by absolute path or
`file:` URL, from the chat's working folder, a verified worktree of it, or the
chat's own temporary folder, and shows them in the reply on every device. See
[visual replies](html-replies.md#images-saved-on-the-host) for what is admitted
and what each "not available" message means. Turning it off stops new copies;
copies already made stay with their chat.

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
4. Choose **Enable device hub** and confirm **Install and enable**. Station
   installs its device hub on the host under `~/.station-device-host`.

Each host's menu also offers **Share devices…**, **Disable hub**, **Edit** and
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

## About

**Settings → About** shows the app version, links to **Build details** and
**Diagnostics**, the open source packages bundled into the app with their
licenses, and links to the privacy policy, license and support. Development
servers have no license list.

## Link to a setting

Every Settings row has a stable address of the form
`/settings?view=<section>&highlight=<row>`, for example
`/settings?view=feature-previews&highlight=feature-previews`. See
[Settings deep links](https://github.com/kontourai/station/blob/main/docs/reference/settings-deep-links.md).
