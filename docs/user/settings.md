# Settings you may not have found

Most Settings rows explain themselves. This page covers six sections that
change what Station offers rather than how it looks. Open **Settings**, pick a
page in the left rail, or search for a setting by name. You can also find any
Settings row from the [command palette](../guides/keyboard-shortcuts.md#command-palette)
(⌘K or Ctrl+K).

| Section | Page | Saved |
| --- | --- | --- |
| Feature previews | **Advanced** | On this Station |
| GitHub automations | **Advanced** | On this Station |
| Developer tools | **Advanced** | To your account when you are signed in, otherwise on this device |
| Shared answers | **Privacy & sharing** | On this Station |
| Browser & devices | **Advanced** | On this Station, per Project for the Browser rows |
| Device hosts | **Advanced** | On this Station |

In **Notifications**, browser Web Push reflects the selected Station’s
registration. Turning it off removes the local subscription. Station
reports failed registration cleanup separately.
[Web Push notifications](https://github.com/kontourai/station/blob/main/docs/guides/web-push-notifications.md)

Use **Keyboard shortcuts** to inspect focus conditions and change bindings
on this device. On small screens the list is read-only. See the
[keyboard shortcut guide](../guides/keyboard-shortcuts.md).

Use Settings search or the command palette to jump to **Accounts and sign-in**,
**What usage sharing includes**, **Skill shortcuts**, or **Model picker preferences**.
Accounts and sign-in describes any access restriction on the connected Station.
The usage disclosure lists what the Station reports for each sharing choice.

**Skill shortcuts** shows the saved bindings for command skills. Open a context
that makes a skill available to edit its binding. Bindings for unavailable
skills stay saved on this device.

**Model picker preferences** in Chat shows saved favorites, hidden models,
manual order and recent models. Clear recent models there, or open model
connections and select a connection to edit favorites, visibility and order.
Clearing recents keeps the other preferences. Model picker preferences sync
when account preferences are available. If previous choices are saved on this
device, review them through **Import previous preferences**.

**Default send mode** in Your account preferences sets how follow-ups are
sent during a running turn on this Station. Queue is the default. Steer
applies when the current turn and draft support it. You can change the mode
for the current Session from the composer or save it there as your default.

## Project settings

Open a Project's settings to change its defaults, sources and access. Desktop
uses the same vertical section navigation as Settings; on a narrow screen,
choose a section from the picker. One section is shown at a time. Section
links remain bookmarkable, and moving between sections keeps unsaved edits.

**Save** applies project defaults. Layout, source, access and knowledge actions
apply separately when confirmed, and **Pull requests** saves as you change it. A saved model connection that is no longer
available stays visible until you choose a replacement; an unrelated edit does
not reset it to the Station default.

Folder paths identify the Station that owns them. A path shown while using a
phone or remote browser belongs to that Station, rather than to the viewing
device. **Sources** shows repository links and checkout locations. Use
**Add a repository** to attach a checkout and **Advanced: checkout repair**
for filesystem repair. **Workspace** edits the Project's local working folder.

### Project brief, memory and models

With the **Project brief, memory and models** preview on
(`project-coordination`), Project settings gain four sections. Each new
Session in the Project starts with the brief and the memory index, whatever
engine runs it: Station's own, Claude Code, Codex, an ACP engine, a Task's
Session, a delegated Session or a scheduled run in the Project. Sessions
already running keep what they started with; an edit reaches the next one.
The turn's **Added context** lists **Project brief** and **Project memory**
with approximate tokens, so you can see that they arrived.

- **Brief**: the Project's one-line **Goal**, shown under its name on the
  Project page, and its **Instructions** (up to 16,000 characters). The empty
  field suggests what to cover: what the Project is for, where work happens,
  how a Session checks its work, what to do when something is missing, and
  what needs your go-ahead. Saved with **Save**.
- **Memory**: short notes agents save when you ask them to remember
  something or correct them, and that you can add, edit or delete here. Each
  note shows who last changed it and when. A new Session sees the note titles
  as background, not instructions, and opens a note when it needs it. Changes
  apply at once. Notes stay in this Station's data for the Project, never in
  a repository, and only the Project's owner sees them. Agents use the
  `remember_project_note`, `list_project_notes`, `read_project_note` and
  `forget_project_note` tools, which reach only their own Project.
- **Models and effort**: the reasoning effort for the Project's own chats
  (those that are not Tasks; their model is the Project's **AI model**), and
  the engine, model and effort for the Tasks it dispatches. A Task dispatched
  with its own model or effort keeps it. Effort applies on Claude Code, Codex
  and Muse. A new Project starts its chats at medium effort. Each Task runs
  its own Session, so parallel Tasks multiply usage. Saved with **Save**;
  each change reaches the next chat or Task.
- **Usage**: tokens the Project's Sessions used on this Station in the last
  30 days, the Project chats' share, and the split by Task and by model.

Three kinds of instructions reach a Session. The **brief** is your standing
instruction for every Session in the Project. **Memory** is notes agents keep
as they work, read as background. **Repository instructions** stay in each
repository's `AGENTS.md` or `CLAUDE.md`.

The first time a Session starts in a Project after you turn the preview on,
Station copies the Project's existing rules (`project-rules.md` in Project
knowledge) into the brief's instructions, after any instructions already
there. The copy is word for word, runs once, and leaves the rules document in
place; from then on the brief carries them on every engine, without a vector
database or embedding provider. Rules longer than the brief allows are not
copied and keep working as before. Turning the preview off restores the old
behavior: no brief or memory, and the rules inject only on Station's engine
when knowledge search is configured.

### Coordinator in #general

With the **Coordinator in #general** preview on (`project-room-coordinator`),
the Agent you ask in a Project Room's `#general` channel works as the
Project's coordinator. Send work, updates and questions as they come up. Each
reply ends with a line saying where your message went:

- **Answered here**: a quick question gets its answer in the channel and
  starts nothing.
- **Proposed Tasks**: new work appears on a card under the reply, one row per
  Task with its title, Agent, and whether it runs in the Project folder or its
  own worktree. Press **Start** on a row or **Start all**. Three separate
  requests in one message become three rows.
- **Sent to Task**: a follow-up about work a coordinator Task is already
  doing goes to that Task's chat, and the reply links the Task.

When a Task is marked Done, the coordinator posts one linked status message
in `#general`, including after a Station restart. An initial turn that succeeds
leaves the Task open until it is marked Done. A cancellation or first-turn
failure posts a stopped status with its Task link. **Status sweep**, at the
top of `#general`, posts one line per open Task with its link, whether a
written answer exists, and what it is waiting on. Open the Task to read its
work under your own access. Cards show a short reason when a Task cannot
start. Private Task output and diagnostic details stay out of the channel.
Each request starts a fresh coordinator Session that reads the Project brief
and memory, the channel's recent messages and a short report per Task. The
conversation never needs compacting.

Project settings → **Coordinator** sets the limits. Station enforces them;
they are not instructions to the model:

- **Start without asking**: start proposed Tasks at once instead of showing
  the card first. Off by default.
- **Tasks at once**: how many coordinator Tasks work at the same time, 1–10
  (default 2). The rest show **Waiting for a slot** and start as one finishes.
- **Pull requests**: **Only when you ask** (default) lets a Task use Station-guarded
  pull-request tools when your message asked for a pull request. The card counts
  tool refusals. External credentials and tools follow their own policies. **Whenever the Task needs one** allows them.

The coordinator works where the Project Room runs, including from a paired
phone. A coordinator Task's result is posted only while the person who started
it may still start work in the Project; otherwise the Task finishes without a
message in the channel. The limits count Tasks started from `#general`, not
other Tasks in the Project. The preview is available on personal Stations
with Project sharing and separate deployment sign-in disabled.

### Pause, archive, delete

The last section of Project settings stops or removes a Project's work.
Pause and Archive are Feature Previews (`project-pause-archive`); Delete is
always offered:

- **Pause** stops every chat running in the Project, through the same Stop a
  chat offers, and holds it: no message, schedule or restart starts a turn
  there until you **Resume**. Station waits up to 10 seconds for running
  chats to stop and says how many it stopped. A stopped chat continues only
  when you message it after Resume. The Project page shows a banner with
  **Resume** while it is paused.
- **Archive** does what Pause does and hides the Project from the sidebar.
  **Archived (n)** at the end of the Project list shows archived Projects;
  **Unarchive** returns one, active.
- **Delete** first lists what it removes (Project settings, Layouts,
  knowledge documents, schedules), the running chats it stops, and what it
  keeps: Tasks, chats, the repository checkout, pushed branches and pull
  requests. Tasks and chats stay readable in history.

**Schedules** (the `project-schedules` Feature Preview) lists the Project's
own automations. See
[Project schedules](automations.md#project-schedules).

## Project pull requests

Project settings → **Pull requests** uses the Project's repository and the
connected Station's provider capabilities. A missing repository offers
**Open Sources**; a valid remote without automatic feedback shows that limit
without asking you to replace the repository. Stored choices are preserved.
Today GitHub supports automatic feedback and Task-branch discovery. GitLab.com
has native merge-request views but no automatic feedback adapter yet. Bitbucket
and Azure DevOps remain usable as Git repositories; native pull-request
integration is not implemented. For self-managed GitLab, set the comma-separated hostname list `STATION_GITLAB_HOSTS` on the Station host and sign in with `glab` for each instance.
A readable checkout is also needed for Station's review of each new head.

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
| `dynamic-route-publications` | Dynamic HTTPS routes | Discovers this Station's existing Tailscale Serve app and separate approval origins live. The local operator can persist **Approval HTTPS origin** in Routes settings without restarting; enabled requests read the current saved configuration. See [HTTPS deployment](https://github.com/kontourai/station/blob/main/docs/guides/deployment.md#reaching-the-consent-origin-over-https). | Off by default. Saving a changed origin is refused while off; legacy environment/HTTP behavior remains. Does not provision Serve or grant access. Nearby TXT `appOrigin` is only an untrusted connection hint; Request Access and identity verification still apply. Installed Android/iOS physical-device behavior is not established by adapter tests. |
| `desktop-nearby` | Desktop Nearby discovery | Lets a connected Windows desktop browse local-network Station advertisements for a bounded foreground request. Enable it on the currently selected, authorized Station. | Off by default. Disabled or unavailable admission starts no native discovery scan; QR and address entry remain. Browsing lasts at most five seconds, followed by up to 1.5 seconds for shutdown confirmation. Unconfirmed shutdown blocks more scans until restart. Hints never carry credentials, approve access, or change the selected Station. macOS/Linux desktop browsing and discovery across tailnets are not included. |
| `chat-server-log-approval` | Server log approvals in chat | On a personal Station, lets the owner approve one server-log query or subsequent queries for the same Agent session from its active chat. The card shows severity, time bounds, and the maximum number of entries. | The card expires after one minute. Session grants end when the session stops or resets or the server restarts. Results are redacted and may still contain private conversation content. |
| `durable-station-agent` | Crash-durable Station Agent | Keeps Station-engine text turns running after a client disconnect and resumes journaled steps after restart. Stop still cancels. | Experimental; writes every model/tool step to private SQLite and can add substantial latency. An uncertain model request is surfaced without automatic resend; pending approvals still require an answer. |
| `reviewed-usage-tariffs` | Reviewed usage tariffs | Lets the operator review exact Bearing source bytes and route/model tariff bindings for later usage capture. | No default price or live fetching. Retail values remain separate from billing, subscription fees and quota. Historical snapshots stay frozen. |
| `codex-bound-browser-device-tools` | Codex browser and device tools | Offers eligible Codex Sessions the built-in browser and device tools over a bound channel. A new Codex Session whose Agent has Station Control also gets every Station Control tool on that channel instead of a header token, which adds about 110 KB of tool definitions to each thread. | Calls require current Project access and tool approval policy; browser pages and device contents can contain private data. Changing this choice retires existing bindings; start a new Session to use it again. |
| `codex-tool-families` | Codex tool families | New Codex Sessions that use Station Control over its header token list a short index of tool families instead of every tool and load a family when they need it. Needs Codex 0.167.0 or later; never applies to the Codex browser and device tools channel, Claude or ACP engines. | A resumed Session starts at the index again and reloads the families it uses. Turning it on applies to new Sessions; a thread that started without families keeps every tool on resume. Turning it off also applies on resume. A running Session keeps what it started with. |
| `copilot-sdk-engine` | GitHub Copilot through the Copilot SDK | Adds a GitHub Copilot engine (`copilot-sdk`) that drives your installed Copilot CLI through the Copilot SDK, with Station approvals, steering, rewind and subagent reporting. The engine appears at the next Station start after you turn it on, when `copilot` is on PATH. Separate from the ACP `copilot` connection. | Each message spends your Copilot requests. Uses the CLI's own sign-in. Approvals you saved in the Copilot CLI itself still apply. Not offered on hosted Stations; a managed policy with an allow list refuses it. Turning it off stops new sessions and messages; stop and open approvals stay available. See [the decision](https://github.com/kontourai/station/blob/main/docs/decisions/copilot-sdk-engine.md). |
| `station-orchestration-instructions` | Station orchestration instructions | Tells Agents that have Station control tools when and how to use them (delegating to another Agent, waiting on Sessions, browser and device tools). It rides the Agent's system prompt on Claude when the Agent has one, otherwise the first message of a new Session. | Adds a few thousand characters to each new Session's prompt. Applies to Sessions started after the change; resumed Sessions are not re-sent. Station control tool approval and access rules are unchanged. |
| `project-overview` | Project Overview | Groups a Project's Tasks by what they need next (Waiting on you, Ready for review, Working, Landing, Idle, Resolved), adds a Waiting on you dot to the sidebar and Room, and adds **Overview and notifications** to Project settings: when Idle Tasks resolve and when this Project notifies you. | One GitHub GraphQL read per unarmed open pull request to check the merge queue, shared for 150 seconds. Per-Project notification choices start applying to finished turns and approvals, including an existing **Mute this project**. |
| `learning-lifecycle-review` | Learning lifecycle review | Shows evidence, decisions, active guidance, effects and retirement in Project Sources. | Personal POSIX hosts only. Owner-reviewed activation can change future Task context; it does not install or deploy a Skill. |
| `project-pause-archive` | Pause and archive Projects | Offers **Pause** and **Archive** in Project settings. Both stop the Project's running chats and hold its turns and schedules until **Resume** or **Unarchive**. | Turning it off hides Pause and Archive but keeps every hold: a paused or archived Project still offers Resume or Unarchive. |
| `project-schedules` | Project schedules | Offers **Schedules** in Project settings and lets an agent propose a Project schedule. Each run starts a new Task in the Project. | Each run starts an agent and can spend model credits. Turning it off holds every Project schedule: none runs, and Run now is refused. |
| `context-compaction` | Context compaction | Offers a bounded summary cold start and opt-in threshold compaction where supported. | Summary generation can spend model tokens. Old messages stay retained; native tool and approval state is omitted, not transferred. Unknown capacity prevents automatic compaction. |
| `project-supervision` | Project supervision | Retains opted-in Task supervision and reconciles missed next actions through the conversation inbox. | Needs Coordinator chat. May queue model turns; current access, Task incarnation, waits, capacity and original delivery keys still govern placement. |
| `github-automation-actions` | GitHub automation actions | Dispatches explicitly granted, matching rules into durable Tasks and their first inbox turn. | Can spend model tokens under retained budgets. Off by default; observation alone grants no execution authority. Repair publication requires credential separation. |
| `isolated-github-repairs` | Isolated GitHub repairs | Runs explicitly granted GitHub repairs in Docker, retaining a Task and exact proposal for operator review. | Can spend provider credits. Separate single-use publication grants open drafts only; audit and cleanup remain available when disabled. |
| `session-goals` | Session goals | Adds engine Goal inspection and paused-objective editing to Chat settings. | The current Codex adapter supports read, save paused, pause and clear; Muse on `muse serve` supports read, pause and clear and reports no token or time figures. Activation and Station-managed goal loops are unavailable; reads do not start an engine. |
| `coordinator-session` | Coordinator chat | Lets you make one chat your personal agent ([Houston](https://github.com/kontourai/station/blob/main/docs/user/houston.md)), shown on Home and woken when work you can read needs you, fails or finishes. | Each wake is a model call. On an engine with Station tools it acts with your permissions. Turning it off keeps your choice of chat; nothing is woken and queued updates are not sent. |
| `coordinator-picture` | Coordinator working picture | Lets the designated coordinator keep short notes about readable work, shown on Home. | Needs Coordinator chat. Notes can contain work details; access to each source is rechecked. Finished notes expire after seven days. |
| `conversation-resolution` | Open and Settled inbox | Keeps conversations Open until explicitly settled. Task closure follows the existing Task close-on-merge setting. | Personal resolution state syncs across devices. Turning it off preserves saved choices and restores turn-based grouping; no provider cost. |
| `external-session-history` | Third-party history | In global History, browse older conversations and choose which to import. | Browsing reads local provider stores. Imports save messages in Station. |
| `appearance-studio` | Appearance studio | Adds visual background and styling controls, saved themes, portable theme files and inline chat proposal previews. | Off by default. Themes and images are stored per person on this Station. Disabling hides the new actions and retains the accepted appearance; approvals pause custom styling. |
| `attention-snooze` | Attention snooze | Lets the attention API temporarily hide any inbox item until a chosen time, up to 30 days. A newer source version resurfaces immediately. | Local per-user state only; no provider cost or background jobs. Off by default; disabling keeps saved snoozes but omits their effect while off. |
| `private-memory` | Private memory | Private memory you can check and search. New chats start with what you confirmed. No erasure yet. | Memory can contain personal information. Off by default. Only chats on the Station engine get the brief. Create it through the API. Disabling hides access but retains the store. Hosted Stations do not offer it. |
| `remote-task-engines` | Remote task engines | Lets you send coding tasks to cloud agents (Devin, GitHub Copilot cloud agent, Cursor Cloud Agents) that run on the vendor's machines, and catches up on their messages and pull requests. | Prompts and repository code leave this computer, and Station's sandbox and approval settings do not apply there. Each task spends your vendor account's credits. Every connection needs its own acknowledgement and token. A managed policy turns a vendor off unless `limits.engines.remoteTasks` names it. Station polls a task only while you have it open, and stops when it finishes. Turning the preview off stops sending and polling; removing a connection or its token still works. |
| `opencode-native-engine` | OpenCode native engine | New chats on an OpenCode connection run on Station's `opencode` engine. It runs OpenCode 2 through its own local server (`opencode serve`) when Station verified that version's API, and over ACP otherwise (OpenCode 1, another 2.x version, or a chat with an effort setting). An Agent's tool policy applies on both. | Existing chats keep their engine; turning it off runs `opencode` chats over ACP. A local `opencode serve` runs per connection and folder, and a chat with Station tool servers gets its own; one unused for 5 minutes stops. The managed-policy `acp` entry still governs and pins OpenCode. |
| `fleet-consumer-probes` | Fleet consumer probes | Sends a test request to a peer-contributed model before routing work to it. | Can spend a completion on another Station. |
| `integration-content-trust` | Integration content trust | Shows trust classification and after-untrusted-content permissions for integrations in Customize → Tools. | Saved choices remain effective when the preview is off; enforcement depends on the engine and integration path. |
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
| `task-resume` | Resume ended Tasks | Lets the Station operator, in person, move a done Task on a GitHub item back to ready within 14 days of its end, after reading its follow-ups (see [Resume an ended Task](concepts.md#resume-an-ended-task)). | Off by default, personal Stations only. Resume starts nothing; dispatch the Task to start work. Canceled Tasks stay ended. Agents, paired devices of other people, account members and GitHub comments cannot resume. Turning it off hides Resume; recorded resumes stay on the Task. |
| `pull-request-agent-feedback` | Pull request agent feedback | Sends a chat's agent one message when a pull request it owns has failing checks, unresolved review threads, a merge conflict or a merge queue removal. Also shows linked pull request status in Chats and on Tasks. Turn agent delivery on per pull request from the pull request's ⋯ in a chat's Details, or once for a Project in **Pull requests**. Tasks can also watch the pull requests they keep (Project settings → **Pull requests**, or **Watch pull requests** on a Task). | Uses the host's `gh` login and one GitHub API request per pull request every few minutes. Off by default, personal Stations only. Waits while the agent works or waits on you; pauses after 3 rounds on one push. A watching Task gets a set number of fix attempts, then waits for you; its agent may not merge, arm auto-merge or force-push, and asks you before changing CI configuration. |
| `pull-request-workspace` | Pull request workspace | Groups pull requests in Coding by chat, Task and branch, with search across the loaded rows and separate tabs for review details. | Off by default. |
| `pull-request-head-review` | Pull request head review | Runs Station's independent review once on each new head of a pull request a chat owns, and sends its required findings to the agent. Turn it on per pull request with "Review each new head". | Needs Pull request agent feedback. Uses reviewer agents (provider charges may apply); at most one review per Project at a time and 10 per day. Reviews the Project's checkout and never fetches. Pull requests already set to review resume when you turn this on. |
| `github-automation-observations` | GitHub automation observations | Observes configured GitHub workflow runs without starting agents. | Uses GitHub API requests and bounded private delivery storage. Off by default; management configuration is separate. Turning it off stops new observation effects and discards in-flight results; existing history remains. |
| `task-capabilities` | Task capabilities | Adds a capability and evidence path to Task Overview, with searchable Project tool setup. | Opening tool inspection reads configured catalogs and may contact their providers. It starts no Agent and changes no tools or permissions. |
| `task-review` | Task review | Adds Review, Timeline and committed-code review to eligible Tasks. | Sending comments starts or queues a lead-agent turn; code review may incur provider charges. Screen capture needs a committed workspace. |
| `guided-engine-setup` | Guided engine setup | Lets chat find setup pages; you review installation, sign in and choose Station tools in the engine pane. | Personal Stations only. Existing device permissions still apply. Turning it off keeps an existing install visible and stoppable, but starts no new one. |
| `member-passkeys` | Member passkeys | Lets invited people with Station accounts create an account, sign in and recover with a passkey (see [member passkeys](https://github.com/kontourai/station/blob/main/docs/guides/deployment-authentication.md#member-passkeys-feature-preview)). | Passkeys work only at the configured sign-in address, selected in Settings or supplied by `STATION_AUTHENTICATION_ORIGIN`; changing its hostname orphans them. Turning it off keeps stored passkeys, but they cannot sign in. |
| `apps-library` | Apps library | Adds a searchable launcher for your personal Boards and plugin layouts, with name, icon and description editing. | Uses existing personal-layout permissions; does not install plugins or grant access. |
| `inbox-task-questions` | Inbox Task questions | Shows a shortcut for open questions in desktop and mobile Inbox Task rows. | Opens the Task’s Plan tab. Existing Task permissions still govern answers. |
| `task-collaboration` | Task collaboration | Shows member names and presence in shared Task rooms. | Project membership and an explicit Task share are still required. |
| `chat-apps` | Chat apps | Shows integration capability status in Customize → Tools and write-back history in Task Details. | Status checks can run `gh auth status` on the Station host; an unverified result does not prove delivery. |
| `repository-auth-details` | Repository sign-in details | Shows the current Station’s GitHub CLI account, health and reported scopes in Project Sources. | Runs a bounded `gh auth status --json hosts --no-refresh`; no token refresh, credential transfer or repository-permission proof. |
| `cli-session-groups` | Session groups | Creates and supervises groups of local Tasks for explicitly bound external Engines. | Personal Stations. Running a group can spend provider credits. Turning the preview off stops new group operations. Tasks that already started keep their individual Session controls. |
| `staged-agent-changes` | Stage chat Agent changes | Lets a supported composer stage the Agent and model for its next message after reviewing what context carries over. | Sending starts a fresh Session on the selected engine and may use provider credits. Already accepted turns continue if the preview is turned off. |
| `continue-interrupted-turn` | Continue after restart | Offers **Continue** on a chat turn a Station restart cut off, which sends the agent a short note to pick up where it stopped. | Continue starts an ordinary agent turn, once per interrupted turn; it is never sent on its own. |
| `project-library` | Project Library | Adds a **Library** to a Project's **Files & connections** tab: files people add and files its Tasks keep, readable by every chat in the Project through `list_project_library` and `read_project_library_file`. | Uploads are stored on this Station, up to 25 MB each; hidden files and installed-package folders are skipped. Personal Stations only. Turning it off hides the Library and refuses its routes and tools; uploaded files are kept. |
| `continue-in-project` | Save to Project | Adds **Save to Project…** to a chat’s More menu and **Setup recommendations** to a new Project. | Review the drafted Task or Project before creating it. Saving leaves the original chat available. |
| `quiet-sidebar` | Quiet sidebar | Starts the sidebar with **New chat**, puts **Home** and **Automations** above Projects, lists your apps under **Apps** with **Discover** last, and pins labelled **Customize** and **Settings** rows to the bottom of the sidebar and the phone drawer. **Customize** shows a dot when one of its items needs attention. | Only the sidebar changes: every page it opens works with the preview off. Turning it off brings back the current sidebar. |
| `continue-unattended-after-restart` | Continue unattended work after restart | After a restart, continues Task and delegated work the restart cut off, once, with the restart note, oldest Task first. | Starts an agent turn per interrupted turn on its own; never for your chats, Automations or Tasks that are done, canceled or blocked. Waits for engine-start capacity. |
| `paired-station-chats` | Paired Station chats | Starts text chats on a paired Station from New Chat, with that Station’s Project picker, transcript, replies and approvals. | Personal hosts only. Uses the destination’s providers and credits. Off disables reads and new operations; saved tabs and unconfirmed messages remain. Existing remote Tasks keep their separate flow. |
| `visual-skills` | Visual skills | Offers installed visual skills in the start composer (**⋯ → Use a visual skill**) and the New Chat agent list. | Only the entry points are the preview: installing, validating and authoring visual skills work either way, and a chat already started with one keeps its skill view and any unsent next stage. Turning it off mid-draft stops New Chat showing or starting a chosen, unsent visual skill; turning it back on restores that choice. |
| `workload-budget-settings` | Workload budget settings | Shows a memory budget editor under **Settings → Advanced → Host options**: per-engine and total memory for engine workloads, beside the host's memory and where each value comes from. | Only the editor is the preview; budgets themselves are enforced either way. On a Linux Station service a lower budget kills memory-heavy commands sooner, and a total below current use is refused; an environment variable still overrides the saved value; elsewhere the values are only saved. Turning the preview off keeps saved values in force (save empty fields first to clear them). |
| `project-sharing-setting` | Project sharing setting | Shows **Project sharing with local accounts** under **Settings → System**, where the Station operator turns on invitations with username and password accounts and picks the sign-in address. | Only the control is the preview. Applying restarts Station through its process supervisor. Turning the preview off keeps the saved choice in force; environment variables set by the deployment always win. See [deployment authentication](https://github.com/kontourai/station/blob/main/docs/guides/deployment-authentication.md#turn-it-on-from-settings). |
| `project-coordination` | Project brief, memory and models | Starts every new Session in a Project with its goal, instructions and memory notes on every engine, and adds Brief, Memory, Models and effort, and Usage to Project settings ([details](#project-brief-memory-and-models)). | Adds the brief and memory index to each new Session's first turn, which costs tokens. Copies a Project's rules into its brief once. Turning it off stops adding them; saved briefs and notes remain. |
| `project-room-coordinator` | Coordinator in #general | Makes the Agent you ask in a Project's `#general` its coordinator: it answers, proposes Tasks on a card with **Start** and **Start all**, or sends your message to a running Task, and posts a link when each Task settles ([details](#coordinator-in-general)). Adds Project settings → **Coordinator**. | Each Task runs an agent and can spend model credits. Station enforces how many coordinator Tasks run at once, when they can start, and when guarded tools can open pull requests. Turning it off stops routing, starts and these refusals. Requires a personal Station with Project sharing and separate deployment sign-in disabled. |
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

Overview also offers **Code review** on personal hosts. Its checkout label,
branch and commit describe the Task's recorded working directory; they do not
establish where every linked conversation runs or whether dependencies are
prepared. Expand **Checkout and comparison** to inspect the path and base
commit. Assign a lead Agent and configure a different Codex Agent in the Project
to request a read-only review. Requesting review can spend provider credits.
When no reviewer is available, **Open Agents** leads to the existing Agent setup.

Reviews cover committed changes only. Reviewer failures and the comparison with
the current checkout are separate observations. A recorded review is neither
approval nor a passed gate. Refresh after changes to inspect freshness. If a
reply is lost, **Retry request** uses the original Project, request and commit
pair, including after reloading the same browser tab. Unavailable history is
shown explicitly instead of an empty review list.

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

**Settings → Voice** shows the providers available for this Station and this
device. If a saved choice disappears after a Station switch or a failed
capability check, the control shows an available provider or an empty list.

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

Enabling it also reveals six independent previews: **Flow delivery preview**,
**Veritas readiness preview**, **Trust preview**, **Sheet gestures preview**,
**Station routes preview**, and **Inbox row actions preview**. Each starts off
and is saved on this device. The tools require both Developer tools and their
own preview switch to be on. Turning Developer tools off makes them unavailable
without clearing those saved choices. These device previews are separate from
the Station-wide Feature previews above.

**Inbox row actions preview** adds desktop right-click (`ContextMenu` /
`Shift+F10`) row menus, durable chat/session/task ID copy, a desktop Details
metadata sheet, mobile selection Pin/Unpin and single-row ID copy, and a Pinned
shelf at the top of Chats (saved per authority on this browser).

**Sheet gestures preview** adds a drag handle to the top edge of sheets that
open from the bottom of a phone-width screen. Drag it up to expand the sheet to
nearly full height, drag it down to close the sheet, or tap it to switch
between the two heights. Closing this way is the same as choosing the sheet's
close button. Confirmation prompts and sheets that cannot be dismissed get no
handle, and the handle can only be dragged with touch or a pointer; the close
button and Escape still close every sheet.

The same preview lets you swipe a conversation left in the inbox to reveal
**Snooze** (clock) and **Mark done** (check), with larger touch targets and labels.
Swiping reveals the controls; tap one to act. Swipe right to hide them.
The row’s Details menu offers the same actions with the preview off.

**Station routes preview** adds **Routes** to the Devices page: every address
this device reaches the current Station on, which one is in use, which failed
and why, and **Add route** for an address you type. **Edit** removes routes you
added. While connected, the app also learns the LAN, Tailscale and Tailscale
HTTPS addresses the Station reports, marked "found automatically". Native apps
retain the saved canonical address; the host can temporarily admit published
HTTPS app origins for that same Station after checking its authenticated routes
and fresh public proof. Nearby hints alone never authorize credential use.
Installed-shell failover remains NOT_VERIFIED; see
[Station routes](https://github.com/kontourai/station/blob/main/docs/design/station-routes.md).

## GitHub automations

With **GitHub automation observations** on, this section lists the Automation
sources, rules, open episodes and recent deliveries. Each count is the number
of rows listed under it. A delivery held by a limit shows `suppressed` with the
reason. An exhausted episode offers **Retry episode**, which allows exactly one
more attempt under the rule as it is now. Creating and editing rules uses
`station automation`; see the [CLI reference](https://github.com/kontourai/station/blob/main/docs/reference/cli.md#automation).

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

In **Connect a Station**, choose **Nearby Stations** when discovery is available.
Select a suggestion to check its identity, then request access. Finding a
Station does not grant access or switch your selected Station; saving Device
access to another Station keeps your current connection.

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
The source update check belongs to the selected Station. When you switch
Stations or reconnect with different credentials, the earlier check cannot
supply the new connection's result.

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

## People and setup access

Open **Settings → People** to see who can connect. If your Device has limited
access, the section directs you to the Station operator. Importing Codex
prompts from **Skills** also requires permission. Ask the Station operator for
setup import access.

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
