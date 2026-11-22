# Station for its first release: the agreed design

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

This record and its area files are the specification the build is checked against. Each area file lists its screens and, for each screen, the numbered changes a slice must deliver. The delivery sequence is in [the execution plan](../plans/first-release-ui.md). The owner agreed this design on 2026-11-21.

## Areas

| Area | Screens | Numbered changes |
| --- | --- | --- |
| [Navigation, Home and Customize](first-release-navigation.md) | 9 | 24 |
| [Station: devices, people and other Stations](first-release-station.md) | 10 | 25 |
| [First run and connecting a device](first-release-first-run.md) | 13 | 41 |
| [Customize: engines, providers and knowledge](first-release-customize.md) | 19 | 87 |
| [Agents, Skills and Tools](first-release-agents-skills-tools.md) | 14 | 54 |
| [Projects](first-release-projects.md) | 17 | 77 |
| [Chat: usage, work, setup and actions](first-release-chat.md) | 31 | 89 |
| [Automations and inbox](first-release-automations-inbox.md) | 12 | 69 |
| [Apps](first-release-apps.md) | 12 | 47 |
| [Settings, Developer and Usage](first-release-settings.md) | 9 | 44 |

## What was agreed

### Getting around

- A quiet sidebar: New chat, Home, Automations, Projects, Apps, then Customize and Settings.
- **Customize** is a page with six items in three plain groups: Agents and Skills; Engines and Providers; Tools and Knowledge. A dot on its row shows when something inside needs you, and any item can be pinned to the sidebar.
- The header's Station chip opens one **Station** page for devices with access, people and other Stations.
- First run is the Home screen itself. The setup wizard, the tour and the "Finish setup" card are gone.

### What agents run on

- One vocabulary: **Engine → Provider → Account → Model**, with provider + account as the thing you pick and meter.
- Engines show what Station actually knows: signed in; installed, sign-in not checked; needs sign-in; not installed.
- Adding a provider takes three steps and saves nothing until the check passes.
- Usage-left meters appear only where Station can read them: Claude Code and Codex subscriptions.

### Projects

- New Project asks one question: start empty, use a folder, or clone from Git.
- A project is one page with tabs: Overview, Chats, Tasks, Files, plus any app you add as a view.
- Project settings drop from 14 visible sections to five, plus Views.
- A task has one status. Waiting on you is a flag on the card.

### Chat

- One Details panel with three tabs replaces the stats modal, the inventory pane, the Basis pane and the chat settings dialog.
- **Usage** shows how full the context is, what the chat used, where it went, and what is left on the account. After an engine change it shows each engine separately and never adds them together.
- **Work** leads with what the chat produced. The Basis chip appears only on answers that have an assessment.
- **Setup** shows what the chat runs on. About 57 menu entries become 38, with one name each.

### Apps

- An app is something you add that has its own screen and can use Station's core: chats, agents, tasks, knowledge and files.
- Apps live in the sidebar, with Discover, Library and Updates. The same app can be added to a project as a view.
- Today's boards remain as one built-in kind of app, made with chat from six fixed section kinds.
- "Plugin" stays only as the packaging and developer word.

### Automations, inbox and settings

- Automations show the next seven days, each automation's recent runs, and a labelled Pause. A run links to its chat.
- The inbox has one row per thing with one status. **Mark done** replaces Settle, Dismiss and Hide.
- Settings is a grouped list with search that finds individual settings. About 27 rows move to the area that owns them.
- Of 61 feature previews: turn 11 on by default, keep 10 visible, leave 28 off or behind Developer mode, delete 5. The other 7 are sub-options or were not visible in the capture.

## Vocabulary

| Term | Meaning | Examples |
| --- | --- | --- |
| Engine | What runs the agent. | Station, Claude Code, Codex, OpenCode |
| Provider | A service plus its way of signing in. Auth is part of the provider. | Claude subscription, Claude API, Z.AI Coding Plan, Amazon Bedrock, OpenRouter, Ollama, CLIProxy |
| Account | One sign-in or key under a provider. It owns usage left and limits. | Personal Max, Work |
| Model | What you pick per chat. One canonical model, however many providers serve it. | Opus, GLM |

- The thing you select and meter is provider + account: "Claude subscription · Personal Max". The account part is hidden when there is only one.
- A provider is who you connect to and pay, not who made the model. Bedrock and OpenRouter serve other makers' models.
- A proxy such as CLIProxy is a provider with a visible Proxy tag. Its real accounts live inside the proxy, so Station shows no usage left for it and says why.
- Accounts are real today only for Claude Code, Codex and Muse sign-ins. An API-key provider holds one key, so Providers is drawn as two groups: Subscriptions, and Keys and local models.
- API format (OpenAI-compatible, Anthropic-compatible) is an attribute, never a noun. It appears in the custom-endpoint flow and as the reason a pairing is unavailable.
- One default account per provider. Switching accounts automatically stays an explicit setting that is off by default, as it is today.
- There are no money budgets anywhere today, so none are drawn.
- Usage by model is shown only for Station's own engine, where the model for each turn is known. Usage on outside engines, including through a proxy, is grouped by engine and provider and always counted.

## Words that change

| Today | Agreed | Why |
| --- | --- | --- |
| Customize dialog (an unlabelled footer icon) | Customize, a labelled row that opens a page | The idea worked. The dialog had no address, no back button and no way to show that something inside needed attention. |
| Connections, and its tabs | Customize › Engines, Providers, Tools, Knowledge | One list in plain groups, with no third level of navigation. |
| Models tab, "Model connection" | Providers, "Provider" | The tab listed connections, not models. |
| Computers tab, the Stations manager dialog | The Station page | Devices are about who can reach Station, not what agents run on. |
| Pair a Device · Revoke | Connect a device · Devices with access · Remove | One verb for the action, and a heading Station already uses. |
| READY on engines | Signed in · Installed, sign-in not checked · Needs sign-in · Not installed | READY only means the program was found, plus a sign-in check where one exists. |
| Connect through | Runs through: provider · account | Names what is being chosen. |
| Plugins · Registry · Extensions · Kits | Apps (Discover · Library · Updates) | One word for things you add that have a screen. Plugin stays as the developer word. |
| Apps (sidebar section listing Boards) | Apps (sidebar section listing apps) | The section now holds what its name says. A board is one built-in kind of app. |
| Layout · Workspace view · Starter layout | View | An app's screen inside a project. Pane stays for a piece inside a view. |
| Coding (layout) | Chats (view) | It is where a project's chats live. |
| Provider (Git host in New Project) | Clone from GitHub · GitLab · URL | Provider now means a model provider. |
| Integration · MCP server · tool server | Tool server | "Integration" meant three different things. |
| Commands tab | A command word on a skill | A command was already a skill with a trigger. |
| Profile | Settings › Account, plus a Usage page | Profile mixed identity with usage charts. |
| Files & connections · Sources | Files | Two pages held the same content. |
| Conversation stats | Usage (a tab in the chat's Details panel) | It answers what the chat used and what is left. |
| Chat inventory | Work | It shows what the chat did and produced. |
| Basis | About this answer | Most answers have no assessment, and the old name explained nothing. |
| Chat settings | Setup | The chat's real settings are what it runs on. Display preferences belong in Settings. |
| Fork from here · Branch from this answer · New chat from this message | New chat from here | One action had three names. |
| Rewind conversation · Restore workspace · Reset agent context | Rewind chat to here · Restore files to here · Start fresh context | Each name says what changes, with a line under it saying what stays. |
| Settle · Dismiss · Hide | Mark done | Three words for one action, and the first needed explaining. |
| Automation on / off | Active / Paused | Pause was hidden in a clickable status cell. |

## How the design is kept

- A slice cites the screens and change numbers it delivers. Its pull request shows a screenshot from a running build beside the agreed render, on desktop and phone.
- If building shows a change is wrong, the area file is amended in the same pull request with the reason.
- A change marked "backend check first" names an assumption the slice must confirm before building.
- Changes marked "not in the first release" are recorded so later work starts from the agreed design.
