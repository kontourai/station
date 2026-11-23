# First-release design: Navigation, Home and Customize

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

A quiet sidebar with one labelled Customize page replaces the footer dialog, and a fresh Home works out of the box.

## What is wrong today

- The sidebar has three things (Home, Projects, Apps) and an empty navigation list in code. Every other destination is in a footer Customize dialog, the avatar menu or Cmd-K.
- Customize is an unlabelled footer icon, one of four with no labels. It opens a dialog with no URL and no back button.
- Nothing inside Customize raises attention when something needs fixing, and the dialog ignores the three groups the code already declares.
- "Apps" in the sidebar means personal Boards, while the Registry and Plugins also use app-like words.
- The Registry has no entry anywhere except the palette and buttons inside Plugins and Skills.
- Settings is reachable only through the avatar menu, Customize, the palette or Cmd+, and Appearance has more than one home.
- A fresh Home shows two numbered cards ("1 · Choose your AI", "2 · Add a Project") above a composer whose default engine is not saved and drifts as engines become ready.
- The collapsed rail keeps only Home, a plus and a grid icon, and the footer mixes Automations, new chat, updates and the avatar with no labels.

## Agreed structure

- The sidebar is quiet: only Home and Automations sit above Projects. An Apps section follows, with one row per installed app and then Discover. Customize is pinned above Settings, with a dot when anything inside needs attention.
- Customize is a real page with its own URL. A grouped left list uses the groups the code already declares, renamed for people: Your agents (Agents, Skills), What they run on (Engines, Providers), What they can reach (Tools, Knowledge). Each item shows counts and dots.
- The Customize landing shows one card per item with what is there and what needs attention, and the fix inline. A banner such as "3 things need you" names each problem.
- The Customize dot rolls up only recorded readiness failures. Agents and Skills have no attention signal today, so they never raise it.
- Any Customize item can be pinned to the sidebar. A pinned row can carry its own dot, and can be unpinned, moved up or moved down.
- Installable things are Apps, found through Discover. Devices and other Stations live under the Station chip in the header.
- The header keeps the breadcrumb, search and Cmd-K, the Station chip, the Notifications bell and the region controls. On phones the Station chip is a dot and a chevron, and the drawer header shows "● Studio Mac".
- Appearance moves into one Settings page, with the existing keyboard shortcut and palette command for theme. The Profile page is dissolved: account details go to Settings › Account and Usage opens from the avatar menu and the palette.
- The command palette groups results as This chat (in a chat), Go to, Actions, Chats and Ask. About 26 fixed entries show, plus one per project, app and recent chat. Individual Settings rows, engines, providers and accounts, and apps' own commands appear only when you type.
- On phones the drawer has the same structure, with Customize and Settings pinned to its bottom.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| Fix a rejected provider key | 4+ | 2 (Customize, Update key on the card), or 1 when Providers is pinned (Providers, Update key) |
| Open Agents | 2 (Customize dialog, then Agents) | 2 (Customize, Agents), or 1 when pinned |
| Open an app | 1 (Boards) | 1 |
| Notice that something needs setup | Not shown | A dot on Customize, and the page names the item. A pinned item shows its dot too. |
| Add a new app | Not available | 1 (Discover) |
| Open Settings | 2 (avatar, Open settings) | 1 |

## Screens

### `navigation-06` Home with work in progress

On a phone: The menu button opens the drawer. The composer wraps so the engine picker and Start get their own row.

1. **Only Home and Automations sit above Projects.** A sidebar listing every destination was considered and rejected as too noisy. _(layout; slice 1.5)_
2. **An APPS section replaces Boards: one row per installed app, each with its own icon, then Discover.** Apps are the word people see. The app names shown are placeholders. _(layout, copy; slice 1.5)_
3. **Customize is labelled and pinned above Settings, with a dot when anything inside needs attention.** Today Customize is an unlabelled footer icon, and nothing inside it can raise attention. _(layout, new screen state; slice 1.5)_

### `navigation-07` Fresh Home

On a phone: The drawer shows the same empty Apps section above Discover.

1. **A fresh install has no apps yet, only Discover. The empty Apps section reads "Apps you add get their own screen here."** Today a new user sees a section header with a lone plus and nothing to say what it does. _(layout; slice 1.5)_
2. **Customize carries no dot on a fresh install.** A fresh install with two signed-in engines is complete. Nothing optional should look like a problem. _(layout; slice 1.5)_

### `navigation-08` Customize page

On a phone: The left list is hidden. The landing cards are the list, with push navigation into each item.

1. **A grouped left list: Your agents, What they run on, What they can reach, with counts and dots on each item.** The groups hold Agents and Skills, Engines and Providers, and Tools and Knowledge. They are the groups the code already declares, renamed for people. Today's dialog ignores them. _(layout, copy; slice 1.2)_
2. **"3 things need you" names each problem and says the sidebar dot clears when they are fixed.** Today nothing inside Customize raises attention. _(new screen state; slice 1.3)_
3. **"New chats start on Claude Code · Opus through Claude subscription · Personal Max. Change"** Today nothing stores a default, so it changes as engines become ready. _(layout; slice 1.3)_
4. **The landing has one card per item, with what is there, what needs attention, and the fix inline.** Each item answers "what is there" and "what needs me". _(new screen state; slice 1.3)_
5. **A Pin button on every card.** Items can be promoted to the sidebar. Station has no per-user pin preference today. _(new screen state, server work; slice 1.6)_
6. **Plugins leaves this list. Installable things are Apps (Discover).** Devices and other Stations live under the Station chip. _(layout, copy; slice 1.2)_

### `navigation-09` Pinned items in the sidebar

1. **Providers is pinned under Automations and carries its own attention dot.** The quiet sidebar puts Providers one level down. Pinning keeps it one click away for someone who visits it often. _(new screen state; slice 1.6)_
2. **Right-click or ⋯ on a pinned row offers Unpin, Move up and Move down. The page header also has "Unpin from sidebar".** _(new screen state, server work; slice 1.6)_
3. **The Customize list marks pinned items with a pin glyph.** _(new screen state; slice 1.6)_

### `navigation-10` Collapsed sidebar

1. **The rail keeps Home, Automations, project initials, app icons, Discover, and Customize with its dot.** Today the rail keeps only Home, a plus and a grid icon. _(layout; slice 1.5)_

### `navigation-11` Phone drawer

On a phone: This screen is phone only.

1. **The drawer has the same structure as the desktop sidebar. Customize and Settings are pinned to its bottom.** Today the phone drawer's footer is four unlabelled icons, and Agents, Skills and Connections are three taps from Home. _(layout; slice 1.5)_

### `navigation-22` Command palette

On a phone: A bottom sheet at 86% height, one column, with 44px rows. The footer is hidden.

1. **A "This chat" group comes first: Start fresh context… /fresh, New chat from latest answer, Details ⌘I. It shows only when a chat is focused.** This matches the Chat design. _(layout; slice 4.11)_
2. **"Go to": Home, Automations, each project, each app, Customize and its six items, the Station page, Discover apps, Settings ⌘,.** Today the palette lists about 80 entries, including retired routes and every Connections tab. _(layout; slice 2.18)_
3. **The Station page is reachable by its name.** One place for devices and other Stations. _(copy; slice 2.18)_
4. **"Actions": New chat ⌘N, New project, Connect a device, Add a provider. More appear when typing.** Today's palette lists 80 entries at once. The common actions lead, and the rest appear as you type. _(layout; slice 2.18)_
5. **"Ask": "Ask Station about …" opens a new chat with the text.** Chat can do what screens do. No such fallthrough exists in the palette today. _(new screen state; slice 2.18)_
6. **Footer hints: ↑↓ Move, ↵ Open, ⌘↵ Open beside, ">" for actions only.** _(layout; slice 2.18)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Sidebar navigation | Simplify | Quiet: Home, Automations, Projects, Apps, Customize and Settings. Listing every destination was considered and rejected. |
| Customize dialog | Simplify | Becomes a page with its own URL, a grouped left list and an attention dot. |
| Registry as its own page | Remove | Installable things are Apps, found through Discover. |
| "Apps" section label | Simplify | Now means installed apps, one row each, with Discover below. |
| Appearance page and Settings › Appearance | Simplify | One Settings › Appearance page, plus the shortcut and palette. |
| Profile page | Simplify | Becomes Settings › Account plus a Usage page from the avatar menu and the palette. |
| Developer surfaces | Hide for the first release | Behind developer tools, inside Settings. They are an operator concern. |
| Command palette | Keep | Regrouped: This chat, Go to, Actions, Chats, Ask. |
| Palette entries for Registry, Plugins, Connections and its tabs, Computers | Remove | Dropped from today's roughly 80 entries. Apps, Customize and the Station page replace them. |
| Palette entries for retired routes, Boards, Layouts, Kits and "Take the tour" | Remove | Dropped from today's roughly 80 entries. |
| Notifications bell | Keep | It works. |
| Home cards "1 · Choose your AI" and "2 · Add a Project" | Remove | Replaced by the summary of what Station found. |
| Region controls (bottom and right) | Keep | Untouched, out of scope. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Quiet sidebar: fill the empty navigation list, remove the Customize dialog | layout |  |
| Customize page | new screen state | Composes existing list and health data. |
| Pins | server work | A new per-user preference. Also new UI. |
| Attention roll-up across Engines, Providers and Tools | new screen state | The per-tab signals exist. Agents and Skills have no attention signal today. |
| Customize dot limited to recorded readiness failures | backend check first | The dot can become noise if "needs attention" is defined loosely. |
| Palette grouping and the "Ask Station" fallthrough | new screen state | UI only. The This chat group already exists. |
| Palette fixed entries | layout | Copy and regroup of the existing destination entries. |
| Collapsed rail with all items | layout |  |
| Phone drawer | layout |  |
| Stable default for new chats | server work | A new saved default engine and model. |

## Decisions taken during design

- Considered: listing every destination in the sidebar. Chosen: a quiet sidebar with one Customize entry, because the full list was too noisy, on three conditions: Customize is a real page, its dot reports only recorded failures, and any item can be pinned.
- With a Customize page, a Connections page inside it would be a third level of navigation. Connections no longer exists as a destination; its parts are items in Customize.
- Automations stays in the sidebar. It is daily work, not setup.
- There is no header theme toggle today. Theme lives in Settings › Appearance, with the existing keyboard shortcut and palette command.
