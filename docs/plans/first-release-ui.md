# First-release UI: execution plan

Status: implementation plan for [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

This plan delivers [the first-release design](../design/first-release.md) as 89 slices in six phases. Each slice is one issue and one pull request. Every numbered change in the design belongs to exactly one slice, or is listed under [Not in the first release](#not-in-the-first-release).

## Rules

- A slice cites the screens and change numbers it delivers. Its pull request shows a running build beside the agreed render for each screen, at 1440px and 390px.
- A change marked "backend check first" is settled before the slice builds. If the answer changes the design, the design record is amended in the same pull request with the reason.
- A slice that changes a recorded decision, a glossary term or another design record amends that record in the same pull request.
- A slice lands only after the slices it depends on. Sizes: S is a sitting, M a day or two, L is large and kept whole for a stated reason.
- Each area lands complete, with no feature preview, except the sidebar change: it sits behind one preview until Phase 1 is whole.

## Phase 0 · Defects that need no redesign

Fix the audit defects whose fix does not depend on a new screen.

Done when: Usage counts, pairing by code, New Project failures, the inbox duplicate, failure text and one-time automations behave correctly on today's screens.

| Slice | Issue | Outcome | Delivers | Size | After |
| --- | --- | --- | --- | --- | --- |
| 0.1 | #5387 | Refuse an OpenAI-compatible connection with no address | defects only | S |  |
| 0.2 | #5388 | Open "Pair with a code" on the code field when there is no camera | defects only | S |  |
| 0.3 | #5389 | Count usage per engine after an engine change | defects only | M |  |
| 0.4 | #5390 | Show "Not reported" instead of 0, and clear the context figure after an engine change | defects only | S |  |
| 0.5 | #5391 | Fix three chat turn defects: cut-off replies, error actions after a reload, and /new and /clear | defects only | M |  |
| 0.8 | #5392 | Stop the Home composer reusing the last project silently | defects only | S |  |
| 0.9 | #5393 | Keep New Project on its form when a clone fails, and label Create while pending | defects only | S |  |
| 0.10 | #5394 | Scope project search to its project, and make the knowledge index counts agree | defects only | M |  |
| 0.12 | #5395 | Keep the tool server editor usable with Secret bindings open | defects only | S |  |
| 0.13 | #5396 | Hide preview-only project rail items, and drop Session Board from the view catalogue | defects only | S |  |
| 0.14 | #5397 | Stop a maximised chat dock following you, and give cmd+z one owner | defects only | M |  |
| 0.16 | #5398 | Show each chat once in the inbox, with "Last reply may not have arrived" as a flag | `automations-inbox-11` 9 | M |  |
| 0.17 | #5399 | Translate the failed-turn notification into plain words | `automations-inbox-11` 8 | S |  |
| 0.18 | #5400 | Fix one-time automation defaults and give automations a display name | `automations-inbox-04` 8 | M |  |

## Phase 1 · Quiet sidebar, Customize page, first run and a stored default

Give Station its new way of getting around and a first run on Home.

Done when: A new user lands on Home with what Station found, a stable default for new chats, the quiet sidebar with Customize and Apps › Discover, and no wizard or tour.

| Slice | Issue | Outcome | Delivers | Size | After |
| --- | --- | --- | --- | --- | --- |
| 1.1 | #5401 | Store a default for new chats | `first-run-01` 2, 3; `first-run-02` 1 | M |  |
| 1.2 | #5402 | Make Customize a page and retire Connections as a destination | `navigation-08` 1, 6 | M |  |
| 1.3 | #5403 | Add the Customize landing with what needs you | `navigation-08` 2, 3, 4; `customize-20` 1, 2, 3, 4 | M | 1.1, 1.2 |
| 1.4 | #5404 | Turn Plugins and Registry into Apps › Discover | `apps-03` 1, 2, 3, 4, 5, 6 | M |  |
| 1.5 | #5405 | Build the quiet sidebar behind one preview | `navigation-06` 1, 2, 3; `navigation-07` 1, 2; `navigation-10` 1; `navigation-11` 1; `apps-01` 1; `apps-02` 1, 4 | M | 1.2, 1.4 |
| 1.6 | #5406 | Let any Customize item be pinned to the sidebar | `navigation-08` 5; `navigation-09` 1, 2, 3 | M | 1.3, 1.5 |
| 1.7 | #5407 | Replace the setup wizard and tour with what Station found | `first-run-01` 1, 4, 5; `first-run-02` 2, 3; `apps-01` 2 | M | 1.1 |
| 1.8 | #5408 | Show one card under the Home composer: usage sharing, then the apps tip | `first-run-01` 6; `apps-01` 3 | S | 1.7, 1.4 |
| 1.9 | #5409 | Keep the message while signing in: "Sign in and start" | `first-run-03` 1, 2, 3; `first-run-04` 1, 2, 3 | M | 1.7 |
| 1.10 | #5410 | Handle nothing installed and a failed install in plain words | `first-run-05` 1, 2, 3; `first-run-06` 1, 2, 3 | M | 1.7 |
| 1.11 | #5411 | Import Codex prompts as skills, with undo | `first-run-08` 1, 2, 3, 4 | M |  |
| 1.12 | #5412 | Turn the quiet sidebar on and delete the old one | defects only | S | 1.3, 1.5, 1.6, 1.7, 1.8 |

## Phase 2 · Station page, Engines, Providers and Knowledge

Replace Connections and the Stations manager with honest Customize items and one Station page.

Done when: A person can see what can run, add a provider that is checked before it is saved, and manage devices and Stations from one page.

| Slice | Issue | Outcome | Delivers | Size | After |
| --- | --- | --- | --- | --- | --- |
| 2.1 | #5413 | Open a Station page with its two scopes and a name everyone sees | `station-16` 3, 4, 5, 6; `station-20` 1, 2, 3, 4; `station-16` 1 | M | 1.12 |
| 2.2 | #5414 | List devices with access in a table with an inline access editor | `station-16` 2; `station-17` 1; `station-17b` 1, 2; `station-18` 1 | M | 2.1 |
| 2.3 | #5415 | Simplify the Station chip and its menu | `station-13` 1; `station-14` 1, 2, 3, 4, 5; `station-15` 1; `station-19` 1; `station-21` 1 | M | 2.1 |
| 2.5 | #5416 | Let a Station choose which addresses may request access | `station-17` 2, 3 | M | 2.2 |
| 2.6 | #5417 | Rebuild the device connect screen around the QR code | `first-run-09` 1, 2, 3, 4; `first-run-10` 1, 2; `first-run-11` 1, 2, 3; `first-run-12` 1 | M | 2.5 |
| 2.7 | #5418 | Show a matching number on access requests | `first-run-13` 1, 2 | M | 2.2 |
| 2.8 | #5419 | Group engines by what can run now | `customize-11` 1, 2, 3, 4, 5, 6, 7, 8 | M | 1.12, 1.1 |
| 2.9 | #5420 | Show what an engine runs through on its page | `customize-12` 1, 2, 3, 4, 5, 6 | M | 2.8 |
| 2.10 | #5422 | Check a proxy's format before an engine is routed through it | `customize-12b` 1; `customize-04` 1, 2, 3 | M | 2.9, 2.11 |
| 2.11 | #5421 | Rename Models to Providers and list them in two groups | `customize-02` 1, 2, 3, 4, 5, 6 | M | 1.12 |
| 2.12 | #5423 | Give each provider kind its own page | `customize-03` 1, 2, 3, 5, 6; `customize-04` 4, 5; `customize-05` 1, 3, 4 | M | 2.11 |
| 2.13 | #5424 | Explain a provider that needs attention, with the fix inline | `customize-06` 1, 2, 3, 4 | M | 2.11 |
| 2.14 | #5425 | Add a provider: check first, save after | `customize-07` 1, 2, 3, 4, 5, 6; `customize-08` 1, 2, 3, 4; `customize-09` 1, 2, 3, 4 | M | 2.11, 0.1 |
| 2.15 | #5426 | Add a custom endpoint with format detection | `customize-10` 1, 2, 3, 4 | M | 2.14 |
| 2.16 | #5427 | Rework Add engine | `customize-13` 1, 2, 3, 4 | S | 2.8 |
| 2.17 | #5428 | Turn Knowledge into one status page | `customize-14` 1, 2, 3, 4 | S | 1.12 |
| 2.18 | #5429 | Regroup the command palette | `navigation-22` 2, 3, 4, 5, 6 | M | 2.1, 2.14, 1.4 |

## Phase 3 · Projects and New Project

Make a project one page with view tabs and a three-way New Project.

Done when: A person creates a project from empty, a folder or Git and works in Overview, Chats, Tasks and Files with five settings sections.

| Slice | Issue | Outcome | Delivers | Size | After |
| --- | --- | --- | --- | --- | --- |
| 3.1 | #5430 | Ask one question in New Project: empty, folder or Git | `projects-01` 1, 2, 3, 4, 5; `projects-02` 1, 2, 3, 4, 5; `projects-03` 1, 2, 3, 4 | M | 0.9 |
| 3.2 | #5431 | Show project creation as steps, and recover an interrupted one | `projects-04` 1, 2, 3, 4, 5; `projects-05` 1, 2, 3 | M | 3.1 |
| 3.3 | #5432 | Give a project one page with a bar of view tabs | `projects-06` 1, 7; `projects-08` 3, 4; `projects-09` 1 | L | 1.12 |
| 3.4 | #5433 | Build the project Overview | `projects-06` 2, 3, 4, 5, 6; `projects-07` 1, 2, 3, 4, 5, 6 | M | 3.3, 1.1, 3.1 |
| 3.5 | #5434 | Add the project row menu and graduate Archive | `projects-08` 1, 2 | S | 3.3 |
| 3.6 | #5435 | Simplify the pane chooser in the Chats view | `projects-09` 2, 3, 4, 5 | S | 3.3 |
| 3.7 | #5436 | Merge Tasks into one view with lanes by status | `projects-10` 1, 2, 3, 4, 5, 6 | M | 3.3, 0.16 |
| 3.8 | #5437 | Rework the task page | `projects-12` 1, 2, 3, 4, 5, 6 | M | 3.7 |
| 3.9 | #5438 | Add apps as views from the plus, and manage Views in settings | `projects-11` 1; `projects-16` 1, 2, 3, 4, 5; `apps-09` 1, 2, 3 | M | 3.3, 1.4 |
| 3.10 | #5439 | Cut project settings to five sections with one save model | `projects-13` 1; `projects-14` 1, 2, 3; `projects-15` 1, 2; `projects-18` 1 | M | 3.3 |
| 3.11 | #5440 | Add Chat defaults to project settings | `projects-13` 2, 3, 4, 5, 6, 7, 8 | S | 3.10, 1.1 |
| 3.12 | #5441 | Move sources into a Files tab and graduate the Library | `projects-14` 4 | M | 3.3 |

## Phase 4 · Chat Details panel, actions and the Inbox

Replace the chat stats, inventory, Basis and settings surfaces with one Details panel and give every action and inbox item one name.

Done when: A person answers "what does it run on, what did it use, what did it do" from one panel and handles the inbox with Mark done.

| Slice | Issue | Outcome | Delivers | Size | After |
| --- | --- | --- | --- | --- | --- |
| 4.1 | #5442 | Add the Details panel with its Setup tab | `chat-10` 1, 2, 3, 4, 5, 6, 7; `chat-10b` 1, 2, 3; `chat-11` 1, 2 | M | 3.3 |
| 4.2 | #5443 | Build the Usage tab, with its chart tooltip and table view | `chat-02` 1, 2, 3, 4, 6, 7; `chat-03` 1, 2, 3, 4, 5, 6; `chat-04` 1, 2, 3; `chat-05` 1, 2; `chat-02` 5; `chat-02b` 1; `chat-02c` 1, 2 | M | 4.1, 0.3, 0.4 |
| 4.4 | #5444 | Keep usage honest across model and engine changes | `chat-21` 1, 2, 3; `chat-22b` 1, 2; `chat-23` 1, 2 | M | 4.2, 0.3 |
| 4.5 | #5445 | Draw the context ring's number and popover | `chat-01` 1, 2, 3, 4; `chat-25` 1 | S | 4.4 |
| 4.6 | #5446 | Mark model changes, fresh contexts and engine switches in the transcript | `chat-24` 1, 2 | S | 0.4 |
| 4.7 | #5447 | Build the Work tab for the whole chat | `chat-07` 1, 2, 3, 4, 5, 6 | M | 4.1 |
| 4.8 | #5448 | Build "About this answer" and show the Basis chip only on assessed answers | `chat-08` 1, 2, 3, 4, 5; `chat-09` 1, 2, 3, 4, 5, 6, 7 | M | 4.7 |
| 4.9 | #5449 | Give message and answer actions one name each | `chat-12` 1, 2; `chat-13` 1, 2; `chat-20` 1, 2, 3, 4, 5 | M | 4.8 |
| 4.10 | #5450 | Cut tool approval to three choices | `chat-14` 1, 2 | S |  |
| 4.11 | #5451 | Reorganise the chat, composer and slash menus, and confirm a switch of agent | `chat-15` 1, 2; `chat-15b` 1; `chat-16` 1; `chat-17` 1; `chat-19` 1; `navigation-22` 1; `chat-26` 1, 2 | M | 4.1, 4.2, 0.5, 2.18 |
| 4.13 | #5452 | Give inbox items one status, Mark done and one snooze list | `automations-inbox-13` 1, 2, 3, 4; `chat-18` 1; `automations-inbox-11` 10, 12 | M | 0.16 |
| 4.14 | #5453 | Rename Notifications to Inbox and simplify it | `automations-inbox-11` 1, 2, 3, 4, 5, 6, 7, 11; `automations-inbox-12` 1 | M | 4.13 |
| 4.15 | #5454 | Let the bell popover answer what needs you | `automations-inbox-10` 1, 2, 3, 4, 5, 6, 7 | M | 4.13 |

## Phase 5 · Agents, Skills, Tools, Apps, Automations, Settings and previews

Finish the remaining areas and turn previews on.

Done when: Every v1 screen is delivered and the preview list is the agreed one.

| Slice | Issue | Outcome | Delivers | Size | After |
| --- | --- | --- | --- | --- | --- |
| 5.1 | #5455 | List agents with Ready-made engines after yours | `agents-skills-tools-01` 1, 2, 3, 4, 5 | M | 2.8 |
| 5.2 | #5456 | Split the agent editor into tabs with an Overview | `agents-skills-tools-02` 1, 2, 3, 4 | M | 5.1 |
| 5.3 | #5457 | Rebuild the agent's Skills and Tools tabs | `agents-skills-tools-03` 1, 2, 3, 4; `agents-skills-tools-03b` 1, 2, 3 | M | 5.2 |
| 5.4 | #5458 | Create an agent from a name | `agents-skills-tools-04` 1, 2, 3, 4 | S | 5.2, 1.1 |
| 5.5 | #5459 | Make Skills one list with filters, a New skill menu and Browse | `agents-skills-tools-05` 1, 2, 3, 4, 5; `agents-skills-tools-06` 1; `agents-skills-tools-07` 1, 2, 3, 4 | M | 1.11, 1.4 |
| 5.7 | #5460 | Rework the tool server list and page | `agents-skills-tools-08` 1, 2, 3, 4, 5; `agents-skills-tools-09` 1, 2, 3, 4, 5 | M | 0.12 |
| 5.8 | #5461 | Add a tool server from the list or your own | `agents-skills-tools-10` 1, 2, 3, 4; `agents-skills-tools-11` 1, 2, 3, 4 | M | 5.7 |
| 5.9 | #5462 | Show an app's detail and an honest install review | `apps-04` 1, 2, 3, 4, 5, 6; `apps-05` 1, 2, 3; `apps-12` 1, 2, 3 | M | 1.4 |
| 5.10 | #5463 | Put installed apps in the sidebar with a row menu | `apps-02` 3; `apps-06` 1, 4; `apps-07` 1, 2, 3, 4 | M | 1.12, 5.9 |
| 5.11 | #5464 | Add Apps › Library and Updates | `apps-11` 1, 2, 3 | M | 1.4 |
| 5.12 | #5465 | Rename Boards to arranged apps and offer two ways to make your own | `apps-10` 1, 2, 3 | M | 1.12 |
| 5.13 | #5466 | Show automations with the next seven days and recent outcomes | `automations-inbox-01` 1, 2, 3, 4; `automations-inbox-02` 1, 2, 3, 4, 5, 6, 7, 8, 9 | M | 0.18 |
| 5.14 | #5467 | Give each automation its own page, including when it paused itself | `automations-inbox-03` 1, 2, 3, 4, 5, 6, 7, 8, 9, 10; `automations-inbox-05` 1, 2, 3, 4, 5; `automations-inbox-07` 1, 2, 3 | M | 5.13 |
| 5.15 | #5468 | Rebuild the automation form around what it should do | `automations-inbox-04` 1, 2, 3, 4, 5, 6, 7 | M | 5.13, 0.18 |
| 5.16 | #5469 | Restyle the automation proposal card in chat | `automations-inbox-06` 1, 2, 3, 4, 5 | S | 5.15 |
| 5.17 | #5470 | Group Settings, move rows to their owners, and save as you change | `settings-06` 1, 4 | L | 2.1, 2.8, 2.11, 3.10, 4.1, 5.2, 5.15, 5.11 |
| 5.18 | #5471 | Find any setting, including moved ones | `settings-06` 2; `settings-09` 1, 2, 3, 4 | M | 5.17 |
| 5.19 | #5472 | Merge Appearance into Settings, summarise Permissions and safety, and simplify Notifications settings | `settings-06` 3, 5; `settings-07` 1, 2, 3, 4, 5, 6; `settings-08` 1, 2, 3, 4, 5 | M | 5.17, 4.14 |
| 5.22 | #5473 | Split Profile into Settings › Account and a Usage page | `settings-12` 1, 2, 3, 4; `settings-13` 1, 2, 3, 4, 6, 7, 9 | M | 5.17 |
| 5.23 | #5474 | Turn previews on and sort the rest | `settings-10` 1, 2, 3, 4 | M | 5.17 |
| 5.24 | #5475 | Make Developer a Settings group behind Developer mode | `settings-11` 1, 2, 3, 4 | M | 5.23 |

## Not in the first release

| Screen and changes | Why it waits |
| --- | --- |
| `navigation-00` 1 | Reference screen that checks the rendering against today's product; nothing to build. |
| `navigation-12` 1 | Comparison screen used to choose the quiet sidebar; nothing to build. |
| `first-run-07` 1, 2, 3, 4 | Setup from chat needs the chat setup tools (set the default engine, propose a route), which are later. Guided engine setup itself graduates in 5.23. |
| `customize-17` 1, 2, 3, 4 | Chat setup tools: an add-a-provider proposal tool is new and later. |
| `customize-18` 1, 2, 3 | Chat setup tools: the secure key dialog opened from chat follows the proposal tool. |
| `customize-19` 1, 2, 3, 4 | Chat setup tools: reading an engine's route and proposing a change are new tools. |
| `customize-21` 1, 2, 3, 4, 5 | Model catalogue: one canonical model with ways to reach it needs the catalogue that maps a provider type and raw id at read time. |
| `customize-03` 4 | Model catalogue: canonical model names. |
| `customize-04` 6 | Model catalogue: canonical names and the Unrecognised group. |
| `customize-05` 2 | Model catalogue: canonical names without version. |
| `settings-13` 5, 8 | Model catalogue: canonical model rows and the Unrecognised row on the Usage page. |
| `agents-skills-tools-12` 1, 2, 3 | Chat setup tools: navigate with a prefill payload is new. |
| `agents-skills-tools-13` 1, 2, 3 | Chat setup tools: proposing a tool server and waiting for setup are new tools. |
| `settings-15` 1, 2, 3 | Chat setup tools: the appearance proposal card exists, but the screen depends on a preview-change tool that is new. |
| `chat-06` 1, 2 | Tokens per turn needs a per-turn series for one chat; marked not v1. |
| `chat-22` 1, 2 | Usage per stretch needs a segment record per chat; v1 ships per-engine rows (4.4). |
| `automations-inbox-03b` 1 | Per-run limits for scheduled automations are new server work; owner decision. |
| `apps-02` 2 | An app badge needs new server data and an SDK hook, planned after v1. |
| `apps-06` 2, 3, 5 | Release desk is an invented example and its pull-request data hooks are later; the app bar and "Sent from" label ship in 5.10. |
| `apps-08` 1, 2, 3, 4 | Research notes is an invented example, and saving notes needs a backend check. |
