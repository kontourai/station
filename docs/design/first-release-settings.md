# First-release design: Settings, Developer and Usage

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

Settings is regrouped by who a setting affects, Developer becomes a Settings group behind Developer mode, and Usage has one home with by-model totals only for Station's own engine.

## What is wrong today

- Settings has 10 pages and about 105 rows. General alone mixes four owners: approvals, the default model, agent instructions and the Review guide model. Advanced holds nine unrelated sections, including, on a fresh install, 58 visible preview toggles in one 6000px scroll.
- Appearance has two homes: a Settings › Appearance stub that links out, and the /appearance page. There is no header theme toggle.
- Notifications lists "Station local UI", "(2)" … "(8)" as identical device rows with identical controls.
- The 61 feature previews are all off except one. About a quarter gate finished-looking product, and operator diagnostics sit beside user features with the same chrome.
- Developer is a separate hidden destination that duplicates Advanced › System and Diagnostics. "Telemetry" also means usage-sharing consent in Privacy.
- Profile mixes four jobs (identity, a usage dashboard with empty milestones, operator breakdowns and diagnostics) and is reachable only from the avatar menu.

## Agreed structure

- Settings groups: You (Account, Appearance, Chat and voice, Notifications, Keyboard shortcuts), This Station (Permissions and safety, Workspaces and terminals, Privacy and data, Memory, Updates and backup, and a Station link), and More (Feature previews, Help and about). The Station row opens the Station page.
- Everything in Settings saves as you make the change, with a "Saved" tick. An error shows on the row that failed. A row that needs a restart shows "Restart to apply". Scope tags (Your account, This device, Station) are kept.
- About 27 rows move to the area that owns them: 4 to Customize › Engines, 1 to Customize › Providers, 3 to the Station page, 4 to Agents, 7 to Project settings, 1 to Automations, 3 to Apps › Manage sources, 1 to Developer. Three are hidden for v1 (Device hosts, Device setup, Device helper URL). Settings search still finds moved rows under "Moved to where it's used".
- Developer is a Settings group that appears only with Developer mode on: Logs, Monitoring, System, Resources, Archive and Developer previews. A normal user sees only the Diagnostics bundle and "Troubleshoot with an agent" in Help and about.
- Developer previews is a new page. It holds the 26 operator and developer previews plus the device-scoped developer-tool previews, tagged "This device", which merges two preview systems into one list.
- Usage is one destination, reached from the avatar menu, Cmd-K and Account › "Open Usage". Profile is dissolved: identity goes to Account, usage charts to Usage, paired people to the Station page.
- Usage shows By model, By provider, By project and By day over 7, 14 or 30 days. By model is shown only for Station's own engine. Usage on outside engines is grouped by engine and provider.
- Customize › Providers keeps what is left on a subscription. Monitoring keeps operational health, not consumption.
- Usage stays local and never leaves the Station. Privacy and data › Usage sharing is the only control over what goes to Kontour, and the word "telemetry" is retired from the UI.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| Switch to dark mode | 5 (avatar, Open settings, Appearance, Open Appearance, Dark) | 3 (Settings, Appearance, Dark), or 2 plus typing (Settings, type "dark", toggle in the result) |
| Turn on a preview | 4 plus scrolling through 58 toggles (avatar, Open settings, Advanced, scroll, toggle) | 3 (Settings, Feature previews, toggle) |
| Read server logs | 6 (Settings, Advanced, Developer tools, enable, Cmd-K Developer, Logs) | 2 (Settings, Logs), once Developer mode is on |
| See usage by model | 3+ (avatar, Profile, scroll, Operator breakdown), with no model cut for normal users | 2 (avatar, Usage) |
| Places to look for a setting | 10 pages and about 105 rows, plus /appearance, /profile and 5 Developer tabs (17 places) | 12 pages and about 85 rows for a normal user, 6 more with Developer mode |

## Screens

### `settings-06` Settings: Appearance

On a phone: Settings becomes a section list that pushes to this page with "‹ Settings". Segmented controls drop below their label at full width (44px). The theme grid shows 2 columns and 4 themes.

1. **The Settings rail is grouped (You, This Station, More), with search at the top. A Station row links to the Station page.** The groups say who a setting affects, which is Station's own addition. _(layout; slice 5.17)_
2. **"Find a setting" with the "/" shortcut.** Search results are shown on the search screen. _(layout; slice 5.18)_
3. **One home for Appearance. All of the /appearance page moves here and the Settings stub is deleted.** Appearance has two homes today. _(layout; slice 5.19)_
4. **A "Saved" tick.** One save behaviour across Settings. _(new screen state; slice 5.17)_
5. **The terminal screen-reader row moves here from the old Settings › Appearance, tagged "This device".** _(layout; slice 5.19)_

### `settings-07` Settings: Permissions and safety

On a phone: The summary becomes a 2x3 grid, and the long approval-mode control drops below its label.

1. **"At a glance": a summary of six facts that link to their rows.** For example "Devices with access" opens Station › Devices with access, and "Apps with active permissions" opens Apps › Library. Each fact is worked out from existing settings and counts. _(new screen state; slice 5.19)_
2. **"For: All projects" is kept from today.** Projects can override. _(layout; slice 5.19)_
3. **Default approval mode, highlighted where the summary's "Change" lands.** _(layout; slice 5.19)_
4. **Per-engine overrides are collapsed into one row.** Today there are three repeated segmented rows. _(layout; slice 5.19)_
5. **The error sits on the row that failed, never as a banner above unrelated toggles.** _(new screen state; slice 5.19)_
6. **"Continue after a restart" graduates from a preview to an ordinary setting, on by default.** _(server work; slice 5.19)_

### `settings-08` Settings: Notifications

On a phone: Selects go full width at 44px. "Open inbox" is hidden because the bell is in the toolbar.

1. **What can interrupt you: one control.** It is today's three-option row. _(layout; slice 5.19)_
2. **Quiet hours, with the time range shown.** Showing the range needs a backend check. _(backend check first; slice 5.19)_
3. **"Where": this browser plus named devices, with "Last seen". Removing a device happens in Station › Devices with access.** Naming and last-seen need a backend check. _(backend check first; slice 5.19)_
4. **Six devices not seen for 30 days are collapsed into one row.** Today they appear as "Station local UI (2…8)". Finding duplicates and stale devices needs a backend check. _(backend check first; slice 5.19)_
5. **"Open inbox": the bell inbox stays the inbox, and settings live only here.** _(layout; slice 5.19)_

### `settings-09` Settings: search

On a phone: This is the section-list page in search mode. Results are full width with 52px rows. Live controls are hidden (you tap through to the row) and keyboard hints are dropped.

1. **The query in the rail search.** _(layout; slice 5.18)_
2. **Results show page and section breadcrumbs, and the control is live inside the result, so a change takes two actions.** _(new screen state; slice 5.18)_
3. **"Moved to where it's used": rows that left Settings still match, with "was Settings › General".** The reshuffle must not lose anyone. For example the default model now lives in Customize › Engines, and the default region for Bedrock models in Customize › Providers › Amazon Bedrock. _(new screen state; slice 5.18)_
4. **A fall-through to "Ask Station".** The search index of moved rows is new, UI only. _(new screen state; slice 5.18)_

### `settings-10` Settings: Feature previews

On a phone: Switches are 44px, and sub-option indents are kept.

1. **"11 previews are now ordinary features", with a link to where each went.** Two are partial: Brief graduates without Memory or Models, and Archive graduates without Pause. The examples named (Continue after a restart, Open and settled inbox, Snooze, Guided engine setup, Project overview) graduate fully. _(copy; slice 5.23)_
2. **Ten user-visible previews in four groups, each stating its cost before you turn it on.** Examples are "Each wake is a model call" and "Your code leaves this computer". The copy is condensed from today's descriptions. _(copy; slice 5.23)_
3. **Dependent previews are sub-options of their parent (Coordinator, then working picture and project supervision).** Today they are separate rows that say "Needs Coordinator chat". _(layout; slice 5.23)_
4. **"Developer mode" sits at the foot of the page. It reveals the Developer group.** Developer pages are for people who ask for them. Today the switch sits in Settings › Advanced beside unrelated sections. _(layout; slice 5.23)_

### `settings-11` Developer: Logs

On a phone: Lines wrap with the date dropped. The filter is full width at 44px.

1. **The Developer group in the Settings rail, shown only with Developer mode.** Today Developer is a separate hidden destination that duplicates Advanced › System and Diagnostics. _(layout; slice 5.24)_
2. **"Detail kept" (the log level) moves here from Advanced › System. The Diagnostics bundle is also available here.** Developer pages are for people who ask for them. Today the log level sits in Settings › Advanced beside unrelated sections. _(layout; slice 5.24)_
3. **Filter, level and Follow live.** These exist today. The controls are condensed. _(layout; slice 5.24)_
4. **The stream uses neutral, readable messages. Structured records sit behind each line.** _(copy; slice 5.24)_

### `settings-12` Settings: Account

On a phone: This file shows the section list. It is the Settings root on a phone, grouped, with 48px rows and chevrons that push to each page.

1. **Account: identity and role.** "Edit name" needs a backend check. _(backend check first; slice 5.22)_
2. **Your usage: one line plus "Open Usage".** Usage is not a setting. _(layout; slice 5.22)_
3. **Access: the role in plain words. People and devices link to Station › Devices with access.** _(layout; slice 5.22)_
4. **Import preferences (exists), and Sign out.** _(layout; slice 5.22)_

### `settings-13` Usage

On a phone: Two headed card lists: Station's engine by model, and Outside engines by provider.

1. **Tabs: By model, By provider, By project, By day.** By provider, project and day exist in the usage rollup today. By model is new for Station's engine. _(layout, server work; slice 5.22)_
2. **A 7, 14 or 30 day switch.** This is exactly what the API supports. _(layout; slice 5.22)_
3. **A summary. Recorded cost says "Amazon Bedrock only".** Prices exist only for Amazon Bedrock. Everything else is unpriced, and Station never invents a price. _(copy; slice 5.22)_
4. **A split card: 1.63M tokens by model on Station's engine, 3.19M on outside engines.** Station knows the model for each turn only on its own engine. Outside engines are counted, and grouped by engine and provider. _(layout; slice 5.22)_
5. **"Station's engine, by model": canonical model rows (GLM, Claude Opus, Claude Sonnet, Qwen Coder).** Each row shows provider and account, and the raw id in mono where it differs. The canonical grouping is new: a model catalogue applied when the data is read. _(server work; not in the first release)_
6. **"Outside engines, by engine and provider": Claude Code, Claude Code through CLIProxy (Proxy), and Codex.** Outside engines do not report the model on each turn, so there is no model column. Proxied usage stays visible under its engine with the Proxy tag. The account part needs a backend check: is the credential profile on the receipt? _(layout, backend check first; slice 5.22)_
7. **Cost appears only where a price exists. A dash always comes with a plain reason.** Reasons are: subscription, the proxy reports no price, no price on file, runs locally, unknown model. _(copy; slice 5.22)_
8. **An "Unrecognised" row shows the raw id as reported (router/fast-tier).** Station records the name a provider reports and never guesses which model it is. _(server work; not in the first release)_
9. **Footnote: there is no per-agent cut, and a link to Privacy and data › Usage sharing.** Receipts carry no agent id. _(copy; slice 5.22)_

### `settings-15` Chat: change a setting

On a phone: As the previous screen.

1. **An appearance proposal card shows the change as before and after, with Apply, Preview and Discard.** This card exists today. The step line reads "Drafted a new look". _(layout; not in the first release)_
2. **"Opened Settings › Feature previews", with Private memory highlighted.** The agent cannot toggle previews. _(layout; not in the first release)_
3. **Not specified: a tool for proposing a feature preview change.** It would let the agent show a one-tap approval card here instead of navigating. _(chat tool; not in the first release)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Plugin recovery inventory | Hide for the first release | Behind Developer previews. It is an operator tool. |
| Plugin visibility (per person) | Keep | Kept in Privacy and data, renamed "App visibility per person". A real sharing control. |
| Settings › Appearance stub | Remove | It duplicates the /appearance page. |
| /appearance page | Keep | Moved into Settings. One home. |
| Profile page | Remove | Split into Account and Usage. Four jobs on one page. |
| Milestones | Hide for the first release | Empty for most users and not core. |
| Settings General page | Simplify | Split by owner. Four owners on one page. |
| Advanced page | Remove | Its sections are redistributed. Nine unrelated sections. |
| "Host options" and "Device hosts" names | Simplify | Renamed, because the glossary rejects "host". |
| Usage sharing explicit Save | Simplify | Saves instantly. One save behaviour. |
| Developer destination | Simplify | Becomes a Settings group behind Developer mode. It duplicated Advanced. |
| Two preview systems (server and device) | Simplify | Become Feature previews and Developer previews. Same word, two scopes. |
| Continue after restart (merged with Continue unattended work) | Turn on by default | On by default, with no toggle. |
| Chat images from the host | Turn on by default | Already on. Becomes an ordinary feature. |
| Crash-durable Station Agent | Turn on by default | On by default, with no toggle. |
| Guided engine setup | Turn on by default | Needed for setup from chat. |
| Open and settled inbox | Turn on by default | On by default, with no toggle. |
| Attention snooze | Turn on by default | On by default, with no toggle. |
| Task review | Hide for the first release | Owned by Projects. Stays off and is not listed for users: it depends on a second preview, and its code-review panel has no tests. |
| Save to Project | Turn on by default | Owned by Projects. This design's view is graduate. |
| Project Overview | Turn on by default | Owned by Projects. Both designs agree. |
| Project Library | Turn on by default | Owned by Projects. Both designs agree. |
| Pause and archive Projects | Turn on by default | Only Archive graduates. Pause stays hidden. |
| Project brief, memory and models | Turn on by default | Only the Brief graduates, as "Instructions for agents" under Project settings › General. Memory stays hidden, and "Models and effort" is removed as a section. |
| Project schedules (inside Automations) | Hide for the first release | Owned by Projects. Stays off and is not listed for users: rows cannot be edited or deleted after creation. |
| Coordinator chat | Keep | Stays visible. Sub-options: working picture, project supervision, and Coordinator in #general (owned by Projects). |
| Private memory | Keep | Stays visible, with its cost stated. |
| Pull request agent feedback | Keep | Stays visible. Sub-option: Pull request head review. |
| Cloud coding agents (Remote task engines) | Keep | Stays visible, with its cost stated. |
| GitHub Copilot engine | Keep | Stays visible. |
| OpenCode native engine | Keep | Stays visible. |
| Browser extras | Keep | Stays visible. One switch sets three ids (merged with Browser experience and Browser artifacts). |
| Local speech | Keep | Stays visible. |
| Walkthroughs | Keep | Stays visible. |
| Appearance studio | Keep | Stays visible. |
| Task capabilities | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Task collaboration | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Chat apps | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Visual skills | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Content trust settings | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Reviewed tariff sources | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Fleet consumer probes | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Member passkeys | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Station orchestration instructions | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Codex browser and device tools | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Codex tool families | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Learning lifecycle review | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Paired Station chats | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Workload budget settings | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Plugin recovery inventory | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Repository sign-in details | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Device developer loop | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Session goals | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Context compaction | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Stage chat Agent changes | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Session reads from the station CLI | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Stale checkout warning | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Task tracker follow-ups | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| GitHub automation observations | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| GitHub automation Tasks | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Isolated GitHub repairs | Hide for the first release | Developer-only. Moves to Developer previews, shown only with Developer mode. |
| Apps library (preview) | Remove | Removed. Apps › Library replaces it. |
| Project sharing setting (preview row) | Remove | Deleted. It is a preview row that only points to another setting. |
| Continue unattended work after restart | Remove | Merged into Continue after restart. |
| Browser experience | Remove | Merged into Browser extras. |
| Browser artifacts | Remove | Merged into Browser extras. |
| 3 preview ids not visible on a fresh install | Hide for the first release | 58 of 61 previews were visible on a fresh install. The 3 unseen ids need a backend check and are likely UI-only flags. |
| Usage by model | Keep | New for Station's own engine. Outside engines are grouped by engine and provider. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Settings regroup, rows moved, Advanced removed | layout | Also copy, plus a UI index of moved rows for search. |
| One save behaviour | new screen state | Row-level error and Saved tick. |
| Posture summary | layout | A UI aggregate of existing values. |
| Notifications device dedupe, names, last seen and quiet-hours range | backend check first |  |
| Account "Edit name" | backend check first |  |
| Previews sort and graduation | server work | Server defaults plus registry metadata (a "developer" flag). The Browser extras merge is UI only. |
| Developer as a Settings group | layout | Also routing. |
| Usage page: By provider, project and day | layout | UI over the existing usage rollup. |
| Usage By model (Station's engine only) | server work | A model catalogue mapping provider type and raw id to a canonical model, applied at read time. |
| Provider and account split in usage | backend check first | Is the credential profile on the receipt? |
| Chat: propose a feature preview change | chat tool | New tool. |

## Decisions taken during design

- No header theme toggle is added.
- "Advanced" is dropped as a Settings page, because it had become the dumping ground.
- Developer mode stays per account, as the product labels it today.
- The Plugins screens were removed. Apps replaces them.
- Where two design passes disagreed on a feature preview, the one that read the feature's code won: Task review, Memory, Pause and project Schedules stay hidden; Brief and Archive are turned on.
- Usage by model is shown only for Station's own engine. Usage on outside engines is grouped by engine and provider.
