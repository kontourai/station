# Getting Started

Run Station on your computer and connect an agent such as Claude Code or Codex.
This guide covers installation, your first chat and Project, connecting a phone,
and keeping Station updated. To share a Project with someone, read the
[sharing setup and current limits](https://github.com/kontourai/station/blob/main/docs/guides/deployment-authentication.md).

## Quickstart

1. [Install Nightly](#install-nightly) on the computer that will run Station.
   Open the app or use the single-use sign-in link printed by the installer.
2. On Home, open the Agent control beside **Start** and choose an Agent that is
   ready. If Home offers **Set up an agent engine**, use that action to open
   Connections. For an existing Codex account, follow
   [First chat with Codex](#first-chat-with-codex).
3. Try a small request such as “Give me three questions to check before I
   review a documentation change. Use no tools.” Choose **Start** to open a
   direct chat.
4. Read the answer in the chat. If an approval or question appears, inspect
   it before responding. To inspect the recorded inputs, choose **Basis** on the
   answer. On a phone, open the answer’s **⋯** menu to find **Basis**.
5. Keep talking in the same chat, create a Project for shared context, or
   track a deliverable in a Task. [Choose what fits](concepts.md#choose-a-project-task-or-direct-chat).

### How a turn works

```text
Write a request and choose Start or Send
                    ↓
The selected Agent runs one turn in a Session
                    ↓
It may ask you a question or request approval
                    ↓
Station shows the answer, stop, or failure
```

A follow-up can add another turn to the same Session. See the
[visual walkthroughs](https://github.com/kontourai/station/blob/main/docs/learn/walkthroughs.md)
for Gallery captures of the interface. The
[Learn Station atlas](https://github.com/kontourai/station/blob/main/docs/learn/README.md)
explains how the parts fit together.

## First chat with Codex

If Codex is installed and signed in on this computer, you can use that account
without adding a model API key:

1. Start Station using one of the paths below. For a source checkout, follow
   the [README commands](https://github.com/kontourai/station/blob/main/README.md#run-from-source-macos-linux) and open
   the single-use sign-in link printed by `./station start`.
2. Open **Customize** (the sparkle icon at the bottom of the sidebar) →
   **Connections** → **Engines** → **Codex**. Confirm the account is signed in.
   **Check connection** sends a short message using your model allowance.
3. An empty Home guides you through choosing an agent and optionally adding
   files. **View available agents** opens the agent list; **Set up an agent
   engine** opens Connections when no agent is runnable. On Home, open the Agent/model control beside **Start**. Choose
   **Agent**, then **Codex**, write a request, and choose **Start**. You can start without a Project. The detected Codex Agent is
   enough; creating a custom Agent is optional.
4. Choose **New Project** on Home. **Blank workspace** creates an empty
   Station-managed directory when your workspace mode allows it. Choose
   **From a repository** to acquire a Git checkout or, on the Station host,
   choose **Use an existing folder** to reuse one. For Git acquisition, open
   **Start from a Git repository**. Choose **Git URL** to paste an HTTPS or
   SSH URL, or use the **GitHub** or **GitLab** tile to browse with a signed-in
   account on the Station host. Choose **Acquire
   repository**, then **Use this checkout**. Station suggests a name until
   you edit it. Creation rechecks the acquisition and retains its source and
   exact commit. Station recommends **Coding** when the folder is a Git
   workspace. Choose **Create** to open the Project, then add documents or
   connected tools in **Files & connections**.
   Operator setup is saved across reloads. Reopen **New Project** to continue
   the same creation and starter. See [repository setup and recovery](https://github.com/kontourai/station/blob/main/docs/guides/connections.md#start-a-project-from-a-repository)
   and [document import](https://github.com/kontourai/station/blob/main/docs/guides/knowledge.md#import-documents-from-your-computer).
   From a chat draft, open its Project picker and choose **Create project**.
   Enter a name for a blank Project or choose what to start with. Station
   selects the created Project and keeps the draft ready to send.
5. To talk to the built-in **Station Assistant** using the same Codex account,
   open **Settings → General → Built-in agent engine → Change…**, choose
   **Codex**, choose **Use this engine**, then **Save**. Open the Agent/model control beside **Start** or **Send**. Under **Agent**,
   select **Station Assistant**. Ask it to list your projects to exercise a read-only
   Station tool as well as chat.

For a customized Codex Agent, open **Customize → Agents → New agent → Use a
connected engine**, enter a name, select **Codex**, and choose its model and Project.
In **Tools**, choose **Station** to add read-only controls; expand the row to
inspect the selection. Save with **Create agent**, then choose it in a new chat.
Codex receives your instructions with the first message in each new chat, at
the same priority as that message. (With the **Station orchestration instructions** Feature Preview on, an Agent that has Station controls also gets Station's own guidance on using them in that first message.) You can edit or clear them before saving. See the [Agents guide](https://github.com/kontourai/station/blob/main/docs/guides/agent-configuration.md#mcp-tool-configuration)
for tool selection and approval details.

In **Coding**, use **Files** to open a project file, **Diff** to inspect changes,
and **Terminal** for a shell. These controls sit in the right-hand rail. Chat
and its inbox remain available alongside them. A successful answer to a file
question and a successful Station tool call establish different capabilities;
check both before relying on the Agent for work.

If Terminal loses its connection, it keeps its output visible and offers
**Reconnect terminal**. Commands typed while disconnected are not sent or
replayed. Reconnecting can reattach a retained shell; restarting Station may
end that process and open a new shell with the same tab identity. On a phone,
the terminal also offers **Ctrl+C**, **Tab**, and command-history arrows.

New installations start without importing conversations outside your Projects.
To include those later, turn on **Conversations outside projects** in Settings.
Existing installations retain their choice and previously imported history.

## Inspect what a chat used

Choose **⋯** then **Chat inventory** in the chat header. Pick a group,
then **View details** on an item to read the authored message, attachment
metadata, or recorded tool result. **Recorded origin** identifies the Session,
turn and event; **Open session** opens the surrounding work. Output rows keep
their **Inspect output** action. Items that cannot be read show an unavailable
state rather than an empty result. For a single answer, choose **Basis** from
its footer on desktop or its **⋯** menu on a phone.

To see how much of the model's context window a chat has used, read the meter
beside Send under the message box, or choose **⋯** then **Conversation
stats** in the phone chat header, which names the share used. Either opens the
chat's stats.

## MCP app previews in chat

In Station's web client, a completed MCP call can show its declared app directly
below the tool row. No layout pin is needed. The integration must still be
connected and permit rendering, and its current tool definition must declare a
UI resource. Station's own inventory and Basis Apps use shipped resources and
can mount when Codex owns the default Agent without a Station-engine connection.
Inventory App data publication is currently unavailable; frame mounting does not
change that limitation.
The result itself needs only the standard MCP content envelope. Reloading and
opening the saved conversation mounts its retained preview again; Station does
not call the tool or start a disconnected third-party server to display it.

App membership is cached for five minutes. New declarations may wait for a
stale query to refetch on mount or focus; reload to refresh the catalog. Read-only
paired devices may discover and view previews.

The Codex adapter preserves complete MCP results with canonical server/tool
identity. Claude-provider MCP calls cannot mount: their output is summarized to
text and their flattened names lack unambiguous server identity. ACP and managed
engines have not been qualified. Ordinary calls keep their rows and batching.
Sample and offline views outside the connected workspace keep ordinary rows
without app lookup. Unknown or disconnected integrations add no app card. Result UI metadata alone
cannot mount an app or authorize a resource read.

The preview follows your theme and labels interactions as unavailable. App tool
calls, resource reads, messages and links are refused in transcript previews.
Fullscreen and model-context notes are not supported there yet. Native shells
continue to refuse scripted MCP frames; use the web client for these previews.
See the [host design](https://github.com/kontourai/station/blob/main/docs/design/mcp-ui-host.md#transcript-previews) for the
capability boundary and remaining work.

## Connect your phone

Your computer runs Station and the agents. Your phone connects to it to read
replies, continue chats, and review work. Start on your computer:

1. Install and launch Station there using the options below.
2. Open the Station name at the top of the computer’s window and choose
   **Pair phone**. Station opens straight to a pairing code on a reachable
   HTTPS address, and lists any other HTTPS addresses to switch to.
   **Settings → Pairing → Pair device** opens the same screen. Any of your own
   paired devices with full access can do this, not only the computer. On a
   phone the same choice reads **Connect another device**. If your
   organization's policy allows only this computer to connect, these are
   turned off and say so.
3. On a new phone, open Station and choose **Scan pairing QR code**. Scan the
   invitation from the computer. **Enter a pairing code** is available if the
   camera cannot be used. Keep the computer running.

Scanning a pairing code on the phone needs a reachable HTTPS address, such as
the computer's Tailscale HTTPS address, which Station lists first when it is
configured. Both devices still need access to that address.

For local network access, enable **Settings → Pairing → Discover this Station
nearby** on the computer, then choose **Find nearby Stations** on the native phone
app (on the welcome screen it is under **More ways to connect**). Discovery is
off by default and shows names and local addresses without
granting access. Select the intended computer, confirm the exact address and any
unencrypted HTTP warning, request access, and approve on the computer. Android
versions before Android 14 offer QR and manual address entry instead. Browser
clients do not browse the local network. Choose **Enter Station address** to
type an address when discovery is unavailable or finds nothing.

If an exchange loses its response or cannot save approved access, Station holds
the attempt instead of sending the one-time proof again. Choose **Pair again** to
send a fresh request; approving it replaces any access the held attempt left
behind, so you don't need to revoke anything on the computer first. For a
pairing code, create a new code on the computer.

A new phone shows the connection welcome until you save a real Station.
A saved Station that is offline or needs access keeps its connection recovery
controls instead. The welcome does not run workspace queries against an
unconfigured endpoint.

Station's phone apps are not in public app stores yet. Android builds reach
testers in a Google Play internal testing group and iOS builds reach invited
TestFlight testers. Without one of those, open the Station's reachable address
(see below) in your phone's browser instead; the browser offers the same
**Pair with a code** step and **Request access**.

A browser opened with the host's one-time sign-in link can create invitations
and manage paired devices. Choose Read-only, Standard or Full device access
before creating the invitation;
anyone holding it can pair once before it expires, without another approval.
Cancel an unused invitation to prevent it being redeemed. Revoking a paired
device removes access it already received.

For a terminal-only host, run `station-nightly environment offer` on the
computer running your Nightly install (or `./station environment offer` from a
source checkout). This prints a single-use invitation with Standard access.
Use `--scope=orchestration:read` for read-only access or `--require-approval`
to review the recipient before granting access.

A browser that arrives without an invitation can choose **Request access**.
Approve that request in a trusted session or with the displayed command on the
Station host. Bare host-approval commands discover the running Station in the
selected local home before consulting saved Station defaults, so a saved remote
Station does not override that local instance. Use the same home and channel
that started Station; a remote host requires running the command there, such
as over SSH.

The address in that invitation must be reachable from your phone. `localhost`
means the device you are using, so a computer’s localhost address does not reach
it from a physical phone. Use the reachable address shown in the pairing flow;
see [Connections](https://github.com/kontourai/station/blob/main/docs/guides/connections.md)
for remote access. A pairing code grants access; it does not create a network route.

If you have no Station yet, install and open it on your computer using the
options below. The phone's connection manager offers QR scanning, pairing-code
entry and **Connect a Station** for a host address. Broker route setup is a
separate advanced option. You can start with an ordinary chat; custom Agents,
remote tasks, and layouts are optional.

## Preferences across devices

Open **Settings → General → Your account** to set the approval default for your
new Codex, Claude or Muse chats. You can also use the chat's approval picker and
choose **Save as my … default**. Full access requires an explicit
confirmation. An Agent's own default takes precedence over your personal
preference; an explicit chat choice takes precedence over both. Existing chats
and unattended jobs keep their settings. Device grants and Station policy still
control what may execute.

Appearance, chat display, answer delivery, diff preferences and model-picker
choices follow the same signed-in person across devices connected to this
Station. They are saved as you change them, and other clients refresh on focus
or reconnect. **Import previous preferences** brings over this browser's older
portable choices without replacing settings your account already has. **Use
default** removes a personal display choice; choosing **Default** for a
new-chat approval mode returns it to the Agent, Station or engine setting.

While offline, changes wait on this page and are not saved yet. Keep the page
open until saving finishes. If another device changed a composite preference,
**Reload saved preferences** shows the current choice before you try again.

Microphone/output providers, push permission, haptics, keyboard behavior and
shortcuts, screen layout and device access stay on the device. Settings labels
which scope owns a choice. If your Device is not linked to a person, preferences
remain local. Different Stations keep separate account preferences.

The approval chip shows the known mode, including **Full access**, **Auto** or
**Ask**. **Default** means the engine's own settings apply and its active mode
has not been confirmed.
For Codex, inherited settings resolve to a supported mode when the reported approval policy and sandbox match. Otherwise, the picker describes the engine default as your own Codex settings. If you set
none, no command Codex runs uses the network or writes outside the chat's
folder and temporary directories without asking; it may ask before other
writes too. Codex's web search and MCP tools are not commands and are not
covered by this. Open the picker to see the source, the confirmed mode and whether a request takes
effect next turn or requires restarting the session. A Claude chat started in a
chosen mode by someone who may grant full access can switch to full access on
its next turn. A chat left on Claude's own settings, or one that started before
this was available, gets full access on its next turn too: Station relaunches
Claude Code first and resumes the same conversation. A chat that is waiting on
you or still running background work, or one on a Station running as root
outside a sandbox, needs a restart.

## Read recent conversations offline

In the browser, open **Settings › Privacy & sharing** and enable **Save offline
reading copies**. It starts off. Then open conversations while connected to save
text from their most recent history read: at most 20 conversations, 10 recent
turns per conversation, 256 KiB per conversation and 2 MiB in total. Copies expire
after 24 hours or a build change. Tools, reasoning, attachments and provider
recovery state are excluded. A running answer is captured after its history is
read again; this is not a continuous backup.

Message text can contain pasted secrets. These local IndexedDB copies have no
additional encryption, and anyone using this browser profile can read them
while offline. Enable this only on a device where that trade-off is acceptable.
**Clear offline copies** deletes the saved text and turns saving off. Signing out,
changing credential authority or account, or switching Station also clears the
copies. A build change also turns saving off with the expired copies, so enable it
again after an update. Reachability failures leave saved copies and the saving
preference intact.

A browser reload while the Station route is unavailable shows a separate, read-only reader with a **Read-only
copy saved** timestamp. If you lose connectivity in an already open workspace,
choose **Read saved copies**; **Back to workspace** keeps drafts and the existing
outbox available. Reconnecting leaves the reader, verifies live access and uses
server data. Local copies never enter the live transcript or authorize actions.

After one successful web-worker installation on HTTPS or localhost, the app
shell can load offline. An initial visit without any cached shell still needs a
network connection. Only the local text reader bypasses live access verification;
ordinary protected query caches remain quarantined on a cold offline start. A
small identifier-only session index is persisted under the normal 24-hour,
build and authority rules, rather than caching provider recovery state or titles
taken from prompts. Native shells already bundle their app assets; the browser
service-worker cache is not installed there.

## Ways To Run Station Today

Station is open source and under active development. Check the
[release list](https://github.com/kontourai/station/releases) for current
artifacts. Desktop updater channel tags and npm packages are separate from
the signed portable release rings used by the installer below.

| Path | Platforms | Use it when |
| --- | --- | --- |
| Run from source | macOS, Linux | You want the current `main` branch and are comfortable with a Node.js checkout. Follow the [developer guide](https://github.com/kontourai/station/blob/main/docs/guides/development.md#local-runtime). |
| Nightly server install | macOS, Linux, Windows (x64) | You want the newest signed `main` build as a local server you open in a browser. Use the one-line [Nightly install](#install-nightly). |
| Nightly desktop build | macOS (Apple silicon), Windows (x64) | You want a native app for testing. Download it from the [Nightly desktop pre-release](https://github.com/kontourai/station/releases/tag/nightly-desktop); see [Nightly desktop downloads](#nightly-desktop-downloads). |

When a signed Stable portable release is available,
[Install Or Upgrade](#install-or-upgrade) is the macOS/Linux installer path.
The remaining sections cover that install and the first-run UI.

## Install Nightly

Nightly is built from `main` and published as signed prebuilt server
archives. On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh | STATION_CHANNEL=nightly sh
```

On Windows, in PowerShell:

```powershell
$env:STATION_CHANNEL = 'nightly'; irm https://raw.githubusercontent.com/kontourai/station/main/install.ps1 | iex
```

`STATION_CHANNEL=nightly` is enough: the installer reads the rolling
[`portable-nightly`](https://github.com/kontourai/station/releases/tag/portable-nightly)
manifest, verifies its Ed25519 signature against the keys pinned in the
script, and checks the size and SHA-256 of the archive it selects for this
host. Nothing unsigned is installed. It needs `curl` and `tar` on macOS and
Linux; with no Node.js 24 on the host it downloads a pinned, digest-checked
Node.js only to verify and extract. Neither a GitHub login nor a build is
needed.

The install lives under `~/.station/installs/nightly`, keeps its data in
`~/.station/instances/nightly`, and owns the `station-nightly` launcher
(`~/.local/bin/station-nightly`, or `station-nightly.cmd` on Windows). Open
the single-use sign-in link printed when it finishes. For later launches on
macOS/Linux, use one command:

```bash
~/.local/bin/station-nightly start
```

On Windows, in PowerShell:

```powershell
& "$env:USERPROFILE\.local\bin\station-nightly.cmd" start
```

The default browser address is `http://localhost:38000`; use the sign-in link when access is requested.
Run the same install command again to upgrade. Replace `start` with
`--version` in the launch command to see the installed build. Set
`STATION_INSTALL_PUBLIC_MANIFEST_URL` to install from a different signed
manifest instead. The Station Nightly desktop app uses the same ports and
data directory; the installer refuses to share them silently (see
[channel identity and coexistence](https://github.com/kontourai/station/blob/main/docs/guides/release-channel-ports.md)).

Each Nightly's own `install.sh` and `install.ps1` are also attached to its
immutable `v<version>` release, next to its archives.

### Nightly desktop downloads

Each Nightly desktop publication also uploads its installers under fixed
names, so these links normally serve the newest published build (each
replacement deletes the old file first, so a download at that moment, or
after a failed upload until the next build, can briefly find nothing):

- macOS (Apple silicon):
  `https://github.com/kontourai/station/releases/download/nightly-desktop/station-nightly-macos-aarch64.dmg`
- Windows (x64):
  `https://github.com/kontourai/station/releases/download/nightly-desktop/station-nightly-windows-x86_64-setup.exe`

The release also carries the same builds under versioned names
(`station-<version>-…`), and versioned downloads of earlier builds; older
ones may be removed once 30 newer builds have been published. Its `SHA256SUMS` lists
the newest build's downloads under both names. Download it next to the
installer and check it, for example
`shasum -a 256 --ignore-missing -c SHA256SUMS` on macOS,
`sha256sum --ignore-missing -c SHA256SUMS` on Linux, or compare
`(Get-FileHash <file>).Hash` on Windows. A mismatch right after a new build
is published means the two files are from different builds; download both
again.

The Windows installer is not publisher-signed yet
([#3591](https://github.com/kontourai/station/issues/3591)). This applies to
the Nightly installer and to the Windows MSI on tagged
[releases](https://github.com/kontourai/station/releases)
(`station-v<version>-windows-x86_64.msi`), whose release records it as
unsigned. When you run the downloaded installer, Microsoft Defender
SmartScreen therefore shows
"Windows protected your PC" with an unknown publisher; choose **More info**,
then **Run anyway**. On Windows 11 with Smart App Control turned on, Windows
can block the unsigned installer with no such option. The app's own updates
are verified with Station's updater signing key.

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

Stable and Nightly are the supported distribution channels. The installer
refuses the retired `STATION_CHANNEL=beta` and `STATION_CHANNEL=preview` values.
An operator accepting a release candidate can pin `STATION_VERSION=vX.Y.Z-rc.N`;
it installs with Stable identity and the base product version. Follow the
[release-candidate procedure](https://github.com/kontourai/station/blob/main/docs/guides/release-rings.md#publish-a-release-candidate)
for acceptance and manual candidate replacement.

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

1. Open **Customize → Connections**.
2. On the **Models** tab choose a detected service or **Add model connection**;
   on the **Engines** tab choose a detected engine or **Add engine**. During
   first run, a detected Engine can be ticked to connect it and create its
   External agent in the same confirmed action. An engine that is starting for
   the first time can be reported as still starting rather than failed: its
   Agent is added if it connects while Station is running; otherwise set it up
   again later.
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
Muse engines and their default Agents; with the `copilot-sdk-engine` Feature
Preview on, it also registers GitHub Copilot (SDK) when `copilot` is on `PATH`,
from the next start. An engine you explicitly removed is
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

Home and the chat dock use the same start composer. On Home it sits under
**What would you like to do?**. **New chat** opens it in the chat dock as a
draft, like an empty chat: the dock opens if it was collapsed, a quiet line
names where the chat will start (for example **Start a chat in Pulse on
studio-mac**) until you write something, and the composer sits where a reply
would. Write what you want done
and choose **Start**. You do not need to choose anything first; the controls
show what **Start** will use:

- The combined Agent & model button shows the Agent's icon and the Model's name,
  followed by the thinking effort when you chose one (for example
  **Opus · High**). It opens **Agent & model**. Its Agent choice
  lists **Station**, **Coding apps**, and **My agents**, with readiness and setup
  actions. Its Model choice opens the
  **Engine & model** picker, which also offers alternative engines when they
  are available. An engine choice overrides this conversation's execution
  while retaining the selected Agent's profile and saved defaults. Search or
  filter by provider, **Recent**, or **Favorites**. Supported thinking effort
  and Speed controls sit beside the list; on phones, open **Settings**.
  Choosing a Model for an Agent also chooses
  that Agent and closes the picker; changing the effort leaves it open. Once
  you have chosen a Model, the picker's reset button names the default it
  returns to, such as **Use project default** for a model-only choice or
  **Use Agent defaults** for an engine override. In an existing conversation,
  changing or resetting the engine opens a short handoff picker that switches
  now: your draft, or a catch-up request when there is none, is the first
  message.
  Full access, a pending or refused approval change, and a conversation override
  add a warning glyph to the combined button; open Agent & model to see the same
  glyph on the choice that raised it. When the conversation's Agent now points
  at another engine, the button adds **Default differs**. The panel names the
  session engine and the Agent default. If the conversation's engine session has already
  ended, a **Next turn starts on …** line above the message box says where the
  next turn goes instead.
  In the model picker, while a reply you sent is still running, the other
  engines and **Use Agent defaults** are shown but unavailable until it
  finishes. When Station reports that the conversation can't be changed right
  now (it is read-only, still loading, the check failed, or it is waiting on a
  turn the server reports as still running), the other engines are not listed
  and **Use Agent defaults** is unavailable.
- The **project** control in the start heading shows its name, or **Without a project**.
  Open it to choose a project. Each project shows its Git repository, or without one
  the folder its chats run in. For a linked checkout, that is its resolved
  execution root. An unavailable location states why Station cannot start
  there; a folder not checked yet is marked **Not checked** and the start
  checks it. A project with no folder
  can be chosen too. Its chats run in your home folder, or, for an ACP
  engine, in that engine's own Working Directory or else a private folder
  Station makes for the chat; the chip and list say which. A Codex chat in
  Codex's sandbox never runs in your home folder: it gets a private folder.
- A chat **Without a project** runs in a private folder Station makes for
  that chat, not in your whole home folder. On Windows, new chat folders live
  under `~/.station-workspaces/<Station home hash>/`; other platforms keep
  them inside Station's data folder. Windows workspace files need their own
  backup and retention policy; a Station home archive does not include them.
  To run such
  chats in your home folder instead, set **Settings › Agent runs › Chats
  without a project** to **Home folder** (a sandboxed Codex chat still gets
  a private folder). The setting applies to new chats; a chat that already
  ran keeps its folder.
- **⋯** holds **Use a visual skill** while the **Visual skills** Feature
  Preview is on; with it off there is no **⋯**.

The start heading includes a clickable **Project** name. **Or start without a
project** clears it. Home and New Chat use the same composer and pickers;
**Runs on <Station>** sits below the message box.

When another Station is available, **Runs on <Station>** opens **Where this work
runs**. Choose the Station, then its **Engine & model**. A Station that
cannot take work right now is greyed out with its reason, such as
**Recovering · server down or restarting** or **Unreachable**. With **Paired Station
chats** enabled in Settings → Advanced → Feature previews, choose a Project
from that Station’s own list, or **start without a project**. **Start** opens a
chat tab that reads and replies to the conversation on the chosen Station.
It looks like any chat, with **Via <Station>** in the header. Replies, files,
Stop and approval answers use that Station. A refused message offers **Retry**
and **Edit**. If delivery is uncertain, use **Check** before sending a
changed copy. Station keeps the original pending message.

To move a chat you already have to a paired Station, open the Agent picker in
**Agent & model** and choose that Station; the dialog becomes **Continue
elsewhere**. Pick its engine and
one of its Projects, then **Continue on <Station>**. A new chat opens there,
and its Agent gets this chat's messages as context. The new chat shows messages
from the handoff on; this chat keeps the earlier ones. Its first message is your
draft or a short catch-up request. Files are not copied: the picker lists uncommitted changes and unpushed
commits that stay on this machine, so commit and push first if you need them.
The original chat stays here. If Station can't confirm the move, **Retry
safely** reuses the same request and never creates a second chat. A Station
you added with a device sign-in can't take a chat: pair it as a Station in
**Connections** first.

Full access, choosing a folder, mentions, offline copies and local skill or
workspace integrations are unavailable on a relayed chat. Turning the preview
off keeps saved text and drafts visible. An older held chat offers **Reconnect
chat**; confirm the Station before continuing.

Choose the destination’s Project explicitly; Station does not match Projects
between computers by name. Remote Tasks keep their separate execution consent.

With that preview off, or for SSH destinations, **Start** opens **Run on a
Station** and **Run task** starts a resumable Task there. Its existing portable
Project admission still applies. A foreground chat stays on its owning Station;
choosing another destination starts new work. With no other Station to choose,
the control is plain text.

The Project page opens on **Overview**. **Room** is shared discussion with
people in that Project, in named channels starting with `#general`; choose the
channel name to switch, and people who can edit can add, rename or archive
channels. React to a message with an emoji, and tap a reaction to add or take
back yours. You can edit or delete your own messages (press ↑ in an empty
composer to edit your last one); a deleted message leaves "Message deleted" so
replies still make sense. Use **Bring an Agent** for an explicit request whose answer returns
to the channel. With the **Coordinator in #general** preview on, the Agent you
ask in `#general` answers, proposes Tasks you start from a card, or passes your
message to a running Task, and posts each Task's result back
([Coordinator in #general](settings.md#coordinator-in-general)). Direct Agent conversations stay in the chat
dock. **Tasks** shows a board of what each Task needs now, or a list of current work, backlog and history; **Files & connections**
holds the Project's context. To change where new Agent work starts, open the
workspace controls under Files & connections. A local folder is execution
configuration rather than the Project's identity.

The Project conversation list shows its channels and Task rooms. If one of those
lists is temporarily unavailable, retry that list from the Project page.

With the **Project Overview** [feature preview](settings.md#feature-previews)
on, Overview lists the Project's Tasks under what each needs next:

| Group | Contains |
| --- | --- |
| **Waiting on you** | The run needs input or approval, failed, or the Task is marked blocked or asks a question |
| **Ready for review** | A pull request or result to review. A ready pull request nobody armed to merge says **Not queued** |
| **Working** | The run is moving |
| **Landing** | Every open pull request has auto-merge on or is in the merge queue, or is approved and waiting on checks |
| **Idle** | The agent finished its turn and nothing is pending |
| **Resolved** | Done, canceled, every pull request merged, or Idle for 7 days (folded; open it to see the list) |

Each row shows the Task, its Agent, the first line of its Task summary, and
its pull request with its checks. Select the row to open the Task, or the pull
request to open it. A Task that was resolved for being idle has a **⋯** menu
with **Reopen**, which puts it back in its group and restarts the 7 days. A dot
on the Project in the sidebar and in the Room header means something is
Waiting on you. Not-started Tasks stay on the **Tasks** board.

Project settings → **Overview and notifications** sets how long an Idle Task
waits before it resolves (or **Never**), and when this Project notifies you:
**Only when blocked** (a Task needs input or approval, or fails), **Everything**
(also each finished turn), **Off**, or your Station settings. The inbox keeps
every notification whatever you choose. A device that has the Project open is
not interrupted for that Project's finished turns.

Choosing on a chip starts nothing, and Station remembers it. An Agent is
remembered only once it can start, and for each project and for **No project** on this browser and
Station access, and the Model for each Agent. Home always starts in
**No project**, and the project you pick on its chip holds in this browser tab,
for this Station access, until you reload the page; opening a Project elsewhere
never changes it, and the chat dock does not follow it. Anywhere, the dock's own
new chat opens on the project last chosen in the dock (its chip, or the Project
you last opened), and its chip shows which.
Runtime options such as reasoning effort stay with the Model choice for this
browser tab only; they are not remembered after it. A choice you make stays on
both surfaces for this browser tab, even if another chat later runs on a
different Model, until you change it or choose the picker's **Use …** reset,
which names the default it returns to. Station does not start a chat on a Model
its engine does not offer: a default that an engine advertising its own model
list left out is skipped, and a kept choice that list no longer contains is
refused at **Start** with the message kept, so you can choose another.

Project settings keeps workspace details and chat defaults together. Use
**Save** to apply workspace, identity, model, new-chat, execution, Agent, and
tool changes. Layouts, Sources, People and access, and Project knowledge
have their own actions, which apply immediately. Background refreshes preserve
unsaved edits. Clearing the working directory removes the configured folder;
a Project that requires worktree isolation still needs a valid Git directory.

A Project can choose how its new chats start, in Project settings → **New
chats**. **Use the AI model above** starts each new chat on the Project's AI
model wherever its Agent offers that model, ahead of your last pick on this
device. **Last model used in this project** starts on the model your last chat
there started with for the same Agent; if that model is no longer offered, the
Project's model or the usual default applies and the Model chip's tooltip says
why. The approval mode can be set for the Project (Ask first, Auto or full
access) or follow your last chat there. It applies below the Agent's own mode
and replaces your personal default for that engine, and full access is only
reused when you can grant it. The composer's permissions button shows the
requested mode. Open it to see where the mode came from or choose this chat's
mode before you start. **Default** uses the engine's saved permissions;
the active mode is confirmed after startup.

Until Station has loaded your projects, the chips show placeholders and
**Start** waits, so a start never runs in a project Station has guessed. If
the project list cannot be read, the composer says so instead. A
chat started from Home opens in the project its chip shows, **No project** until
you pick one, so that project's default Agent and Model apply.
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

In the chat dock, the **New chat** button (the conversation-plus icon on the collapsed Inbox bar),
**⌘T**, and the floating button in the phone Inbox open the same composer.
Text you leave there without starting comes back the next time you open New chat
for the same Project.
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

**Fork from here** is not a new start. It opens a small picker, the same one
**Continue with another agent** uses: choose the Agent (the current one is
selected) and model, then **Fork with …** opens a new chat from that answer
and leaves this chat as it is.

To try a message again, use its actions. On an answer, **Regenerate** forks
the chat just before the message that asked for it and sends that message
again, attachments included, in the fork. On your message, **Edit and resend**
opens the same kind of fork with the message in the composer, for you to change
and send. Both use the message's Agent and keep the original chat and answer
unchanged. If that Agent cannot run, the fork's Agent list opens instead. On a
phone, **Edit and resend** is in the message's sheet and **Regenerate** is a row
of the answer's sheet. For the message that started a chat, both start a new
chat with the same Agent and Project. When earlier messages have no completed
answer to fork from, neither is offered; **New chat from this message** remains.

Some engines can also forget part of a chat in place. Where the running engine
says it can (Kiro's agent service, Grok Build), your message's actions include **Rewind
conversation to here**. After you confirm, the agent no longer sees that message
or anything after it. The messages stay in the chat, dimmed and marked
**Rewound**, and a line says how many files the engine restored, when it says.
This is not a checkpoint restore; only files the engine restores itself change.
It is refused while a turn runs, and for a message from before the engine last
restarted; the dialog says why. On Grok Build, if you changed a file since that
message that the rewind would restore, nothing is rewound and the dialog names
the file.

The usage disclosure ends after your usage decision. **Open setup** on the
**Finish setup** card opens optional preferences after the work entry; it is not
a prerequisite for a chat.
Closing preparation prevents a late response from starting work. The request stays
in the Home field while that Home view remains mounted and through the temporary
setup-return flow; changing Stations or authorization ends that flow.

When creating an agent, choose **Use a model connection** for Station's engine
or **Use a connected engine** for Claude Code, Codex, or another connected
engine. Those engines run on the computer hosting your Station, including when
you use a phone.
An agent's setup warning names that agent; other ready agents can still run.

You can start from Home while setup and usage sharing are still undecided.
Use **Review choices** to open usage sharing, or find it in **Settings →
Privacy & sharing**. **Not now** returns you to Home. Recent work shows this
Station's saved conversations under **Earlier in Station**. Read-only
conversations discovered from other tools appear under **From other apps**.

At the end of first-run setup, choose **Start your first chat**. Station saves
any personalization answers you selected, then opens New Chat. Unanswered
questions add no profile. If saving those answers fails, setup stays open so
you can retry. Closing setup or navigating back during that save cancels the
next navigation; answers that already saved remain saved.

Opening the composer or changing a chip starts no conversation or engine;
**Start** opens the conversation and submits the message once. With no
remembered Agent, the composer uses the project’s **Default agent**, then the
current layout default or Station’s runnable suggestion. Any of these that
is not set up is skipped for the next one that is, so a new chat never opens on
an Agent that cannot start. An Agent you pick from the menu in this tab stays
visible with its setup action.

Escape, Back, or opening another chat closes the draft; collapsing the dock
keeps it. On a phone the draft opens full screen; closing it, or starting the
chat, returns the dock to its earlier size. Drop files anywhere on the draft to attach them. **New chat**
while a draft is open returns you to it. To resume earlier work, choose it in
the dock’s chat list.

At the end of first-run setup, **Take the tour** and **Connect another device**
are optional alternatives to **Start your first chat**. Both save the same selected answers before opening their next step. If your organization's policy allows only this computer to connect, **Connect another device** is turned off and shows the policy's message, with a **Get help** link when the policy has one.

On a phone, the dock starts at **Inbox** unless you open a specific
conversation. A conversation opens full screen; **Restore chat size** in the
chat bar shrinks it to a peek and **Full screen chat** grows it back or opens it
directly from the collapsed bar. The menu drawer lists places and Projects.
The chat bar's Inbox icon returns to the work list; the chat title stays
as context. Search opens from the magnifier. Your search, list position and
unsent message stay in place when switching back to a conversation. Collapsing a conversation keeps its title in the bar. Tap the title to resume it.
Use the floating **New chat** button in Inbox, the compose icon on the collapsed Inbox bar, or **New chat** in Chat actions. The three-dot menu holds chat actions, including **This chat**:
the chat's workspace, branch and changed files, status, background tasks and
linked pull requests, each opening its own view. On a computer, a wide dock
shows the same panel beside the transcript, and a narrower one puts it behind
a chip in the dock header. The app header keeps connection health, the drawer, and the Station switcher above the dock in full screen. **Projects** has the same add control
for creating a project, including a short first-project prompt when empty.

On a phone, pull down from the top of Inbox, Home’s **Recent work**, or the
Project **Tasks** list. Release when the ring fills. Use **Refresh inbox** in Inbox actions or the refresh button beside **Recent work** on Home. A floating status pill shows what’s refreshing.

Each chat appears once in Inbox and on Home, under the group its status puts it
in. When this device sent a message whose delivery Station can't confirm, the
row keeps that status and adds **Last message may not have arrived** with **Check**,
which asks Station once and says what it found. It never sends the message again.

In **Inbox**, delegated work folds under its recorded parent.
Expand the subtask count to read the children; children that need you stay
visible. Authorized work chats appear under their Task, including independent
Agent requests and linked conversations. A chat associated with several Tasks
stays separate. Select a Task to reveal Overview or a work chat to read its
conversation. Running counts include actual chats, not the Task's status. **Show work**
filters by project or Station and stays selected on this device. Until you choose
a scope, it follows the project whose page you are on and shows all work anywhere
else. The control shows **This project: <name>** on its page and **All work**
elsewhere. **Always <name> · <Station>** pins a project across navigation. An
explicit choice such as **All work** stays selected as you navigate. If work needs
you outside the filter, choose **Show all** from the notice; on a computer, a
count badge on the scope picker does the same. On a computer the scope picker
sits beside search, **Browse all conversations** is at the end of the list,
and each card shows the title above its project. Read the status and time on the
right. Click a task row to open it, or expand its work-chat count to see the linked
conversations. Hover an agent icon to read its name. To browse
chats from a side dock, open **More dock actions** and choose **Open chat…**.
The picker opens over the current dock placement.

To clear your inbox, hover a conversation on desktop and choose **× Dismiss
from inbox**. On mobile, hold a conversation or choose **Select conversations** from Inbox actions. Choose **Details** for one selected row to open its actions. The bottom tray shows which actions apply to the selection. Use **Filter inbox** for Station, Project and status. On narrow phones, Search and Filter are in Inbox actions. With **Sheet gestures preview** enabled in Settings → Advanced →
Developer tools, swipe left to reveal labelled actions; the row follows your
finger and snaps open when released. Only one row's actions stay revealed.
**Snooze** opens duration choices, and **Dismiss** hides the conversation.
Swiping itself never runs an action. Dismissal leaves running work and history intact.
Choose **Undo** in the toast, or press **⌘Z** / **Ctrl+Z** outside an editor
while the toast is shown. After the toast has gone, search the inbox for the
conversation, find it under **Dismissed** in the results, and choose
**Restore to inbox**.
Dismissal is saved on this browser/device, like Snooze. A changed status, a
changed attention kind, or newer activity outside a running turn brings the
conversation back; streaming progress during the same running turn does not.
A turn the engine opens on its own, such as its reply when background work
finishes, does not bring it back unless that turn fails, stops or needs you.
Hidden **Third-party** sessions stay hidden through external updates until you
restore them or bring them into Station.

If this browser cannot save Snooze, the choice still holds for the current
page session. Saved snoozes update other open tabs of this browser.

**Discard draft** deletes an unstarted server Draft across devices. It first
offers **Undo** for eight seconds and announces **Draft will be discarded**.
The Undo button replaces the row's discard shortcut; the Details sheet also
shows the pending message. Undo keeps
the Draft; leaving that control or switching Station or account also cancels
the pending deletion. After the window, Station asks the server to discard it
and shows any refusal. On a touch row, the message appears below the row’s
actions. Discarding an **unsent draft** clears the text you typed on this device.
A slash command that runs, such as `/help` or `/new`, is not kept as a draft. One
that does not run (unknown, or refused) stays in the composer to correct.

With **Open and Settled inbox** enabled in Feature previews, unfinished
conversations stay **Open** after an Agent finishes a turn. Choose **Settle**
when the conversation's work is done, or **Reopen** to bring it back. Closed
Tasks follow their existing close-on-merge setting; standalone linked PRs do
not settle a conversation automatically. Sending a message reopens a settled
conversation, as does a question, a failure or a stop; the end of a settled
conversation shows when you settled it and a **Reopen**. Settlement syncs across your devices
and is separate from dismissal or deletion. **Working** holds running and
monitoring chats and armed check-backs, which show **Waiting**; **Needs attention** takes priority whenever input is owed.
Drafts appear as a pencil on the chat row in its current status. Collapse a
shelf to move it below expanded work. Shelf menus let you move sections up or
down, with that order saved on this device. **Settled** is last by default.

With the preview on, **Settle** is how you put away your own conversations,
so their rows have no **Dismiss**. A **Third-party** session offers **Hide**
instead; it stays hidden on all your devices, through its updates, until you
bring it into Station or search for it and choose **Restore to inbox**.
Sessions you dismissed on this browser before move to your hidden list once.
**Settled** and **Third-party** show the last seven days; choose **Show older**
for the rest. Search always finds everything.

The workspace map lists Projects and their named Layouts, followed by your
**Apps**. Its **+** creates a Board and lets you name it, even
when the list is empty. Select a project to see its configured views as child rows.
Use Up/Down inside the view list, or the header's Layout picker, to change
views. The header's sidebar button collapses the desktop map to a project
rail; clicking a project icon opens its views without navigating first.
The dashboard icon below projects opens **Apps**, including your personal Boards and their add
button. Escape closes either popup and returns focus to its icon.
The footer puts live work beside your initials, which open a summary of your
access with **My access**, **Profile**, **Ask Station for help** and **Open
settings**; Automations, Customize and Settings sit on the row below. The collapsed rail stacks live work and your initials above
Sidebar utilities. Conversations and composer drafts stay in the chat dock and
its inbox (⌘D).

Selecting a project in the sidebar opens its workspace and makes it the default
for new chats. An existing chat stays with its original project. Choose a
different Project in the new-chat composer before starting a conversation.
The next sidebar project selection updates that default again.

To give a project an icon, open its settings and choose the icon beside its
name under **Basic info**. Station suggests artwork it finds in the project
folder, such as a favicon, app icon or logo. A repository without a custom
icon uses detected artwork automatically. You can also upload a PNG, JPEG, WebP or ICO image of up to 128 KB,
type an emoji or short symbol, or choose **No icon**, then **Save**. The New
Project dialog offers the same choices. Clearing a custom icon restores detected
artwork; **No icon** hides it. Choose **Use detected icon** in Settings to
restore automatic detection. Links and file paths are not accepted
as icons; if a project's existing icon can't be shown any more, such as one
saved as a link before that, its settings say so and ask you to choose a new
one. The icon appears beside the project in
the sidebar, the project switcher, Home and chat rows, their details, and on
the project page. Without one, those rows show the project's colour (the
phone's chat list shows a folder instead) and the project page shows its
initials. A row for work on another Station shows
neither, since its project belongs to that Station.

### Prepare a visual skill

Visual skills are a Feature Preview: turn on **Visual skills** in
**Settings → Advanced → Feature previews** first. Off, the start composer and
the agent list offer none, even if one is installed.

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


### Station status, updates, and recent messages

Open the Station control in the toolbar, then **Station details**, for connection
repair, pairing requests, local-service recovery, and recovered-copy information.
On the full-screen mobile chat surface, tap the Station indicator to open details.
These local facts remain readable when the selected Station is unavailable.
Blocking work restrictions also appear in the workspace. Recovered-copy warnings
stay available until the underlying condition clears; restoring a copy does not
transfer execution authority.

The sidebar **Updates** control opens one panel for the app and connected server.
Their actions remain separate. The desktop app update includes its built-in
server; a separately installed server keeps its own update and restart steps.
Update policies remain in Settings.

Toasts report short outcomes. Hovering, focusing, or opening their details pauses
the reading time, as does leaving the app. Extra messages wait behind **View all**.
**Notifications** includes recent local messages and a clear action, separately
from the server-backed attention inbox. Only messages explicitly approved for safe
recall survive a reload, on this device and for the selected Station. Actions and
raw error details are never saved in that recall. Approvals keep their existing
durable request flow.

### Finish setup and return

When no Agent can respond, the chat dock's new chat shows a setup card above your message.
It lists each Agent with its status and repair, and offers engine setup, a
model connection and **Check again**. Each Agent's **Details** holds its
reason and any installation steps,
commands, and links supplied by that engine’s integration. Commands are shown
for you to run; opening a guide does not install software. Install engines on
the computer running Station, including when using Station from a phone.
Claude, Codex and Muse account management opens their existing in-UI sign-in flow;
other integrations retain their own authorization instructions.

If New Chat offers **Connect**, **Set up**, **Edit agent**, or **Set up
Connections**, use that action to open the owning setup page. The picker steps
aside and collapses the chat dock while keeping your chosen workspace, Agent,
Model, and selected context.
Use **Return to New Chat** in the inline setup notice when finished, **Cancel
return** to stay, or browser Back to return to the page you left. Station rechecks setup before selection;
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

### Read child-work outcomes

Child-work cards distinguish **Returned result**, **Provider summary**,
**Child message**, and **Provider error**. Older text may show that its source
was not recorded. A summary or transcript handle alone does not establish a
returned result. An existing completion notice is corrected when a later
structured tool return arrives from the same Station and child.

A background shell command an engine started (or a monitor watching one) is
not a subagent: its card shows a terminal mark, the command line and, once it
ends, its exit code, and a group counts it as a background command.

Every background-task row expands to its full title, status, start and end
times, and, for a tool, which tool ran and a one-line summary of its input.

The background-task sheet shows recent tasks only (its footer says so). Older tool rows and
closed-chat history can be omitted; counts marked **shown** describe retained
rows. Closing a chat does not stop its child work. Open its chat from the inbox to inspect the
Session history available from that Station. Missing snapshot evidence keeps an
outcome unresolved rather than declaring success.

### Send a follow-up while an engine works

For a running Codex subagent that supports direct instructions, expand its
card and use **Send to** that subagent. Station shows those instructions and
their delivery status separately from the engine transcript: sent, **Not
sent**, or **May have reached the agent**. Sending requires permission to continue the
chat and an operator or device grant that can operate it. If delivery is
unconfirmed, **Check** looks the saved instruction up in the subagent's history
and never sends it again; Station will not automatically send a new instruction.
Once the saved one is resolved, you can submit a new instruction if the
subagent is still eligible. Some Codex
subagents cannot accept direct instructions. Older Stations need an update to
offer this control.
When the engine transcript is open, sent instructions are collapsed in the
Station list; open one to read its attributed copy. Unconfirmed instructions
remain visible, and the engine's prompts remain available in its transcript.

Keep typing during a turn. **Send** defaults to **Queue**. Station holds the
message and delivers it after the turn finishes. The message appears in the
pending list as soon as Station accepts it. The dropdown switches between the
available modes. For an ACP engine without native steering, choosing **Steer**
stops its current step and continues the task with your instruction once cancellation
finishes. Station-owned steering waits for the next safe boundary. A Muse chat
on `muse exec` supports Queue only. Each pending row shows its mode.
For a locally queued message, **Send now** stops the active turn and sends the
selected message after Station confirms the stop. Messages held by Station can
be removed when permitted, but cannot be edited or sent now from the list. **Stop** remains separate.
You can attach files or dictate during a turn. In the parent chat, Steer carries text only, so a
message with files is queued: Station keeps the files with it and sends them
when the turn ends, and the pending row names them. On a Station that cannot
hold files yet, they wait in the draft, which says why, until you send it after
the turn ends.

The app attempts to save a text message on this device before sending it. If
the write fails or times out, it sends without that saved row and keeps the
saved draft. If the app closes or
the connection drops before Station answers, the app asks Station what happened
at its next launch or reconnect: a message Station never received is sent once,
with the same identity, and one Station may have started is kept and marked,
never sent twice. If Station accepts the reconnect send into its inbox, the local outbox
settles that row. If a later delivery lookup finds it queued, the local row
remains for inspection. A message with attachments or a visual skill keeps its draft
until Station answers instead.

If Station cannot confirm delivery after three automatic checks, the row shows
**May have reached the agent** and pauses those checks. **Check** asks what
happened and shows the result without resending. If Station confirms it never
received the message, **Retry** sends it with the same identity. **Copy message**
is in **More delivery actions**; **Discard…** removes the saved row after confirmation.

Once Station confirms a turn started, a late network error does not queue that
message again.

Until the agent has a message, its bubble is outlined rather than filled. On
the way there it shows no text, only a small mark beside the bubble (hover it,
or use a screen reader, for its words):

- a turning ring while it is **Sending**, also while another open window of the
  app is sending it; the outline is dimmed
- a check once Station has **Received** it. The mark's label adds **Safe to
  close the app** when Station keeps running without the app, or **Keep the app
  open** when the app's own Station stops with it. The composer's status pill
  says **Starting** at the same time.
- once the agent has it, the bubble fills and the check fades out

When something needs your attention instead, the bubble opens one short line:

- **Sends when connected**: kept on this device until Station can be reached
- **No answer yet. Resends only if it never arrived.**, after a send that got no
  answer: when Station can be reached it is asked about the message, which is
  sent once only if it never arrived
- **Waits for the unsent message above**: messages in a chat go in order, so a
  message waits until an earlier one that was not sent is retried or discarded
- **Waits for its own Station**, for a message written for another Station
- **Not sent**, with **Retry** (the same message again, never a second copy) and
  **Edit** (the text goes back to the composer); **Discard unsent message** is in
  the message's **⋯** menu (on a phone, listed in its sheet)
- **May have reached the agent**, with **Check**, which asks Station again and
  never resends
- **Not confirmed**, for a message this device sent with no answer from Station
  (for example a send that was stopped)

A message that may have reached the agent, or got no answer, is never discarded
automatically:
**Discard…**, on the message, in the queued-message notice or in the pending
list above the composer, states the risk and removes it only after **I checked, discard it**, in
every open window. It does not hold back the messages written after
it.

The chat status says **Needs input** for questions and **Needs approval** for
tool permissions. Approval takes priority when both wait. Background work keeps
its count and elapsed time visible after the main turn ends. Elapsed time uses
words such as **2m 1s**.

Quiet turns show elapsed silence without guessing that an engine retried. Retry
status appears only when the engine reports it. The **Drafts** icon opens **Saved
drafts** (also Ctrl/Cmd+S in the composer). Save a copy of an unsent prompt,
including attachments and quoted context, then choose it from any chat on this
device to put it in that chat's composer. Saving leaves the current message in
place; restoring replaces the destination composer's content without sending it.
Drafts are stored in this browser or app on this device, not synced to other
devices. Station keeps the 20 newest saved drafts, with up to five images per
draft, and lists any dropped or unreadable images. The trash icon clears the
current message. Hold or focus
either icon to read its label. Choose **Agent & model → Return in chat** to change
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

The composer's **+** menu groups what you can do from the message box: add to
the message (**Reference chat…**, **Commands**), work in the chat's project
(**Open terminal** opens a shell in the bottom dock; **Open in Coding** moves
the chat into the project's coding layout; **Delegate…**), and change the
conversation (**Continue with another agent…**, **Reset agent context…**). An
unavailable row says why. **Changed files** and **Task context** are in the
chat header's **⋯** menu.

Choose **+** then **Reference chat…** to choose an
earlier conversation. The picker searches the 25 most recent conversations
returned for your access and shows up to eight matches; it does not search
older history. You can also drag a result into the composer, or drag a
conversation's row from the inbox. A message can
contain at most eight conversation references. Station
sends a link to the selected conversation, plus one line naming its id and
asking the receiving Agent to read it with the `read_conversation` tool; it
never copies that conversation's transcript into the prompt. An Agent with
Station Control can then page through that conversation because you
referenced it; see
[reading a referenced conversation](https://github.com/kontourai/station/blob/main/docs/guides/self-configuring-agent.md#reading-a-referenced-conversation). Titles are displayed as plain text, and the link is
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

To add skills, choose **Browse Registry Skills** (**Browse Registry** while the
library is empty) and inspect the available catalog before installing. **Import .md** accepts standalone Markdown skill
files and reports the outcome of each file. Open an imported skill from its
result to review and use it. Import does not copy a repository's
scripts or supporting files. Load plugin packages through Registry.

For a writable skill, **Edit skill** opens its definition and command settings.
**Back to overview** asks before discarding unsaved edits. Package-owned or
plugin-served skills show the server's read-only reason and keep editing
unavailable.

## Start Your First Task

1. Open a Project and choose **New Task**. The normal chat composer opens in **New Task** mode, focused for your idea. Use its Project control or **Agent & model** to change the Agent, Model or Approval settings.
2. Refine the idea in chat, or accept an immediate proposal for a clear one-liner.
3. Choose **Create Task** on the proposal to keep its brief and linked chat. The Task opens with its brief and references; accepting does not assign an Agent or start an execution Session.

In new chats and New Task conversations, drop an image onto the composer or paste
a screenshot into the text field (Ctrl/Cmd+V on desktop). On a phone, use **Attach** to choose an image. In the Android app
you can also share images from another app to Station, then pick a
conversation or **New chat** in a project. Review its thumbnail and remove it
before sending if needed; tap a thumbnail to see the image full size. **Attach**
always adds more files. If you send while a file is still uploading, the
message waits and goes once the upload finishes; a failed upload offers Retry.
The existing Task room, Project channels and agent-thread replies accept
images the same way, including messages with only an image; their room composer also retains **Paste image** on supported touch devices. You can attach up to five files, 5 MiB
each and 15 MiB combined. Keep unsent local files in the open draft; reloading
does not restore them. An older chat image may become unavailable after the
server's attachment retention expires. The Task room keeps bytes for bound
attachments and can refuse new files if its store is full. A Project channel
keeps a file for as long as its message stands. If a Project channel
pauses attachments while its file store is repaired, it says so; remove the
files and your text still sends.

An existing chat can become a Task through **New Task from this** in its More menu.
The **Add to Task** picker also offers **New Task from this** for an answer or input.
**New Task from this** starts shaping immediately; type any focus or refinement as your next message. New Task mode stays on through clarifying questions and reloads until you accept a proposal or choose **Stop shaping this Task** in the chat’s More menu. No Task is created until acceptance.

To keep one chat as your personal agent, turn on **Coordinator chat** in Settings → Advanced → Feature previews, then choose **Make this Houston** in the chat's More menu. Home then pins it with **Talk to Houston**, and Station tells it when your work needs you, fails or finishes. See [Houston](https://github.com/kontourai/station/blob/main/docs/user/houston.md).

On a Project's Tasks board, a GitHub issue offers **Start Task**. It copies the
issue's description and latest comments into a new Task and links back to the
issue; if the issue already has an open Task, Station opens that Task instead.

After reload, an accepted card offers **Open Task**. The Task description is the Goal sentence. Its shared Task document keeps the complete accepted brief. If saving that document fails after creation, the proposal shows a recovery error: retry **Create Task** to finish saving the same Task.

The Task opens as a chat room. Press Enter to send, or Shift+Enter for a new
line; on a phone keyboard, Return adds a line and the round send button sends.
An unsent draft is kept for each room and thread in this tab. Messages from one
person within a few minutes share one name and avatar, a divider marks each day,
and agents have square avatars where people have round ones. New messages
follow the newest message while you are at the bottom; if you scroll up, the
room keeps your place, marks where new messages start, and **N new messages**
returns you to the latest. **Load earlier messages** appears above the visible
history. A Project channel keeps the latest 500 messages in view: at that point
it says so instead of offering more, and when new messages unload older ones,
a note says so above **Load earlier messages**. A failed agent request stays in the room
with **Retry** and **Open run**. The Brief is shared with agent requests unless
you turn off **Brief attached**. Saved answers appear in Results, with their
source and evidence available through **Answer details**. For engines that can resume, idle agent threads remain available after restarting Station. Ended or replaced runs still require a new agent request.

Create Tasks from a Project; Home no longer offers a first-task card.
Existing guided starter links keep their focused title entry and dispatch receipt. If the Agent is unavailable, Station
shows the setup reason without creating a Task. If a start has an uncertain
outcome, inspect that Task rather than creating another to retry it.

When a Session reports a plan (ACP engines do), its row in the inbox and on
Home, and the Tasks board card and Project task row of a Task it runs, show
**Agent plan 3/5** and a thin bar. It is the agent's newest plan in that
Session's latest turn, refreshed every few seconds while the Session is
running or needs you, or while the Task is in progress or blocked.
**Stopped** follows the count when the turn was stopped or the Session failed
or was canceled with steps open, and **Waiting** when the Session needs input
or an approval. There is no bar without a plan, for a plan from an earlier
turn, on Drafts, on Home's one-line **Earlier** rows, on rows from another
Station, or on done and canceled Tasks. The count is agent-reported: it never
marks a Task done or satisfies a gate.

Task status alone does not establish that work passed a gate. Read the run and
review evidence. The [Starter Work guide](https://github.com/kontourai/station/blob/main/docs/guides/starter-work.md) explains
how Station preserves the same work identity through retries and response loss.

<a id="review-activity-without-changing-your-place"></a>

## Read Child Conversations

Choose **Open chat** on a subagent card or a background task to read its
transcript in the chat pane, laid out like any chat: the subagent's prompt,
then its tool calls and answers. The title becomes **Parent chat / Subagent**;
choose an ancestor to return to that chat without losing its draft or reading
position. Escape returns one level. On a phone, the title names the subagent;
use the back button or swipe from the left edge. The reader opens on the
latest messages; earlier ones load as you scroll up. A running child that
accepts instructions has a message composer. When its active turn accepts
images, use the paperclip or paste a screenshot, then choose **Send**.
You can send an image on its own. Other child transcripts stay readable and
refresh while running.

If a tool result has no recorded text, the reader says **Text output unavailable.**
This does not mean the tool produced no output.

Use **Home** or the inbox to find work. Notification and session links open
that session in Chat, including attached records and sessions whose Agent
was deleted. Older Activity links still work: a session link opens its reader,
and a collection link opens the inbox. There is no separate Activity page or
Quick review pane. Action operations are under **Developer → Monitoring**,
linked from **Settings → Advanced → Developer tools**.

## See Conversations Started Outside Station

The **inbox** also lists Claude Code, Codex, Grok and OpenCode conversations
you ran in a terminal or another app on this machine. Station reads them; it
never controls them. These conversations do not raise Station sounds, popups,
desktop notifications or mobile alerts, and do not appear on mobile activity
cards. A new conversation you continue in Station has its ordinary alerts.
Station looks in four places:

- Claude Code transcripts under `projects` in `CLAUDE_CONFIG_DIR`, or
  `~/.claude` when that is not set.
- Codex sessions under `sessions` in `CODEX_HOME`, or `~/.codex` when that is
  not set, and in every other Codex home Station itself runs Codex in: the
  Codex connection's config home, its Station app home, and each credential
  profile's home. Continuing a conversation runs Codex in the home it was
  found in, with that home's account and, for a profile, its settings. A
  conversation copied by hand into two of them is listed once per copy,
  since the copies can go on separately.
- Grok Build sessions under `sessions` in `GROK_HOME`, or `~/.grok` when that
  is not set. A Grok session appears once it has a prompt. A subagent's own
  session is not listed separately, and neither is a Grok chat you started in
  Station, which is already there.
- OpenCode's session database, `opencode.db` or `opencode-<channel>.db` (for
  example `opencode-stable.db`), in `opencode` under `XDG_DATA_HOME`, or
  `~/.local/share/opencode` when that is not set. Station reads both OpenCode
  1.x and OpenCode 2.x databases. Beside an OpenCode 2.x database, an
  `opencode-next.db` is read only for sessions OpenCode 2.x does not hold: a
  session it copied is shown as OpenCode 2.x has it, archived or deleted
  there included. Once OpenCode's upgrade has finished, only sessions
  created in `opencode-next.db` after it are listed from that file, since
  OpenCode copies it only once. A file in the OpenCode preview format, which
  Station cannot read, is skipped. Station opens each database read-only and lists top-level
  OpenCode sessions you have sent a message in; subagent sessions and
  archived sessions are left out. A message appears once OpenCode has
  finished writing it. Later messages wait for an unfinished OpenCode
  compaction; if one is still unfinished after 15 minutes (OpenCode stopped
  partway and the conversation was not reopened), Station logs one warning
  naming the conversation, once per Station run. Conversations Station
  itself runs through an OpenCode connection are not listed a second time.
  Older OpenCode releases kept sessions as JSON files under `storage`;
  Station does not read those, and current OpenCode moves them into the
  database when it starts. If an OpenCode update changes the database
  layout, Station stops reading it and
  logs one warning instead of guessing. A conversation Station already listed
  from an OpenCode 1.x database stops updating once OpenCode 2.x converts that
  database; its earlier messages stay in history.

With `STATION_EXTERNAL_ACP_SESSIONS=1` set before Station starts, the inbox
also lists the sessions an ACP engine you added under Connections reports
itself, for an engine that offers a session list (Antigravity, Factory Droid,
Hermes and Cursor do; Kiro does not). This is off by default. Station asks for
the list when it checks the engine, about every five minutes, so it starts no
extra engine process, and a new session can take that long to appear. Only
the session's folder and Project are shown: ACP's one way to read a session's
messages also resumes it inside the engine, so Station does not read them, and
these sessions cannot be continued in Station. Grok and OpenCode sessions are
read from their own stores as above, not from this list, and Station's own
sessions and capability checks are left out.

`STATION_EXTERNAL_CLAUDE_SOURCE_ROOT`, `STATION_EXTERNAL_CODEX_SOURCE_ROOT`,
`STATION_EXTERNAL_GROK_SOURCE_ROOT` and `STATION_EXTERNAL_OPENCODE_SOURCE_ROOT`
point Station at a different folder (for OpenCode, the folder holding the
database). With `STATION_EXTERNAL_CODEX_SOURCE_ROOT` set, that folder is the
only Codex home Station reads. Station checks every two seconds and reads the
128 most recently changed conversations from each place (each Codex home is
its own place, up to 512 Codex conversations in all, the default home first). Older ones stay in history once Station has read
them, but new messages in them are not picked up until they are among
the 128 again. Conversations Station has not listed before appear only after it
finishes restoring its own sessions at startup; if that restore fails, already
listed conversations keep updating but new ones wait until Station restarts.

Each conversation is filed under a Project by the folder it ran in:

1. A Project whose folder contains that folder. When two Projects share the
   folder, the inbox names both rather than picking one.
2. Otherwise, a Project whose folder is in the same git repository. Every
   worktree of the repository counts, so a conversation in
   `../station-worktrees/fix-login` or another tool's worktree folder files
   under the Project on the main checkout. A Project on a subfolder of the
   repository takes that same subfolder in every worktree.
3. Otherwise, **No project**. These conversations have no Project assignment.

Rows can show **Directory · …/parent/folder** when a working folder is recorded
without a Project label. The label provides folder context and leaves Project
membership unchanged. A reopened delegated chat can show **CLI (reported)**
when Station's accepted start receipt records a CLI caller.

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
conversation stays in history and in search after the original transcript is
gone. You can open these conversations, and so can every device you have
paired with session read access, including a phone.

To stop reading conversations from folders outside your Projects, turn off
**Conversations outside projects** in **Settings → Advanced** (under Host options), then **Save**
(`attachedSessionsOutsideProjects` in the Station configuration). Station stops on its
next check, including for conversations it already lists: new messages in
them no longer arrive. What it already read stays in history, in search and
readable from your paired devices; turning the setting off removes nothing.
Conversations inside a Project are read either way.

A hosted Station never reads conversations outside your Projects. It reads the
ones inside a Project, but no account can open them there.

## Continue an Attached Session

Open an attached terminal Session from the **inbox**. It reads like any chat. To
continue it in Station, press **Continue in Station** next to where it says it started;
no message is needed. If you typed one, it is sent there once the
continuation opens, and pressing Send continues the same way. Claude and Codex create independent child
Sessions; the original terminal Session can keep running.

If the conversation is still mid-turn in its terminal, Station says **Still
running in Claude Code. Continuing now forks it** instead of continuing.
Mid-turn means its latest turn has not finished and Station saw it written in
the last five minutes: for Claude Code, its transcript or a subagent's (while
the conversation's own transcript changed in the last two hours); for Codex, the
latest record Station imported. A single command that runs silently for longer
than five minutes is not seen as running. Choose **Not now** and continue once
it finishes, or **Continue anyway** to fork it now. A fork does not see anything the terminal Session writes afterwards.
Station cannot stop the terminal Session for you. To hand the conversation over
completely, finish or quit it in the terminal first. OpenCode and Grok
conversations are read only: the message box shows why it is unavailable.
Codex continues from the latest completed turn Station has observed, so wait
for one if the message box is unavailable.

The continuation starts in the folder the conversation ran in. Its actual
confinement depends on the Session's access grant and the engine's enforcement;
a continuation granted Full access can run with host authority. The working
folder alone is not a sandbox guarantee. Station checks the folder again when
you continue:

- A conversation filed under a Project continues under that Project. This
  includes one in a worktree outside the Project folder: it continues in that
  worktree. Station refuses if the worktree was removed or replaced, or if its
  `.git` does not lead back to the Project's repository.
- A conversation under **No project** continues as a **No project** chat
  in its own folder, after you confirm that choice. Its access grant still
  determines confinement as described above. This is allowed
  only for a folder inside your home folder. Station refuses your home folder
  itself, every folder outside it (system folders included), any hidden
  folder directly in your home folder and everything in it (such as `.ssh`,
  `.aws` or `.config`), `Library` on macOS and `AppData` on Windows, the
  system temporary folder, and Station's own data folder. It also refuses
  when the folder shown reaches another folder through a symbolic link
  inside your home folder. To
  continue such a conversation, add a Project for that folder or its
  repository: **Add a project for this folder instead** in the confirmation
  opens New project with the folder already chosen. Station does not move a conversation into another Project's folder,
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
**Chat**; the dock says why it cannot open it.

See [continuation and recovery details](https://github.com/kontourai/station/blob/main/docs/guides/starter-work.md#continue-an-attached-session).

If **Recent work** can’t load sessions from another Station, Home shows an
explanation alongside any work it could load locally.

## Arrange Work You Already Own

In a Project, use **Add Pane** and choose **Work Board** to arrange exact
references to current work. It does not replace Home or create a new route.
See [Work Board](work-board.md) for pinning, keyboard controls, recovery, and
the meaning of linked-work states.

## Inspect Approval And Review Evidence

Open approval requests in **Notifications** and independent-review receipts
in the Project's **Review** layout. Inspecting a request does not approve or deny
it. Home no longer offers starter inspection cards.

Reading a receipt does not satisfy a gate. See
[how the inspection keeps the exact target](https://github.com/kontourai/station/blob/main/docs/guides/starter-work.md#inspect-approval-and-review-evidence).

Home keeps unattributed chats visible in its activity chart. Its work counters
show states such as Running and Needs you; activity groups are not a count of
configured Projects.

## Run A Scheduled Readiness Check

An automation that runs in a chat can use any agent, including agents that use an engine
such as Claude Code or Codex, when your Station supports it (see
[Automations](https://github.com/kontourai/station/blob/main/docs/user/automations.md)). The older output-file run needs an agent with
a model connection (Station's engine); if none is ready, the form offers **Set
up a scheduled-job agent** to open agent creation; choose **Use a model
connection** there.

Create and inspect scheduled jobs in **Automations**. Home no longer creates a
starter check. Existing `station-starter-check` jobs and their receipts remain
available; removing the Home card does not change their enabled state. A
completed run means it ran, not that its findings passed a gate.

## When Something Goes Wrong

An access refusal names the Station to reconnect to or says it did not accept the
message. Your draft stays editable. **Check** is for an unanswered send;
a refusal does not mean delivery is uncertain. Unknown technical errors use a
short recovery message, with diagnostics in Details where available.

The session reader and coding tabs use the same reply controls as the dock.
Shared Task history keeps the records already loaded when an earlier page fails;
use **Retry** to read that page again. Inbox search, snooze, dismissal and Undo
work across its desktop and mobile layouts.

Open the help menu and choose **Troubleshoot with an agent**, or search the
command palette for **Troubleshoot an issue**. It is also under Settings →
Diagnostics.

Where Station shows an error, a **Troubleshoot** action starts the same
conversation with that error already attached:

- a view that stopped working (under **More actions** when Station refused
  the view), and an error notification;
- a pane that is temporarily unavailable, and a layout tab Station can't show
  (when Station could not read its installed plugins, the tab offers
  **Retry** instead);
- an engine that isn't connected, and an agent that can't run;
- a local Station that stopped or failed when **Restart Station** isn't
  offered;
- a reply that failed (**Troubleshoot this**);
- a reply you rated thumbs-down, through **This looks like a Station bug**.
  Your rating is saved as usual; the bug report isn't added to it.

The assistant receives the page you were on (without anything after `?` or
`#`), the error's code and first line with known credential shapes, links and
file paths removed, and for a reply, the conversation and turn ids. It never
receives a stack trace. Troubleshooting runs on the Station you are connected
to; when the conversation isn't stored there, for example one that ran on a
paired Station, the assistant is told so and asks which Station ran it, since
this Station's logs and diagnostics don't cover it.

1. Describe what went wrong in your own words and choose **Start
   troubleshooting**. You can paste or drop screenshots into the chat.
2. The Station Assistant asks for the steps that reproduce the problem and
   which app and build you saw it in, then investigates with Station's own
   tools.
3. It offers to fix the problem, file it, both, or neither. A fix changes
   configuration only through Station's approval prompts, after you agree. It
   will not restart the Station it runs in; it gives you the steps instead.
4. To file, it shows the complete redacted report first and waits for your
   yes. It posts the issue itself only when you are the Station owner and this
   computer's GitHub CLI can label issues in kontourai/station. Otherwise it
   gives you a prefilled link to submit as yourself.

These are instructions the assistant follows, not checks Station enforces.
Read the report before you approve it.

The assistant can't read Station's server logs unless the Station owner grants
it access. If it asks, copy the relevant lines from Developer → Logs, or
download the diagnostics bundle from Settings → Diagnostics and paste the parts
that matter. Logs can contain conversation content.

If the Station Assistant has no engine, these entries open **Report a
problem** instead. The [design](https://github.com/kontourai/station/blob/main/docs/design/troubleshoot-in-app.md) covers the details.

### From a terminal

If the app itself won't open, run `station triage` in a terminal. It collects
bounded, redacted diagnostics into a private run folder, then starts Codex or
Claude, whichever is installed, as a troubleshooting conversation that follows
the same playbook. The agent keeps its usual approval prompts, so it asks
before it runs a command. It works from the run folder, Station's log folder
and commands such as `station doctor`, because Station may be down. It will not
stop or restart anything unless you say yes. To file, it prepares the report
with `station triage draft-report`, shows you the redacted text and waits for
your yes, then posts it or gives you a prefilled link.

Use `station triage --headless` for a read-only, one-shot diagnosis that saves
`diagnosis.md` and `issue-draft.md` instead. That is also what happens when
input or output is not a terminal. `station triage --context-only` collects the
diagnostics without starting an agent. See the
[CLI reference](https://github.com/kontourai/station/blob/main/docs/reference/cli.md#triage).

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

For Nightly, use that install's retained installer:

```bash
STATION_CHANNEL=nightly "${STATION_ROOT:-$HOME/.station}/installs/nightly/current/install.sh" uninstall
```
Add `--purge-data` only when you also intend to delete the selected channel's
home (`~/.station/instances/stable` or `~/.station/instances/nightly`). The installer accepts purge only
for a data root it created and marked; it preserves an unmarked pre-existing
directory for manual review.

## Next

- Read [Station concepts](concepts.md).
- Customize [keyboard shortcuts](../guides/keyboard-shortcuts.md).
- Find [settings you may not have found](settings.md), such as feature
  previews and developer tools, and learn how to [share an answer](sharing-answers.md).
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

Open Notifications, or the bell, to find work that needs your attention. Each
row names the Station, Project and chat it belongs to when known. When an approval or
permission has recorded request evidence, its row offers **Approve once** and
**Deny**; **Details** shows the full request first. Both answer that exact
request version, once. A review request with recorded evidence offers
**Inspect request** instead, where **Request identity** shows its exact record.
A row's ⋯ menu holds **Dismiss**, and **Snooze** when the Attention snooze
preview is on.

A conversation’s Inbox row also shows the request and **Approve once** or
**Deny** when Station can inspect one exact request and you can answer it.
Open the chat from its row to review an approval when those controls are
unavailable.

For a task that runs on a paired Station, the card shows **Allow** and **Deny**
for that Station's approval when your access here permits it. The paired Station
checks that the request is still open and makes the decision. When the paired
Station reports a question's exact request and your access permits it, the card
offers an **Answer on the paired Station** box whose **Send answer** reply is
bound to that question; otherwise the card says to answer it on that Station.

When the approval guardian asks you to review a call after repeated denials,
**Approval guardian** quotes its reason separately from the tool’s description.

A resolved or changed request must be inspected again from refreshed attention.
A request that cannot currently be answered remains visible without decision
buttons. If the decision cannot be confirmed, **Check request again** refreshes
its state before another attempt. Other notifications retain their existing
Session and action controls.
