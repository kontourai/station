# First-release design: Apps

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

Apps are custom screens on Station's core: found in Discover, opened from the sidebar, or added to a project as a view.

## What is wrong today

- The sidebar "Apps" section only holds fixed-template Boards: six closed section kinds, at most 24 sections, a form editor, and no custom or plugin components.
- Station already has the custom-UI capability. A Layout's tabs can render a plugin React component, a built-in component or an MCP tool UI, and a personal Layout's tabs already render outside a project. But no product path puts a plugin layout into your own sidebar: the clone routes exist with no UI.
- Installable things have four names: Plugins, Registry, Layouts and Starter layouts. The Apps library launcher is behind a preview that is off.
- The examples are real, varied apps hidden in a Registry tab: Enterprise (Calendar, CRM, Notes, Portfolio), Knowledge Docs (Library, Ask, Sources), Getting started, Coding, and the sandboxed Session activity pane.

## Agreed structure

- An App is something you add that has a screen and can bring agents, prompts, skills and knowledge with it. It is the word people see.
- An app's screen is a Layout rendered by Station: its tabs are each a plugin component, a built-in component or a sandboxed MCP view. A layout you own sits in the sidebar as an Apps row.
- A View is the same app's screen added to a project, scoped to that project. A Pane is one piece inside a view or app, or beside chat.
- Plugin is the packaging and developer word (plugin.json, station plugin create, the CLI, developer docs). A plugin can contain an app, or only skills, agents or tool requirements, which are found where they are used.
- An arranged app is an app you make with chat from the six ready-made sections. It is today's Board, renamed, and Daily brief is the default one.
- The sidebar Apps section lists installed apps, each with its own icon and a count when something needs you, with Discover as the last row.
- Apps has Discover, Library and Updates as tabs. Library and Updates are reachable from Discover or the row menu's About.
- Discover filters by what an app works with (Tasks, Chats and agents, Knowledge, Files and code, Pull requests), where it opens, and where it is from. Skills and tool servers stay in their own in-place browsers.
- The install review shows Where it goes, what it uses from Station, and an honest "runs as you" warning. Every agent action an app takes runs as a normal chat you can follow and approve.
- Making your own has two honest paths: build an arranged app with chat, or start a custom app with the plugin command and install it from a folder.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| Find and install a custom-UI app | 7+ (Cmd-K "registry", Plugins tab, item, Install, preview, Install, then Project › Add layout). Never in your sidebar. | 4 (Discover, card, Review, Add), and it is in the sidebar |
| Open an installed app | 3 (Project, layout switcher, layout) | 1 (sidebar row) |
| Put an app in a project | 4 (Project, Open workspace, Add layout, choose) | 3 (Project, +, app) |
| Make your own page | 4+ (sidebar +, name, Edit Board, sections) | 3 (Make one with chat, describe, Add to my apps) |
| Turn an app off | 3 (Plugins, item, Disable, from Cmd-K) | 2 (row menu, Turn off) |

## Screens

### `apps-01` Fresh Home with the apps tip

On a phone: The drawer shows the same empty Apps section above Discover.

1. **APPS starts empty with one hint line and Discover. Nothing is pre-added.** _(layout; slice 1.5)_
2. **The found-engine rows, exactly as first run draws them, naming the machine (Studio Mac).** This is the next state of the first-run Home, after usage sharing is answered. _(layout; slice 1.7)_
3. **The apps tip, in the slot the usage-sharing card used: what an app is, Discover apps, and dismiss.** Only one card sits under the composer at a time: first usage sharing, then this tip. _(layout, copy; slice 1.8)_

### `apps-02` Sidebar with apps and row menu

On a phone: The drawer, and a bottom sheet for the row menu.

1. **Four installed apps, each with its own icon.** _(layout; slice 1.5)_
2. **Release desk carries a count: something in it needs you. The same item is in Home's "Waiting on you".** An app-raised attention item needs new server data. _(new screen state, server work; not in the first release)_
3. **The row menu: Open, Open beside chat, Add to a project as a view…, Move up, Move down, About, Turn off, Remove….** Open beside chat exists (dock regions). Reordering is new, because boards cannot be reordered today. _(layout, new screen state, server work; slice 5.10)_
4. **Discover is the last row.** It matches the quiet sidebar. _(layout; slice 1.5)_

### `apps-03` Discover

On a phone: The same list in one column.

1. **Facets: Works with (Tasks, Chats and agents, Knowledge, Files and code), Opens as, and From.** They and their counts are derived from each app's manifest when the catalogue is listed, and a value no app declares is not offered. Pull requests is not a facet: no manifest field declares it. _(layout; slice 1.4)_
2. **A card answers four questions at a glance: what it is for, its screens (its tab labels), what it brings and needs, and trust.** An entry that has no screen, or whose manifest Station could not read, says so and appears only while no facet is chosen. _(layout; slice 1.4)_
3. **Trust is honest. In-process apps say "Runs in Station's window", and only an app with no screen code of its own, whose views are MCP tool UIs, says Sandboxed.** The trust tier does not change how an app renders yet. _(copy; slice 1.4)_
4. **Skills and tool servers stay in their own in-place browsers (Skills › Browse, Customize › Tools).** Skills and tool servers are browsed where they are used, so each kind of thing has one catalogue. _(layout; slice 1.4)_
5. **An app shows "Added" only when it is installed, with Manage (in Library) and Remove; one not installed shows "Review".** There is no pre-added set: a fresh install has no apps (`apps-01` change 1). _(layout; slice 1.4)_
6. **The cards are the catalogue's real entries, named as the catalogue names them.** Invented examples are not listed, and Daily brief, an arranged app, is not a catalogue entry. _(copy; slice 1.4)_

### `apps-04` App detail (Enterprise)

On a phone: The same page in one column.

1. **"What it puts in your sidebar": one Apps row, plus its 4 real tab names.** This is from the real Enterprise manifest and layout. _(layout; slice 5.9)_
2. **What it brings: an agent, 4 prompts (the distinct prompts its actions send), the Meeting notes collection, and sample data providers.** Its tab actions and package actions name the same four prompt files, so they are counted once each. _(layout; slice 5.9)_
3. **Permission tiers, each with its plain meaning.** The tiers are the real ones. _(copy; slice 5.9)_
4. **"Its screen runs inside Station's window, as you."** In-process code has no isolation today. _(copy; slice 5.9)_
5. **"What it uses from Station": the app's SDK hooks named in plain words (send to chat, its agent, current project, toasts).** _(copy; slice 5.9)_
6. **Where it can open: sidebar, project view, beside chat.** _(layout; slice 5.9)_

### `apps-05` Install review

On a phone: A bottom sheet.

1. **"Where it goes": the sidebar (only you) and, optionally, a project as a view.** The sidebar placement is new, because there is no UI path today. The clone and personal-layout API exist. _(new screen state; slice 5.9)_
2. **Per-component checkboxes.** These exist today. _(layout; slice 5.9)_
3. **Permissions, with extension code off on this device until allowed.** This exists today. _(layout; slice 5.9)_

### `apps-06` An app open: Release desk

On a phone: A list only. The running chat collapses into a bottom bar with Details, ⋯ and Open.

1. **The app bar: its identity plus the app's own tabs.** These are the layout tabs. _(layout; slice 5.10)_
2. **A list and detail of pull requests with checks and the Task behind each.** Pull request data in plugin UI goes through an agent's GitHub tool or a server route. There is no pull request hook or component in the SDK yet. This needs a backend check. _(backend check first; not in the first release)_
3. **"Send to release agent" uses the app's own agent.** The SDK hooks for this exist. _(layout; not in the first release)_
4. **The chat opens in the right region, beside the app, labelled "Sent from Release desk".** The pane header carries the chat title, Details and ⋯, and Details opens inside the pane with Setup, Usage and Work. The SDK cannot embed chat inside an app, so the app hands off to Station's chat region. The "Sent from" label is new UI only. _(new screen state; slice 5.10)_
5. **"Move to Done" uses the task mutations.** They are listed in the SDK reference and were not traced. _(backend check first; not in the first release)_

### `apps-07` An app open: Enterprise

On a phone: A list, then a detail with "‹ Accounts".

1. **Its 4 real tabs, with the CRM tab open.** _(layout; slice 5.10)_
2. **Its real prompt actions ("Review log activity", "Generate report") as buttons.** _(layout; slice 5.10)_
3. **"Ask Enterprise assistant…" sends to chat.** The app's source uses this hook three times. _(layout; slice 5.10)_
4. **The content is drawn from its real CRM screens (accounts, opportunities, tasks, segment, territory), with sample data.** _(copy; slice 5.10)_

### `apps-08` An app open: Research notes

On a phone: The same screen in one column.

1. **A document editor with inline citations recalled from project knowledge.** The recall component and knowledge hooks exist. _(layout; not in the first release)_
2. **Selection actions: "Ask the agent to compare" and "Find more sources".** They use the send-to-chat and knowledge hooks. _(layout; not in the first release)_
3. **Recalled sources: a decision log, a repo file, a past chat.** _(layout; not in the first release)_
4. **Saving notes needs a backend check.** The plugin needs storage through a server route or a knowledge namespace. Plugin-contributed knowledge stores a proposal only today. _(backend check first; not in the first release)_

### `apps-09` An app as a project view

On a phone: The same view in one column.

1. **Knowledge Docs as a view tab in Notes API, with its own sub-tabs (Library, Ask, Sources) and its real pane action "Summarize selected documents".** _(layout; slice 3.9)_
2. **The "+" menu: Views in Notes API, "Add one of your apps", then "Find apps with a project view".** Release desk reads "Shows this project only" and Daily brief "Not for projects". It matches the Add view menu in Projects. _(layout; slice 3.9)_
3. **Project layouts and plugin layouts in projects exist today, so picking from "your apps" is a regroup.** _(layout; slice 3.9)_

### `apps-10` Make your own app

On a phone: The same screen in one column.

1. **"Build with chat": the step line reads "Drafted a page from ready-made sections", then Add to my apps, Preview or Discard.** The proposal uses 5 sections of the six ready-made kinds: tasks, attention, recent work, projects, note and links. This exists today. _(layout; slice 5.12)_
2. **A chart or a paging button is not possible with sections, and the agent says so, naming the six kinds.** Today's boards have six closed section kinds. _(copy; slice 5.12)_
3. **"Start a custom app": run the plugin create command with the layout template, then Apps › ⋯ › Install from a folder.** The command and the install from a folder exist. "Start it as a project" is new UI only: the agent runs the command inside a new project. _(new screen state; slice 5.12)_

### `apps-11` Library

On a phone: The same lists in one column.

1. **"In your sidebar" and "Off" sections, showing what each app brought and where it is placed (sidebar, project views).** Drag to reorder is new, and needs a stored order. _(new screen state, server work; slice 5.11)_
2. **An update is reviewed, never automatic.** It uses the update review. _(layout; slice 5.11)_
3. **Remove asks about each thing the app brought.** Per-item removal confirmation is new UI. _(new screen state; slice 5.11)_

### `apps-12` Chat: add an app

On a phone: The same transcript with a bottom sheet for the review.

1. **Plain steps: "Looked through apps you can add · 7 found" and "Checked Enterprise 1.0.0".** The two tools behind these steps exist. _(layout; slice 5.9)_
2. **The proposal card: goes to, brings, allows.** This card exists today. _(layout; slice 5.9)_
3. **"Review and add…" opens the same Apps install review, naming the chat that asked.** The person completes the install there. _(layout; slice 5.9)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Sidebar "Apps" section | Keep | Keeps the name. It lists installed apps plus Discover. |
| Today's fixed Boards | Simplify | Kept as one built-in app kind, "arranged apps", made with chat or the section editor. Daily brief is the default one. "+ New Board" becomes "Make one with chat". |
| Apps library (preview) | Remove | Apps › Library replaces it. |
| Plugins as a destination | Remove | Replaced by Apps (Discover, Library, Updates). "Plugin" stays the packaging word. |
| Registry tabs: Plugins and Layouts | Simplify | Become Apps › Discover. |
| Registry tab: Skills | Simplify | Becomes Skills › Browse. |
| Registry tab: Integrations | Simplify | Becomes Customize › Tools › From the list. |
| Registry tab: Agents | Remove | Empty. Agents arrive inside apps. |
| Layouts tab | Remove | The tab goes and the concept stays: a Layout is how an app's screen is built, a developer word. |
| Kits | Hide for the first release | Still hidden for v1. A read-only view from a portable package would appear as an app with a project view when one ships. |
| Starter layout (New Project) | Simplify | Becomes an optional "Add apps as views", per the Projects design. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Custom React screen | copy | Exists today (layout tabs, in-process). No change. |
| App in your sidebar | new screen state | Planned for v1. The renderer, storage and clone routes exist with no UI, so it needs new UI and a small API client. |
| App as a project view | copy | Exists today (project layouts). Relabel. |
| Arranged app (today's Board) | copy | Exists today. Rename only. |
| Discover, Library and Updates | layout | Plugins and Registry exist. A regroup plus routing. |
| Facets "Works with" and "Opens as" | server work | Derived from each catalogue entry's manifest when the catalogue is listed. |
| App badge or attention item | server work | Planned after v1. New server data and an SDK hook. |
| Reorder apps | server work | Planned for v1. New UI plus a stored order. |
| "Sent from <app>" chat label | new screen state | Planned for v1. UI only: the origin on the chat. |
| Embedded chat or diff component | new screen state | Later. A new SDK component. |
| Pull request and issue data hooks | new screen state | Later. Today only through an agent's tool call or server routes. |
| Schedules in the manifest | server work | Later. A new manifest field and server work. Use Automations meanwhile. |
| Bundled tool servers | server work | Later. Today only required tools are declared. Needs manifest and install work. |
| Permission enforcement for in-process UI | server work | Needed before public app sources. A new runtime. A sandboxed frame exists. |
| Live reload in Station | chat tool | Later. Developer tooling. Today there is a mock SDK server. |
| Instance-shared apps | new screen state | Later. Storage only today. Needs new UI and sharing. |

## Decisions taken during design

- Considered: keeping the fixed-template Boards and hiding Layouts and the Apps library. Chosen: apps as custom screens on Station's core, at the owner's request. Apps is now the word people see, and plugin is the packaging word.
- Today's boards stay as one built-in kind of app, made with chat from six fixed section kinds.
- No Pin in an app's row menu: every installed app is already in the sidebar.
- Library and Updates are tabs beside Discover.
- Apps from sources other than Station are not in the first release. App code runs inside Station's window with your access today, and nothing yet limits it to the permissions it declared.
- An app's place in the sidebar is per person in the first release. Shared apps exist only as storage today.
- Release desk and Research notes are invented examples. Enterprise, Knowledge Docs, Coding and Session activity are real examples from the repository.
