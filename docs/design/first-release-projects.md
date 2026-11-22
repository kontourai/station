# First-release design: Projects

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

A project becomes one page with Overview, Chats, Tasks and Files tabs, creating one no longer starts with picking a layout, and apps can be added as project views.

## What is wrong today

- Making a project means learning "layout" first. The dialog asks for a Starter layout and offers "Browse all" before any project exists, and a Browse-all choice is not shown in the form. Create and apply-layout are two separate requests, which is why "Retry layout" and "Continue creation" exist.
- A bad Git URL breaks the dialog. The form is replaced by "Operation: <uuid> / Check operation / Try again in a moment", and Retry, Cancel and "Choose another source" are hidden in a ⋯ menu. Nothing validates the URL, and the Create button renders empty while pending.
- "Provider" means the Git host in this dialog, which collides with the new vocabulary. The GitHub picker also shows raw ISO timestamps and a login.
- One project has two homes. The project page has Overview, Room, Tasks, Files and connections, and Settings. The layouts (Coding, Tasks) replace that page entirely. New chat lives only in Coding, and it asks about the wrong project.
- The sidebar row has no menu, only a hover drag handle, and keyboard reorder did nothing. The Room contradicts itself: the sidebar shows #general while the Overview says "The room has not been opened yet".
- Project settings has 14 rail items (20 with previews), with near-duplicates and dead ends. Model, Models and effort, New chats and Agents all set what a new chat uses. Workspace, Chat workspace and Sources overlap. Schedules is blank because its rail item is never filtered. Pull requests tells a git project to add a repository when the repo has no remote. Save models are mixed.
- The same family of things is called Layout, Workspace view, Starter layout, Board, Apps and Pane. Review renders in a column about 140px wide. Session Board is offered but returns "Layout not found". The Flow console has no inbound link.
- Task status contradicts itself: one chat shows as "Delivery unconfirmed" under Needs you and "Done" under Just finished. Share is disabled with no visible reason. Boards are called "Apps", "+" creates an inline "Untitled Board" before you choose anything, and a template opens a full editor before any dashboard.

## Agreed structure

- The sidebar lists Projects (icon, name, attention count, and a menu on hover or right-click). Apps sit below Projects, and project rows never expand into them. Only the project you are in expands, and it shows its views.
- A project is one page with a bar of tabs: Overview, Chats, Tasks, Files, a plus, and Settings.
- Overview has a composer scoped to the project (Chat or Task), Waiting on you, In progress, and Recent chats. The aside shows the folder, "New chats start on", and Views.
- Chats is today's Coding layout, with the inbox, chat, panes, and a pane rail with "+ Add a pane".
- Tasks is one view that merges today's Tasks section and Tasks layout. Lanes are task status.
- Files holds the folder and repositories, documents and knowledge, and the Library when it graduates.
- Settings has General, Workspace, Chat defaults, Tools and Views, plus Pull requests only with a git remote and People only when the project is shared.
- A task page has one status button, the engine, branch, an attention line, Share with its reason, and tabs for Overview, Chat, Plan and Details.
- A View is a named arrangement inside a project: Chats, Tasks, and any of your apps added as a view. It replaces Layout, Workspace view and Starter layout. A Pane is one piece inside a view. A Board is only the Board and List presentation of the Tasks view.
- In New Project the Git host is "Clone from GitHub, GitLab or URL", never "provider".

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| New project, blank | 3 clicks, 1 decision (+, name, Create) | Same: 3 clicks, 1 decision |
| New project, existing folder | About 6 clicks, about 5 decisions (+, From a repository, Use an existing folder, path, starter, Create) | 4 clicks, 2 decisions (+, A folder, pick suggestion, Create). The name comes from the folder. |
| New project, Git URL | About 9 clicks, 8 to 10 decisions | 5 clicks, 3 decisions (+, Clone from Git, URL, paste, Create). The name comes from the repo. |
| Start a chat in a project | 3 (row, Coding chip, New chat), and it asks about the wrong project | 1 (row, type, Start) |
| See what a project needs from you | Home list, or Project then Tasks section | The sidebar Tasks count (1), or Overview "Waiting on you" |
| Change a project's default model | Row, Settings, Model (plus Models and effort, plus New chats), Save | Row menu, Project settings, Chat defaults, Save. One page, not three. |

## Screens

### `projects-01` New project

On a phone: A bottom sheet. The three source choices stack until one is picked, then compact to icon tiles. Targets are 44px.

1. **One name field with the icon badge beside it. The separate icon sub-form is gone.** Today an optional emoji opens a whole panel. _(layout; slice 3.1)_
2. **"Where does the work live?" offers three equal choices: Start empty, A folder, Clone from Git.** Today's Blank vs "From a repository" then split again into Git vs folder. The folder case is the common one and sat two levels deep. _(layout; slice 3.1)_
3. **No Starter layout and no Browse all. Every project opens with Chats and Tasks.** Users met "layout" before they had a project. Backend check: built-in views can exist without a per-project apply. _(layout, backend check first; slice 3.1)_
4. **"More options" holds the description and Runs on.** It already holds them. "Default environment" is renamed to the Home page's "Runs on". _(copy; slice 3.1)_
5. **Create is always labelled "Create project". The foot hint says what opens.** Today the button renders empty while pending. _(copy; slice 3.1)_

### `projects-02` New project from a folder

On a phone: The source tiles collapse to three icon buttons. Autocomplete is narrowed to the field.

1. **The folder field is the only new input. Autocomplete is kept, with a "Git" tag instead of MATCH or FOLDER.** Autocomplete works well today. _(layout; slice 3.1)_
2. **"Browse…" keeps the folder browser.** The folder browser works well today. _(layout; slice 3.1)_
3. **A detection line reads "Git repository · branch main · 3 uncommitted changes".** It replaces the git-aware "Recommended starter" with a fact the user cares about. The change count is a new git status count from the server and needs a backend check. _(server work, backend check first; slice 3.1)_
4. **The name is filled from the folder ("Taken from the folder name until you edit it").** Today's hint "Follows the working directory" shows even on the Blank path, where it means nothing. _(copy; slice 3.1)_
5. **The foot says "Station works in this folder. Nothing is moved or copied."** It answers the first worry about pointing an app at your code. _(copy; slice 3.1)_

### `projects-03` New project, clone failed

On a phone: The same sheet, with the error block below the URL. It is the longest sheet.

1. **"Clone from: GitHub · GitLab · URL" chips.** Replaces "Choose a repository source" and "Provider". It frees "provider" for model providers. _(copy; slice 3.1)_
2. **A malformed URL is caught before any request ("That doesn't look like a Git URL"; no screen is specified).** Nothing checks the URL today. This is UI only. _(new screen state; slice 3.1)_
3. **A failure stays on the form, attached to the URL, with a plain reason, "Use a folder instead" and "Details".** The operation id lives under Details. Today the form is replaced by "Operation: <uuid>" and polls a 404, and Retry is hidden in a menu. Mapping the 400 error to a plain reason needs a backend check. _(new screen state, backend check first; slice 3.1)_
4. **The footer says "Nothing was created" and the primary button is "Try again".** Today you cannot tell whether a project exists. _(copy; slice 3.1)_

### `projects-04` New project, creating

On a phone: No separate phone layout is specified. It is the same sheet as New project.

1. **The header names the project and the source.** _(copy; slice 3.2)_
2. **Four steps: Check the repository, Clone (spinner and elapsed time), Create the project, Set up Chats and Tasks.** This turns two hidden requests into visible progress. Today the button renders empty. _(new screen state; slice 3.2)_
3. **"Cancel clone" uses the existing cancel action. There is no Close button while setup runs.** Today a bad Git URL replaces the form with an operation id and polls forever, with no way out. _(layout; slice 3.2)_
4. **The hint says "Keep this window open until setup finishes. If it closes early, New project offers to finish the setup next time."** Creation is driven by the browser today, and the saved recovery reopens the dialog. _(copy; slice 3.2)_
5. **Not specified for the first release: "Close this window, Station keeps going."** It needs the server to run the whole sequence (acquire, create, views) as one tracked operation, with the project appearing in the sidebar when done. _(server work, new screen state; slice 3.2)_

### `projects-05` New project, recovery

1. **The same step list, with what succeeded ticked and the one unfinished step explained.** Keeps the recovery panel, which works, but replaces "Saved setup… Starter: Tasks / Check setup / Retry layout" with plain steps. _(copy, layout; slice 3.2)_
2. **Primary "Finish setup", plus "Open project anyway". "Set this aside" stays as a link.** The same actions as today, named for what they do. _(copy; slice 3.2)_
3. **If built-in views need no per-project apply, this screen is reached only by an interrupted clone.** This depends on the backend check on the New project screen. _(backend check first; slice 3.2)_

### `projects-06` Brand new project

On a phone: The project bar drops the duplicate name and becomes a scrolling tab strip with Settings as a tab. The aside cards stack under the main column.

1. **A project bar: identity and branch, then view tabs Overview, Chats, Tasks, Files, a plus, and Settings.** One home instead of the project page versus layouts. The toolbar's "Acme Web / Coding ▾" switcher becomes visible tabs. _(layout; slice 3.3)_
2. **The composer is scoped to the project and focused ("What should we do in Docs Site?"), with a Chat or Task switch.** Fixes today's composer asking about another project. Task routes to the existing task-shaping flow. UI only. _(new screen state; slice 3.4)_
3. **"Docs Site is ready": three real next steps. The list goes away after the first chat or task.** Replaces "Add repository" (already added), the unopened Room and the "Open workspace" disclosure. _(layout; slice 3.4)_
4. **The Folder card shows where, the branch, changes, and how chats use the folder.** _(layout; slice 3.4)_
5. **The "New chats start on" card shows engine and model, provider and account, and approvals, with Change.** It makes the default visible, which Home lacks. The default drifts today. _(layout; slice 3.4)_
6. **A "Project created" toast.** It replaces a silent landing. UI only. Not shown on phone, where it would cover the cards. _(new screen state; slice 3.4)_
7. **In the sidebar, the new project is expanded to its views. #general is gone.** The Room is hidden for v1 unless the project is shared. _(layout; slice 3.3)_

### `projects-07` Project overview

On a phone: Single column: the composer first, then the lists, then the aside cards. Dark theme holds with no hard-coded colours except brand tile tints.

1. **"Waiting on you": one approval row with Review.** This graduates the project-overview preview's waiting-on-you grouping. _(layout; slice 3.4)_
2. **"In progress" shows tasks and chats, and each row shows one status.** Fixes the mixed "Delivery unconfirmed" and "Done" rows. _(layout; slice 3.4)_
3. **Recent chats show a "Why it failed" link.** Consistent with the new Home. _(layout; slice 3.4)_
4. **"Changes: 2 files changed".** Uses the same new git status count as the folder screen. Needs a backend check. _(server work, backend check first; slice 3.4)_
5. **The Views card links to Add view.** It replaces "Open workspace", then "+ Add layout" or "+ Add pane". _(layout; slice 3.4)_
6. **The sidebar Tasks row carries the attention count.** Today it is a badge on the project row only. _(layout; slice 3.4)_

### `projects-08` Sidebar row menu

On a phone: The drawer is open and the menu is a bottom sheet with 48px rows. Long-press opens it.

1. **A hovered row shows a ⋯ button, and right-click opens the same menu.** Every action already exists elsewhere. UI only. _(new screen state; slice 3.5)_
2. **The menu has New chat in project, New task, Rename, Change icon, Project settings, Copy folder path, Move up and down, Archive, and Delete.** Today there is no menu at all, and the reorder handle did nothing by keyboard. _(new screen state; slice 3.5)_
3. **The open project expands to Overview, Chats 4 and Tasks 1. Layout chips and #channels are gone.** Rows carry views, not channels. _(layout; slice 3.3)_
4. **Docs Site is collapsed: name only, with the expand chevron on hover.** When no project is open, every row is collapsed. Only the project you are in expands. _(layout; slice 3.3)_

### `projects-09` Chats view, adding a pane

On a phone: Chat is full width. Panes become a chip strip (Chat, Files, Changes, Terminal, +), each opening full screen. The chooser is a bottom sheet (Browser, File preview).

1. **"Chats" is a tab of the project.** It is the old Coding layout, renamed for what it holds. _(copy; slice 3.3)_
2. **The pane rail keeps Files, Changes and Terminal. The plus opens the chooser.** The chooser works well today. _(layout; slice 3.6)_
3. **The Add a pane chooser is a compact list with state on the right (Showing, In rail, Add).** Replaces a two-column grid of colour blocks where every item said "Available". _(layout; slice 3.6)_
4. **The phone and emulator pane is hidden for v1. Basis and Plugin preview are dropped from the default list.** The phone pane needs a preview turned on and a connected device host, which most first users lack. "Devices with access" on the Station page means something that signs in to Station, so a link there would mislead. Basis is internal, and Plugin preview applies only in a project that is itself a plugin being developed. _(unclassified; slice 3.6)_
5. **"Diff" is renamed "Changes".** A plain word for the same thing. _(copy; slice 3.6)_

### `projects-10` Tasks view

On a phone: A segmented lane picker with counts, one lane at a time (swipe). The card flags are unchanged.

1. **The lanes are task status: To do, In progress, In review, Done. Blocked, Canceled and Backlog sit on a shelf.** These are the real statuses. Today's lanes (Needs you, Running, In review, Ready to merge, Idle) mix agent activity with task status, which is how one item ended up in two places. _(layout; slice 3.7)_
2. **"Waiting on you" is a flag on a card, not a lane.** It comes from session attention, so a card is in one lane only. _(layout; slice 3.7)_
3. **"Last reply may not have arrived · Check" is the old "Delivery unconfirmed" as a quiet flag.** It no longer competes with status. _(layout; slice 3.7)_
4. **The PR chip ("PR #12 · Checks passed") is kept from the overview preview.** _(layout; slice 3.7)_
5. **The Board and List switch is kept, and a "Needs you" filter chip is added. Refresh Tasks is removed.** The data is live. _(layout; slice 3.7)_
6. **One Tasks view replaces the Tasks section and the Tasks layout.** Today the same thing exists twice. _(layout; slice 3.7)_

### `projects-11` Add view menu

On a phone: The view tabs scroll. "+" is hidden on phone, and adding views is a desktop task (no phone layout is specified).

1. **"+" on the view tabs opens "Views in Acme Web": Chats, Tasks, then "Add one of your apps" and "Find apps with a project view".** Release desk shows this project only, Knowledge Docs and Enterprise are offered, and Daily brief is greyed ("Not for projects"). It is the same menu as in Apps. Reordering and hiding views moved to Settings › Views. Today Add Layout offers Session Board, which fails with "Layout not found", and offers Coding and Tasks as if optional. Review and Session Board are not offered. _(new screen state; slice 3.9)_

### `projects-12` Task page

On a phone: The status button goes full width (44px), with Share and ⋯ beside it. Tabs scroll. The approval card stays first.

1. **One status button ("● In progress ▾") offers only allowed transitions. The line under the title adds the agent state ("Waiting on you") separately.** Task status and agent state never contradict each other. _(layout; slice 3.8)_
2. **A disabled Share always explains itself, with a fix link.** The text reads "Sharing needs people added to this Station first. Station › People". Today the only text is a generic tooltip, "Task sharing is unavailable here". Specific reasons are new copy and need the server's refusal causes mapped. _(copy, backend check first; slice 3.8)_
3. **The pending approval comes first, with Allow once, Always allow here and Deny.** The thing waiting on you is the first thing you should see on the task. _(layout; slice 3.8)_
4. **Goal and Done when come from the Plan. The editable checklist is kept, and "Edit plan" goes to Plan.** _(layout; slice 3.8)_
5. **Activity replaces the empty slots "Blockers: None recorded" and "Ready to review: Nothing kept yet".** Today the task page gives its space to slots that are usually empty. _(layout; slice 3.8)_
6. **Tabs are Overview, Chat, Plan and Details. "Work chats" folds into a "Linked chats" card. "Conversation" is renamed "Chat".** Chat is the glossary word. Today's Work chats tab is an empty select. _(layout, copy; slice 3.8)_

### `projects-13` Project settings: Chat defaults

On a phone: Navigation pushes: a list of sections, then a detail page with "‹ Settings". Discard and Save are sticky.

1. **The rail has 5 sections always and 2 conditional (Pull requests when a git remote exists, People when the project is shared).** Down from 14 items, or 20 with previews. _(layout; slice 3.10)_
2. **Agent sets the project's default agent and says which engine runs it.** Today Model, Models and effort, New chats and Agents are separate sections that all set what a new chat uses. _(layout; slice 3.11)_
3. **Provider and account are read-only for outside engines, with a link to Customize › Engines › Codex.** The account in use is per engine, for the whole Station. Only Station's own engine has a per-project provider, which the notice at the bottom explains. _(copy; slice 3.11)_
4. **Model sets the default model. "Use the last model I picked instead" sets the default to follow your last pick.** _(layout; slice 3.11)_
5. **Approvals sets the default approval mode.** _(layout; slice 3.11)_
6. **"Agents offered" is the allowlist, collapsed to one row.** Today it is a 12-row checklist. _(layout; slice 3.11)_
7. **UNSAVED with Discard and Save: one save model for every section.** Today Pull requests auto-saves while the others do not. _(layout; slice 3.11)_
8. **Effort is not shown.** Only preview-gated coordinator and task effort settings exist. _(unclassified; slice 3.11)_

### `projects-14` Project settings: Workspace

1. **Folder: path, Browse, and a git line (branch, remote).** _(layout; slice 3.10)_
2. **"Runs on" is the old "Default environment".** The same thing is called a computer elsewhere in Station. This setting chooses which computer runs the work. _(copy; slice 3.10)_
3. **"How chats use the folder" has three plain options: Station default, the folder directly, or a Git worktree per chat.** The Station default option names what that is today. It replaces "Execution environment: Use the Station default (currently: the current checkout)". _(copy; slice 3.10)_
4. **Sources, Repositories and Knowledge leave Settings for the Files tab.** Today the same panel appears twice. _(layout; slice 3.12)_

### `projects-15` Project settings: General

1. **Name and icon, and a Description ("Agents see this when they start work here").** _(layout; slice 3.10)_
2. **Archive and Delete, with the existing Removes and Keeps preview shown inline.** Today's delete preview is honest, so it is kept and shown before the click. _(layout; slice 3.10)_

### `projects-16` Project settings: Views

On a phone: Remove leaves the row, reached by tapping the row. The grip and toggle stay at 44px.

1. **The list is the project's tabs in tab order, and says hidden views stay installed.** Today it is a bare "Coding · coding ×" list with "Add Layout". _(layout; slice 3.9)_
2. **Overview and Files are built-in pages: "Always shown", with no grip and no toggle.** _(layout; slice 3.9)_
3. **Built-in views (Chats, Tasks) have a drag grip and a Shown or Hidden toggle.** The per-project hidden flag needs a backend check. _(layout, backend check first; slice 3.9)_
4. **App views say where they come from ("From your app Knowledge Docs · this project only"), with a toggle and Remove.** Remove takes the view out of this project only. The app stays in the sidebar. The per-project hidden flag needs a backend check. _(new screen state, backend check first; slice 3.9)_
5. **"Add one of your apps" opens the same list as the "+" on the project tabs.** _(layout; slice 3.9)_

### `projects-18` Project settings on a phone

On a phone: This screen is phone only.

1. **Project settings on phone is a list: each row is the section with its current value ("Codex · GPT · ask before commands").** Today's phone view is a select-based section picker. Rows that show the current value save a tap. _(layout; slice 3.10)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Project Library | Turn on by default | Moves into the Files tab. It has real server code, an upload service and an agent tool, and its empty state has a way out. It needs more tests first. |
| Project overview tasks and waiting-on-you dot | Turn on by default | Merged. Its next-step grouping and PR chips power the new Overview and the sidebar Tasks count. Its "Overview and notifications" settings stay hidden. |
| Setup recommendations card | Remove | It writes "Brief" into the description, which collides with the real Brief. Dismissal is per browser. |
| Task Review tab | Hide for the first release | It depends on capture sessions and a second preview, and the code-review panel has no tests. Revisit as the detail of the In review lane. |
| Project Brief | Turn on by default | Becomes "Instructions for agents" under General. It is injected into new sessions, but the server also checks the preview, so it needs a server change. |
| Project Memory | Hide for the first release | It overlaps Project knowledge and private memory. It needs the knowledge story first. |
| Models and effort section | Remove | It has a hard-coded engine list and a free-text model box. Effort folds into Chat defaults once it is a real per-model setting. |
| Project Usage | Hide for the first release | Token rollups are real, but cost is unpriced except for Bedrock. Usage belongs in Customize › Providers first. |
| Project coordinator | Hide for the first release | A large subsystem with almost no tests. It lives in #general, which v1 hides. |
| Pause and Archive | Turn on by default | Graduate Archive only and keep Pause hidden. Archive solves sidebar clutter. Fix the held banner and Archived toggle, which show even with the preview off. Built (0.13): both now follow the preview, and with it off the sidebar lists archived projects normally rather than hiding them behind a toggle that is not shown. |
| Project Schedules | Hide for the first release | Rows cannot be edited or deleted after creation. Fix the rail item that shows with the preview off, which causes the blank page. Built (0.13): the Schedules item is in the rail only while the preview is on. Project-scoped automation belongs in Automations with a project filter. |
| Apps library | Remove | Superseded by the Apps destination (Discover, Library and Updates). Apps appear in projects through "+ Add view". |
| Starter layout and Browse all in New Project | Remove | Chats and Tasks are always there. Apps are added later as views from the plus. |
| Recovery panel | Keep | Simplified to a step list. It is honest and survives reload. |
| Folder autocomplete and folder browser | Keep | They work. |
| GitHub and GitLab repo pickers | Simplify | No ISO timestamps or login. Host chips instead of "provider". |
| Room and channels | Hide for the first release | Hidden for v1 unless the project is shared. It contradicts itself, duplicates chat for one person, and "Invite people" points at Feature previews. |
| Invite people button | Hide for the first release | Hidden with the Room. |
| Coding layout | Keep | Kept as the Chats view. It is where work happens. |
| Tasks section and Tasks layout | Simplify | Merged into one Tasks view. |
| Review layout | Remove | Removed from v1. It renders in a 140px column. Task review status lives in the In review lane. |
| Session Board | Hide for the first release | Only with a Builder run, as now. Drop it from the Add view catalogue. Built (0.13): the Add Layout pickers list it only for a project with a Builder run, the same fact that gates its sidebar entry; the catalogue itself is unchanged. The feature stays, because #3054 builds live Session progress on it. |
| Flow console | Remove | The route has no inbound link and no tests. |
| Panes: Basis, Plugin preview, Trust and Readiness | Hide for the first release | Hidden from the default chooser. They are internal or context-only. |
| Phone and emulator pane | Hide for the first release | It needs a connected device host most first users lack. It also collides with Station › Devices with access. |
| Files and connections, Sources | Keep | Kept as the Files tab and removed from Settings. They were the same panel twice. |
| Project knowledge "Index directory" | Keep | Kept in Files. Fix the count mismatch ("Indexed 4" with a header showing 0). |
| Project search | Keep | Scoped to the project. Today it returned other projects. |
| Pull requests section | Simplify | Shown only with a git remote. With no remote it says "No remote: push this repo to GitHub or GitLab to use pull requests". |
| People and access | Keep | For the operator, shown only when sharing is set up. |
| Task Work chats tab | Simplify | Merged into the Overview "Linked chats" card. Today it is an empty select. |
| "Plugin preview" pane name | Keep | It appears only in a project that is itself a plugin being developed. "Plugin" stays the packaging and developer word. |
| Boards (create flow, templates, Daily brief) | Remove | Superseded. Boards are now a built-in kind of app made with chat, and Daily brief is a built-in app. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| New Project three-way source, name from folder or repo | new screen state | Also layout. |
| No starter layout; Chats and Tasks always present | backend check first | New server data, or a default apply on create. Confirm built-in views can exist without a per-project apply. |
| One Create that sequences clone, create, views with a step list | new screen state | Specified as true today: the window must stay open. |
| "Close the window, Station keeps going" | server work | The server runs acquire, create and views as one operation. No screen is specified. Also a new UI state. |
| Git URL pre-check and plain failure reason | backend check first | New UI state plus mapping the server error. Confirm what the 400 body carries. |
| "Start empty": where the empty workspace lives | backend check first | Confirm whether a project can have no folder. The change is copy. |
| Uncommitted change count | server work | New git status count. Needs a backend check. |
| Project bar with view tabs | layout | Medium risk: the layout renderer becomes a child of the project page. |
| Project-scoped composer with Chat or Task | new screen state | Uses the existing create-task and task-shaping flows. |
| Sidebar row menu; children are views | new screen state | UI only. Reorder must work by keyboard. |
| Settings: 5 plus 2 sections, one save model | layout | Also copy. Merges Model, New chats and Agents into Chat defaults. |
| Provider and account read-only for outside engines | copy | Correct today. A per-project account would be new server data and is not proposed. |
| Task lanes by status, attention as a flag | layout | The derivations exist. |
| Share disabled reason | backend check first | Copy plus mapping the refusal cause. Confirm the specific causes. |
| Pane chooser list | layout |  |
| Graduations: Library, Overview, Brief, Archive | layout | Flag flips plus tests. Brief needs its server gate lifted. Library needs tests. |
| Schedules rail leak fix | copy | A tiny logic fix. |
| Chat: "make a project for ~/code/x" | chat tool | New tool that proposes creating a project. Projects are read-only to agents today. The person confirms in the dialog. |
| Chat: "make Codex the default here" | chat tool | New tool that proposes a project update. No project update tool exists. |
| Add view menu (your apps) | layout | A regroup. Project layouts and plugin layouts in projects exist today. |
| Project settings › Views | new screen state | Also layout. The per-project hidden flag needs a backend check. |

## Decisions taken during design

- A per-project provider + account is real only for Station's own engine. For Claude Code and Codex it is shown read-only with a link to Customize › Engines.
- Considered: moving Starter layout into More options. Chosen: removing it, because people met "layout" before they had a project.
- The Review layout is removed for v1 because it renders broken.
- "You can close this window, Station keeps going" was removed from the creating screen because creation is driven by the browser today. Keeping it going after the window closes is listed as new work.
- The phone and emulator pane is hidden for v1. "Device" now means something that signs in to Station, and the pane needs hardware most first users will not have.
- The Boards screens were removed. Today's boards are one built-in kind of app, made with chat.
- Project settings › Views has its own screen in this record.
