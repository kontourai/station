# Getting Started

Station is a local-first workspace for agent work. This guide covers the ways
to run Station today, a verified macOS/Linux install when its release ring is
published, first launch, connection setup, and routine lifecycle.

## Ways To Run Station Today

Station is open source and under active development. Check the
[release list](https://github.com/kontourai/station/releases) for current
artifacts. Desktop updater channel tags and npm packages are separate from
the signed portable release rings used by the installer below.

| Path | Platforms | Use it when |
| --- | --- | --- |
| Run from source | macOS, Linux | You want the current `main` branch and are comfortable with a Node.js checkout. Follow the [developer guide](https://github.com/kontourai/station/blob/main/docs/guides/development.md#local-runtime). |
| Nightly desktop build | macOS (Apple silicon), Windows (x64) | You want a native app for testing. Choose a matching asset from the [Nightly desktop pre-release](https://github.com/kontourai/station/releases/tag/nightly-desktop) and check its version. Retained assets may be older builds. |

When a signed stable or beta portable ring is available,
[Install Or Upgrade](#install-or-upgrade) is the macOS/Linux installer path.
The remaining sections cover that install and the first-run UI.

## Before You Install

You need:

- Node.js 24.x
- npm 10 or newer
- git, curl, and tar
- [GitHub CLI](https://cli.github.com/) authenticated with `gh auth login`

Authentication is used for GitHub release metadata and attestation checks.
There is no unsigned fallback.

Optional, Linux only: a C++ toolchain (`g++`, `make`, `python3`) to compile
the `node-pty` native module that powers interactive terminal panes. macOS
and Windows use shipped prebuilds. Without a toolchain on Linux, Station
still installs and runs, but terminal panes are unavailable and `station
doctor` reports the degraded terminal capability with the remediation
(`npm run dependencies:install` after installing the toolchain, then
restart — that runs the reviewed lifecycle path, unlike a direct
`npm rebuild`).
Agent execution does not use `node-pty` and works either way.

## Install Or Upgrade

```bash
sh -c 'set -eu; file=$(mktemp "${TMPDIR:-/tmp}/station-install.XXXXXX"); trap '\''rm -f "$file"'\'' EXIT HUP INT TERM; curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh >"$file"; chmod 600 "$file"; GH_TOKEN=$(gh auth token) sh "$file"'
```

For an available signed release, the installer verifies its GitHub OIDC attestation and SHA-256
receipt before it builds and starts Station. The stable channel installs under
`~/.station/installs/stable`, writes runtime data to
`~/.station/instances/stable`, and owns the
`station` launcher in `~/.local/bin`. Open `http://localhost:18000` after the
command completes.

When a signed beta ring is available, export `STATION_CHANNEL=beta` before running the same
installer command. Preview is a release provenance name; the local runtime is
the **beta** channel. It uses a separate `~/.station/installs/beta` install root,
`~/.station/instances/beta` runtime,
`station-beta` launcher, and `http://localhost:28000` UI. Do not use the
retired `STATION_CHANNEL=preview`; the installer refuses it. The exact channel
identity, launcher, and port mapping are verified by the release installer.

An operator can instead supply `STATION_INSTALL_PUBLIC_MANIFEST_URL` for a
signed platform-v2 prebuilt archive. That macOS/Linux path uses bundled
Node.js without building Station on the host; it may download a pinned Node.js
to verify the first install. It requires a published manifest for the requested
channel. See the [archive install guide](https://github.com/kontourai/station/blob/main/docs/guides/release-channel-ports.md#prebuilt-archives-and-source-releases)
for this separate path and its upgrade and service limits.

## Choose A Model Connection Or Engine

Two kinds of connection can power an agent. A **Model connection** is a local
or hosted model service that Station's own engine runs inference on. An
**Engine** is an installed agent CLI, or a custom engine you connected, that
runs its own agent loop.

1. Open **Connections**.
2. On the **Models** tab choose a detected service or **Add model connection**;
   on the **Engines** tab choose a detected engine or **Add engine**. During
   first run, a detected Engine can be ticked to connect it and create its
   External agent in the same confirmed action.
3. Follow its setup action until it reports **Ready**.

For OpenAI's model service, supply its API key. A custom server may use another
supported authentication method or need no key. **Create** saves a Model
connection and checks it immediately; if its model list is unavailable, the
check may send a small, potentially billable test prompt using the default
model. Correct a refused check before expecting the connection to run work.

Read the accompanying evidence too. A saved connection or a live model catalog
does not prove that a chat turn completed. An explicit one-turn smoke supplies
that narrower proof and can incur provider charges; opening Connections or
New Chat does not run it.

For a credential-free first path, use a supported local model service and then
return to Connections. Startup can register detected Claude Code, Codex, and
Muse engines and their default Agents. An engine you explicitly removed is
not automatically added again. Registration does not prove that the engine is
signed in or ready. The discovery screen also offers other local suggestions
that you can choose to configure. The
[Connections guide](https://github.com/kontourai/station/blob/main/docs/guides/connections.md)
lists current integrations and their exact setup steps.

Choose the simplest path for what you want to do:

| You want to… | Start with… |
| --- | --- |
| Keep inference on this machine | A local Model connection and a Station agent |
| Use an existing agent engine | A supported Engine and its External agent |
| Use a hosted model through Station | A hosted Model connection and a Station agent |

## Start Your First Chat

Home and the chat dock have one way to start a chat: the start composer. Write
what you want done and choose **Start**. You do not need to choose anything
first; the two chips under the text box show what **Start** will use:

- The **Agent** chip shows the Agent's icon, then *Agent · Model*. Open it to
  list the Agents this project offers, each with its readiness and its setup
  action. An Agent's Model control opens the Model picker, including runtime
  options such as reasoning effort. Choosing a Model for an Agent also chooses
  that Agent and closes the picker; changing the effort leaves it open. Once
  you have chosen a Model, the picker's reset button names the default it
  returns to, such as **Use project default**.
- The **project** chip shows the project's colour and name, or **No
  project**. Open it to choose a project. The list shows each project's
  folder, and the folder this chat will run in. A project with no folder
  can be chosen too. Its chats run in your home folder, or, for an ACP
  engine, in that engine's own Working Directory or else a private folder
  Station makes for the chat; the chip and list say which.
- **⋯** holds **Use a visual skill**.

Choosing on a chip starts nothing, and Station remembers it. The Agent is
remembered for each project and for **No project** on this browser and
Station access, and the Model for each Agent. The project is remembered as the
chat dock's project for new chats, the same setting the dock's project
switcher changes, so Home and the dock always open on the same choices.
**No project** clears it.
Runtime options such as reasoning effort apply to that start only; they are
not remembered. A choice you make stays on both surfaces for this browser tab,
even if another chat later runs on a different Model, until you change it or
choose **Reset**.

Until Station has loaded your projects, the chips show placeholders and
**Start** waits, so a start never runs in a project Station has guessed. If
the project list cannot be read, the composer says so instead. A
chat started from Home opens in the chat dock's current project (by default,
the project you last opened), so that project's default Agent and Model apply.
With no Agent ready at all, **Start** still works: Station uses working
defaults, waits for discovery, and carries your original request into the
conversation. An already-ready engine can be prepared through the existing
idempotent setup path; installed, unconnected apps can be connected when
needed. Explicitly disabled apps remain disabled. A missing account,
permission, or working target is shown at the point where it is needed,
without claiming preparation succeeded. If the Agent Home chose cannot start,
the chat dock says so and shows the composer with your message, rather than
starting another Agent. If what Home sent cannot be read, or its Model is
no longer offered, the dock says so and keeps your message for you to choose
again.

Home keeps your message while you work. **Start** from Home removes the text
it sent once the chat has started, and keeps anything you typed while it
started. If you close the dock's draft instead, the message comes back to Home
as you left it in the dock, the same way as a draft from setup (below). If no
chat dock is open to take it, Home keeps the message and says so.

In the chat dock, the **New chat** button (the pencil on the collapsed bar),
**⌘T**, and **New chat** in **Chats and tasks** open the same composer.
**Explore agents** remains available for deliberate customization.

Setup from Home continues in the chat dock. When you choose **Connect**,
**Set up**, **Edit agent**, or **Use a visual skill** on Home, your message,
project, Agent and Model move into the chat dock's composer, which opens the
setup page or the skills list; Home says your draft moved. If you then close
that draft or cancel the setup return, the message comes back to Home as you
left it in the dock. If Home's text box is empty, it goes straight back in.
If you have typed something new meanwhile, Home keeps your new text and offers
**Restore your earlier draft** (which swaps the two, so neither is lost) or
**Discard it**. A draft waiting to come back survives reloading the page,
but not closing the tab.
**Enable** prepares an Agent in place on either surface.

Context handed to a new chat, such as a prepared request from a plugin page,
shows as a chip above the text box; tap it to leave it out. With no message,
**Start** puts the context in the new chat's composer for you to review and
send. With a message, Station sends your message, a blank line, then the
context.

**Fork from here** is not a new start: it keeps its own Agent list.
The usage disclosure ends after your usage decision. **Personalize Station**
opens optional preferences after the work entry; it is not a prerequisite for a
chat.
Closing preparation prevents a late response from starting work. The request stays
in the Home field while that Home view remains mounted and through the temporary
setup-return flow; changing Stations or authorization ends that flow.

When creating an agent, choose **Use a model connection** for Station's engine
or **Use an AI app** for Claude Code, Codex, or another connected engine. Those
apps run on the computer hosting your Station, including when you use a phone.
An agent's setup warning names that agent; other ready agents can still run.

At the end of first-run setup, choose **Start your first chat**. Station saves
any personalization answers you selected, then opens New Chat. Unanswered
questions add no profile. If saving those answers fails, setup stays open so
you can retry. Closing setup or navigating back during that save cancels the
next navigation; answers that already saved remain saved.

Opening the composer or changing a chip starts no conversation or engine;
**Start** opens the conversation and submits the message once. With no
remembered Agent, the composer uses the project’s **Default agent**, then the
current layout default or Station’s runnable suggestion. A remembered Agent
needing repair stays visible with its setup action; a removed choice asks you
to choose another.

**Continue working** shows up to five recent chats from the selected workspace,
using the inbox’s status and details. Choose one to resume it, or **View all**
to open the chat inventory. Loading and failed reads are shown separately from
an empty list. **Take the tour** and **Connect another device** are optional alternatives.
Both save the same selected answers before opening their next step.

On a phone, use the compose button at the right of the chat bar, or tap the
current chat title to open **Chats and tasks** and choose **New chat** at the
lower right. The three-dot menu holds chat actions; connection health remains
in the app header. In fullscreen chat, where that header is hidden, Station
management remains in the chat actions menu. **Projects** has the same add control
for creating a project, including a short first-project prompt when empty.

Selecting a project in the sidebar opens its workspace and makes it the default
for new chats. An existing chat stays with its original project. The chat bar's
**New chats** value lets you choose another default without leaving the workspace.
On a phone with a long chat title, that control shows only a folder icon.
The next sidebar project selection updates that default again.

To give a project an icon, open its settings and choose the icon beside its
name under **Basic info**. Station suggests artwork it finds in the project
folder, such as a favicon, app icon or logo, but applies nothing until you
pick it. You can also upload a PNG, JPEG, WebP or ICO image of up to 128 KB,
type an emoji or short symbol, or choose **No icon**, then **Save**. The New
Project dialog offers the same choices. Links and file paths are not accepted
as icons; if a project's existing icon can't be shown any more, such as one
saved as a link before that, its settings say so and ask you to choose a new
one. The icon appears beside the project in
the sidebar, the project switcher, Home and chat rows, their details, and on
the project page. Without one, those rows show the project's colour and the
project page shows its initials. A row for work on another Station shows
neither, since its project belongs to that Station.

### Prepare a visual skill

Choose **⋯** then **Use a visual skill** in the start composer to browse
installed visual skills, including when only one Agent is ready. A card describes its purpose, example and owning plugin. Choose
a card and fill its text or choice inputs, then choose an Agent, Model and
workspace. This prepares an unsent chat. Attach any required files using the
ordinary composer, assign files to the named roles when shown, and send
explicitly to start. Stations that expose inventory without execution support
show previews and refuse starts.

Guided mode keeps the preparation or recorded stage above the conversation.
Alongside chat places it beside the conversation on wide screens and above it
on phones. Chat mode keeps the same conversation with a compact skill header.
Questions, approvals, transcript, artifacts and Stop keep their ordinary
conversation controls when switching modes. Declared outputs are expectations;
actual results appear when the Agent produces them.

The prepared selection, scalar inputs and inert composer file-role choices
persist with the selected Station's scoped chat draft. Reload restores a bounded
display preview; Send checks the current installed source again. A failed, busy
or offline send retains that selection and
never queues it for automatic replay. A changed source requires a new review.
Use **Remove unsent visual skill** to deliberately return to ordinary chat.
**Prepare another stage in this conversation** binds a new unsent preparation
to the current recorded stage; sending still requires the same source to be
available. **Browse marketplaces** opens Registry while retaining the picker
inputs and choices. Return or browser Back refetches the inventory and setup;
it never installs a plugin or starts the skill automatically.

A source can declare other named stages or a rich view. Preparing a named stage
keeps this conversation and checks the same installed package. **Open declared
rich view** uses its existing workspace pane occurrence and isolated host;
when the pane, source or permission is unavailable, the guided controls remain
available. Rich views can answer current nonsecret question rounds and prepare
an unsent next stage. Secret questions and tool approvals use the ordinary
conversation controls.


### Finish setup and return

When no selected Agent can respond, the composer shows a setup helper alongside
your message and recent chats. It offers AI app setup, model-account setup,
and a recheck. Available engine prerequisites include installation steps,
commands, and links supplied by that engine’s integration. Commands are shown
for you to run; opening a guide does not install software. Install AI apps on
the computer hosting Station, including when using Station from a phone.
Claude and Codex account management opens their existing in-UI sign-in flow;
other integrations retain their own authorization instructions.

If New Chat offers **Connect**, **Set up**, **Edit agent**, or **Set up
Connections**, use that action to open the owning setup page. The picker steps
aside while keeping your chosen workspace, Agent, Model, and selected context.
From the composer, use **Return to New Chat** when finished, or browser
Back to return to the page you left. Station rechecks setup before selection;
that manual return sends no message. For a written Home goal, readiness of the
selected agent returns you automatically and resumes the original request after
revalidation. A failed read keeps the request unsent. If a choice was removed or
access changed, choose an available option.

**Cancel return**, opening a fresh New Chat, navigating elsewhere, changing
Stations or authorization, and reloading the page end this temporary return
flow. Connection changes you already saved remain saved.

### Keep a scheduled-job draft through setup

If Add Job needs an agent, use its setup action. Station prefers repairing an
existing eligible agent's model connection or configuration; it offers agent
creation when none exists. The dialog keeps its name, instructions, schedule,
provider and other fields while the setup page is open. Browser Back or the
return action restores that draft; verified readiness returns automatically.
An existing job waits for its selected agent to be ready before returning.
The job is saved only when you submit it. Changing Station or access, cancelling
the return, or reloading ends this temporary draft journey.

Opening a page through app navigation reveals that page instead of
leaving it under maximized chat. On a phone, chat collapses so the destination
can use the screen. Explicit maximized conversation links still
open chat at their requested size, and the prior chat size remains available
when you return to the conversation.

### Send a follow-up while an engine works

Keep typing during a turn. **Send** defaults to **Queue**, which delivers after
the turn finishes; its dropdown offers **Steer**. Claude Code and Codex can take
native steering. Other engines hold steering until a safe boundary can be proven;
currently they wait until the turn finishes. Each pending row shows its mode.
**Send now** deliberately stops the active turn immediately and sends the
selected message after Station confirms the stop. **Stop** remains separate.

Quiet turns show elapsed silence without guessing that an engine retried. Retry
status appears only when the engine reports it. The Drafts icon saves and restores
unsent composer content; the trash icon clears the current message. Hold or focus
either icon to read its label. Choose **Chat settings → Return in chat** to change
Return behavior on this device. Touch devices default to a new line; desktop
Return sends. Shift+Return adds a line and Ctrl/Cmd+Return sends.

### Reference project files and earlier conversations

In a project chat, type `@` followed by part of a file or folder path, then
choose a result. A message can contain up to 64 file or folder mentions.
Station keeps a compact chip in the draft. When you send the message, it
expands the selection to a quoted full path within the selected workspace. Saved drafts retain the chip. If the
workspace changes, or you reconnect or re-pair with different access, Station
refuses to send the stale reference until you remove it or return to its
original scope.

Use the conversation-reference button beside the composer actions to choose an
earlier conversation. The picker searches the 25 most recent conversations
returned for your access and shows up to eight matches; it does not search
older history. You can also drag a result into the composer, or drag a
conversation's row from Activity or the inbox. A message can
contain at most eight conversation references. Station
sends a link to the selected conversation, plus one line naming its id and
asking the receiving Agent to read it with the `read_conversation` tool; it
never copies that conversation's transcript into the prompt. An Agent with
Station Control can then page through that conversation because you
referenced it; see
[reading a referenced conversation](../guides/self-configuring-agent.md#reading-a-referenced-conversation). Titles are displayed as plain text, and the link is
generated from Station's conversation identity. The picker only offers source
metadata allowed by the current access. At send time, Station checks the
reference's captured Station and access scope. If that scope
changes before send, Station refuses it instead of silently resolving it under
the new account. Hosted/shared destinations do not offer conversation
references until the server can prove that exposing the source title and link
to that destination is permitted.

## Use a skill

Open **Skills** and search the loaded library by name or description. Select a
skill to read what it does, where it came from, and which template inputs it
needs. **View instructions** shows the original instructions. A source label
identifies where Station loaded the skill; it does not establish publisher trust.

Choose **Use in a new chat**, fill any required inputs, and select an Agent.
Blank optional inputs use their declared defaults. **Preview instructions**
shows the message with those values applied. **Start chat** opens a new chat
and sends that message. This does not attach the skill to the Agent or install
its dependencies; the Agent's configured tools and permissions still apply.

To add skills, choose **Browse Registry Skills** and inspect the available
catalog before installing. **Import .md** accepts standalone Markdown skill
files and reports the outcome of each file. Open an imported skill from its
result to review and use it. Import does not copy a repository's
scripts or supporting files. Load plugin packages through Registry.

For a writable skill, **Edit skill** opens its definition and command settings.
**Back to overview** asks before discarding unsaved edits. Package-owned or
plugin-served skills show the server's read-only reason and keep editing
unavailable.

## Start Your First Task

1. Open a Project and create a Task for work you want to keep.
2. Choose an Agent that is ready to run.
3. Open the Task to follow its Sessions, files, artifacts, and evidence.

After first-run setup, Home can offer **Start your first task** for a confirmed
Project. It uses the ordinary Task form. If the Agent is unavailable, Station
shows the setup reason without creating a Task. If a start has an uncertain
outcome, inspect that Task rather than creating another to retry it.

Task status alone does not establish that work passed a gate. Read the run and
review evidence. The [Starter Work guide](https://github.com/kontourai/station/blob/main/docs/guides/starter-work.md) explains
how Station preserves the same work identity through retries and response loss.

## See Conversations Started Outside Station

**Activity** also lists Claude Code, Codex, Grok and OpenCode conversations
you ran in a terminal or another app on this machine. Station reads them; it
never controls them. It looks in four places:

- Claude Code transcripts under `projects` in `CLAUDE_CONFIG_DIR`, or
  `~/.claude` when that is not set.
- Codex sessions under `sessions` in `CODEX_HOME`, or `~/.codex` when that is
  not set.
- Grok Build sessions under `sessions` in `GROK_HOME`, or `~/.grok` when that
  is not set. A Grok session appears once it has a prompt. A subagent's own
  session is not listed separately, and neither is a Grok chat you started in
  Station, which is already there.
- OpenCode's session database, `opencode.db` or `opencode-<channel>.db` (for
  example `opencode-stable.db`), in `opencode` under `XDG_DATA_HOME`, or
  `~/.local/share/opencode` when that is not set. Station opens it read-only
  and lists top-level OpenCode sessions you have sent a message in; subagent
  sessions and archived sessions are left out. A message appears once OpenCode
  has finished writing it. Conversations Station itself runs through an
  OpenCode connection are not listed a second time. Older OpenCode releases
  kept sessions as JSON files under `storage`; Station does not read those,
  and current OpenCode moves them into the database when it starts. If an
  OpenCode update changes the database layout, Station stops reading it and
  logs one warning instead of guessing.

`STATION_EXTERNAL_CLAUDE_SOURCE_ROOT`, `STATION_EXTERNAL_CODEX_SOURCE_ROOT`,
`STATION_EXTERNAL_GROK_SOURCE_ROOT` and `STATION_EXTERNAL_OPENCODE_SOURCE_ROOT`
point Station at a different folder (for OpenCode, the folder holding the
database). Station checks every two seconds and reads the 128 most recently
changed conversations from each place. Older ones stay in Activity once Station
has read them, but new messages in them are not picked up until they are among
the 128 again.

Each conversation is filed under a Project by the folder it ran in:

1. A Project whose folder contains that folder. When two Projects share the
   folder, Activity names both rather than picking one.
2. Otherwise, a Project whose folder is in the same git repository. Every
   worktree of the repository counts, so a conversation in
   `../station-worktrees/fix-login` or another tool's worktree folder files
   under the Project on the main checkout. A Project on a subfolder of the
   repository takes that same subfolder in every worktree.
3. Otherwise, **No project**. Choose **No project** in Activity's **Project**
   filter to list these.

A conversation keeps its Project after its worktree is removed. If its Project
is deleted while other Projects remain, it moves to **No project**. A conversation inside a git submodule
of a worktree outside the Project folder also lands in **No project**: Station
follows the submodule's own `.git`, which belongs to a different repository.

If a conversation ran in a folder on a network drive that has stopped
responding, Station can't tell which Project it belongs to. A conversation
Station has already filed keeps its Project. A new one is listed under
**No project**, and Station tries the folder again about once a minute. Once
the drive responds, the conversation moves to its Project.

Station copies what it reads into its own history and search index, so a
conversation stays in Activity and in search after the original transcript is
gone. You can open these conversations, and so can every device you have
paired with Activity read access, including a phone.

To stop reading conversations from folders outside your Projects, turn off
**Conversations outside projects** in **Settings → Advanced** (under Station host), then **Save**
(`attachedSessionsOutsideProjects` in the Station configuration). Station stops on its
next check, including for conversations it already lists: new messages in
them no longer arrive. What it already read stays in Activity, in search and
readable from your paired devices; turning the setting off removes nothing.
Conversations inside a Project are read either way.

A hosted Station never reads conversations outside your Projects. It reads the
ones inside a Project, but no account can open them there.

## Continue an Attached Session

Open an attached terminal Session in **Activity**, then choose **Continue in
Station**. Claude and Codex create independent child Sessions; the original
terminal Session can keep running. OpenCode conversations are read only: the
action shows why it is unavailable. Codex continues from the latest completed
turn Station has observed, so wait for one if the action is disabled.

The continuation always works in the folder the conversation ran in, and the
engine is confined to that folder. Station checks the folder again when you
continue:

- A conversation filed under a Project continues under that Project. This
  includes one in a worktree outside the Project folder: it continues in that
  worktree. Station refuses if the worktree was removed or replaced, or if its
  `.git` does not lead back to the Project's repository.
- A conversation under **No project** continues as a **No project** chat
  confined to its own folder, after you confirm that choice. This is allowed
  only for a folder inside your home folder. Station refuses your home folder
  itself, every folder outside it (system folders included), any hidden
  folder directly in your home folder and everything in it (such as `.ssh`,
  `.aws` or `.config`), `Library` on macOS and `AppData` on Windows, the
  system temporary folder, and Station's own data folder. It also refuses
  when the folder shown reaches another folder through a symbolic link
  inside your home folder. To
  continue such a conversation, add a Project for that folder or its
  repository. Station does not move a conversation into another Project's folder,
  because its history refers to files in the folder it ran in.

A hosted Station does not continue conversations outside your Projects.

An attached Session remains read only. Continuing opens a Station-owned child.
If Station cannot confirm the result, use the offered retry for that same
operation. Engine and configuration problems appear with their setup reason.
A continuation receipt confirms admission, not completion of the work.

The continuation runs as the engine's own Agent on this Station, the one New
Chat sets up for Claude Code or Codex. That is what lets it open as a chat in
the dock and take your next messages there. Those messages keep working in
the conversation's own folder, including a folder inside the Project or a
worktree, never the Project folder instead. If Station has no Agent for that
engine, the continuation is still created and you continue it from
**Activity**; the dock says why it cannot open it.

See [continuation and recovery details](https://github.com/kontourai/station/blob/main/docs/guides/starter-work.md#continue-an-attached-session).

## Arrange Work You Already Own

In a Project, use **Add Pane** and choose **Work Board** to arrange exact
references to current work. It does not replace Home or create a new route.
See [Work Board](work-board.md) for pinning, keyboard controls, recovery, and
the meaning of linked-work states.

## Inspect Approval And Review Evidence

Home can offer a real approval notification or independent-review receipt to
inspect after first-run setup. The approval action opens that Notifications
row; it does not approve or deny it. The review action opens the receipt in its
Project's Review layout. Missing or unavailable records remain visible as such.

Reading a receipt does not satisfy a gate. See
[how the inspection keeps the exact target](https://github.com/kontourai/station/blob/main/docs/guides/starter-work.md#inspect-approval-and-review-evidence).

Home keeps unattributed chats visible in its activity chart. Its work counters
show states such as Running and Needs you; activity groups are not a count of
configured Projects.

## Run A Scheduled Readiness Check

To create an ordinary scheduled job, use an agent with a model connection
(Station's engine). AI app agents cannot run scheduled jobs. If none is ready,
the job form offers **Set up a scheduled-job agent** to open agent creation;
choose **Use a model connection** there.

Home can create **station-starter-check** and run it once. Its daily schedule
stays disabled until you enable it. Open the receipt to read the findings;
a completed run means the check ran, not that its findings passed a gate.

After an interruption, **Resume exact check** continues the recorded check.
Failed or uncertain runs offer **Inspect receipt**. They are not restarted
automatically. See [Scheduler identity and recovery](https://github.com/kontourai/station/blob/main/docs/guides/starter-work.md#run-a-scheduled-readiness-check).

## Update, Stop, Or Uninstall

### Recovery boundaries

Use the recovery path that owns the thing you need to recover. The bundled
client's `station triage` gathers bounded, read-only artifacts; it cannot run a
local source doctor. Run `./station doctor` from a checkout (or portable
release) for host diagnostics. Installer rollback concerns a released program
candidate; `station home backup` and `station home restore` concern one inactive
runtime home and retain the replaced home. They are not interchangeable.

Run the installer again in the same channel to update safely in place. To stop
and start the stable local Station manually:

```bash
station stop
station start
```

To uninstall the stable program while preserving Projects, connections, Tasks,
and Sessions:

```bash
STATION_CHANNEL=stable "${STATION_ROOT:-$HOME/.station}/installs/stable/current/install.sh" uninstall
```

Use
`STATION_CHANNEL=beta "${STATION_ROOT:-$HOME/.station}/installs/beta/current/install.sh" uninstall`
for beta. Add
`--purge-data` only when you also intend to delete that channel's home
(`~/.station/instances/stable` or `~/.station/instances/beta`). The installer accepts purge only
for a data root it created and marked; it preserves an unmarked pre-existing
directory for manual review.

## Next

- Read [Station concepts](concepts.md).
- Customize [keyboard shortcuts](../guides/keyboard-shortcuts.md).
- Review the [Station privacy policy](https://kontourai.io/privacy/station/).

## Inspect a learning source

Open **Developer → Memory** and select a record from a personal Default File
Store, then choose **Inspect learning source**. If Developer is hidden, enable
developer tools in Settings. The inspector requires local access to the Station
that owns the store; remote pairing or an operator API credential alone is not
enough. Hosted Stations and tenant-scoped requests are not supported by this
personal-store inspection.

The inspector shows the source text, provenance, and observation time. **Refresh
source** reads it again. If the store was replaced, access changed, or the source
cannot be verified, the old content is withheld. Inspection does not repair or
change the source.

A record marked active is not evidence that a learning was activated. This view
shows source records only; candidate decisions, active learning revisions, and
observed effects require records from their respective owners. It offers no
promotion or retirement action.

## Return to a decision

Open Notifications to find work that needs your attention. When an approval or
permission has recorded request evidence, **Inspect request** opens its current
details. Choose **Approve once** or **Deny** only after reviewing the request.
You can expand **Request identity** for its exact record or open the Session for
more context.

For a task that runs on a paired Station, the card shows **Allow** and **Deny**
for that Station's approval when your access here permits it. The paired Station
checks that the request is still open and makes the decision. Its questions are
answered on that Station.

A resolved or changed request must be inspected again from refreshed attention.
A request that cannot currently be answered remains visible without decision
buttons. If the decision cannot be confirmed, **Check request again** refreshes
its state before another attempt. Other notifications retain their existing
Session and action controls.
