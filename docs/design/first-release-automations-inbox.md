# First-release design: Automations and inbox

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

Automations get a readable list and one page per automation, and the Inbox replaces four overlapping notification surfaces with one status per item.

## What is wrong today

- Automations has a pause, but nobody can find it. Clicking the status cell ("on") toggles it, but it looks like a status label, so it is easy to miss.
- The page opens on scheduler internals ("SCHEDULER Healthy / Last tick just now / JOBS / SUCCESS RATE / TOTAL RUNS"). None of them answer what runs next or whether the last run worked. On a phone the four tiles fill the first screen.
- Three tabs split one question. List, Calendar (a week of "None scheduled") and Executions ("Executions appear after an automation runs") are three views of "what runs when, and did it work". No run links to the chat it ran in.
- The form is technical and its defaults are risky. Name is a slug (lowercase and hyphens only), the schedule has two rows of mode tabs, and a one-time run defaults to now with "Delete the job after it runs" ticked. The Edit dialog has no Name field. On a phone the form scrolls inside a window about 340px tall.
- Failure is a red "N failed" badge and nothing more. After 5 failures in a row Station switches the automation off and sends one notification. The list then shows "off", the same as a deliberate pause.
- Four surfaces overlap: the header bell popover, the Notifications page, the chat dock "Inbox" and Home's lists. They disagree. One failed run appears twice on the Notifications page, the same chat is "Delivery unconfirmed" under Needs you and "Done" under Just finished, and a failed chat stays "Failed" under Continue on Home.
- Event names replace plain words: "Session failed", "Turn Completed", "Your agent finished", "Open session", and raw server text such as "Station agent did not accept the task turn: Multiple enabled LLM provider connections require an application default". The filters are event-type chips and two date pickers.
- There are seven verbs for "I'm done with this": Settle, Reopen, Snooze, Unsnooze, Restore to inbox, and Close chat, Dismiss from inbox and Hide from inbox, plus "Dismiss" and "Dismiss eligible items" on notifications. There are also two different snooze preset lists. Status words collide too: "scheduled" reads "Waiting" next to "Waiting on you".

## Agreed structure

- Automations stays in the sidebar. The list has a "Next 7 days" strip (the merged Calendar), then all automations as rows. Each row shows the schedule sentence, the next run, a strip of recent outcomes, a status and flags.
- One automation's page (a new route) shows When, What it does, Runs (a strip and a log, each run linking to its chat or task), Who runs it, and Limits. It replaces the inline row expansion.
- New and Edit share one dialog (a full-screen sheet on a phone). From chat, the existing proposal approval card is restyled to match the other proposal cards.
- The Executions tab is dropped, because each automation's page carries its runs and failures reach the Inbox. The Calendar tab is merged into the 7-day strip. The stat tiles are removed, and scheduler health appears only as a notice when it is broken.
- The Inbox is the Notifications page renamed. It is reached from the bell's "Open inbox" and the palette only, with no sidebar row. The old notification, activity and review-queue addresses redirect to it.
- The bell badge counts Needs you only (approvals, questions, device requests). Updates never raise it. The bell popover (a bottom sheet on a phone) answers Needs you items in place, shows the latest updates with one action each, and links to "Open inbox".
- The Inbox page shows everything that wants you or just finished, one row per thing, with tabs All, Needs you and Snoozed, a project filter and search. The chat list in the dock uses the same status words and row menu, and its header reads "Chats", not "Inbox".
- Home's "Waiting on you" shows the same Needs you rows (top 3 and "See all"), and "Finished recently" shows updates. Home adds no extra verbs.
- One item has one status everywhere, as on the Tasks board: the status is the ladder's word, and flags are "Last reply may not have arrived", "Snoozed until Mon 9 AM" and "Last 2 runs failed". A chat appears once, under whichever group its status puts it in.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| Pause an automation | 2, and undiscoverable (footer clock icon, then the hidden status cell) | 3 (Automations, ⋯, Pause), or the page's Pause button |
| See why a run failed and open it | Not possible (no run links to a chat) | 3 (Automations, the automation, Open in chat) |
| Answer an approval | 3 to 4 (bell, Open session, chat, Allow) | 2 (bell, Allow once) |
| Create an automation from a template | 4 plus typing (footer icon, template, fill a slug and 4 more fields, Create) | 3 (Automations, template, Create automation) |
| Create one by asking | Not possible | 1 after the reply (ask in any chat, Create automation) |
| Text: Automations, empty | 76 words, 3 sentences | 163 words, 8 sentences. More on purpose: each template now says what it does, and there are two example prompts. Chrome (title, subtitle, buttons) falls from 37 to 14 words. |
| Text: Automations list, chrome around the rows | 37 words, 1 sentence (stats, tabs, filter, 7 column headers) | 17 words, 1 sentence. Per row: about 14 words before, about 20 after. |
| Text: Automation form | 58 words, 1 sentence, about 20 controls | About 85 words without the user's own text, 3 sentences, 12 controls. Every added sentence reads back the user's own choice. |
| Text: Notifications and Inbox page, populated | 169 words, 7 sentences for 5 items (one fact twice) | 147 words, 4 sentences for 6 items. No event names and no machine identifiers on every row. |
| Text: Inbox, empty | 22 words, 1 sentence | 24 words, 1 sentence |

## Screens

### `automations-inbox-01` Automations, empty

1. **The subtitle reads "Work an agent does on a schedule."** It replaces "Recurring work and check-backs that run in a chat". It states what an automation is, and check-backs belong to their chat. _(copy; slice 5.13)_
2. **An example strip shows the three parts: when, who does what, and where results go.** It replaces four scheduler tiles that read "0" and a dash on an empty install. The owner asked to add visuals where they make things easier. _(layout; slice 5.13)_
3. **The four existing templates keep their schedules, and each now says what it does.** The words come from each template's real prompt. _(copy; slice 5.13)_
4. **"Or ask in any chat", with two example prompts.** It uses the existing "propose a job" action. _(layout; slice 5.13)_

### `automations-inbox-02` Automations list

On a phone: "Next up" shows three rows, with no sideways scroll.

1. **The scheduler, jobs, success and runs tiles are removed. A stopped scheduler becomes a page notice ("Automations aren't running: …").** None of the tiles answer what runs next or whether the last run worked. The notice is backed by the scheduler status and the stale-heartbeat event. _(layout; slice 5.13)_
2. **"Next 7 days" replaces the Calendar tab. Paused automations are left out.** Today the Calendar tab is a week of "None scheduled". The data already exists. On a phone it becomes "Next up", three rows, with no sideways scroll. _(layout; slice 5.13)_
3. **The schedule as a sentence, plus "Next: Mon 8:00 AM".** It replaces cron text and a "NEXT FIRE" column. _(copy, layout; slice 5.13)_
4. **A strip of the last 12 outcomes: filled means worked, red with a dot means failed, outline means skipped as late.** It replaces "SUCCESS%", and uses shape plus colour, never colour alone. The list read returns only a success rate, the last run and consecutive failures, so the strip needs the last N log entries per job. _(server work, backend check first; slice 5.13)_
5. **Status is Active, Paused or Running, in words.** It replaces the clickable on and off dot. Pause moves to the ⋯ menu and the page. Today the toggle looks like a status label. _(layout, copy; slice 5.13)_
6. **A flag, "Last 2 runs failed". The status stays Active.** Today failure is a red "N failed" badge and nothing more. _(layout; slice 5.13)_
7. **A flag, "Paused itself after 5 failed runs", with status Paused.** Today the list shows "off", the same as a deliberate pause. This needs a stored reason. _(new screen state, server work; slice 5.13)_
8. **A row ⋯ menu: Run now, Pause or Resume, Edit, Duplicate, Delete.** All of them exist today as icon buttons. _(layout; slice 5.13)_
9. **The List, Calendar and Executions tabs and "Filter automations…" are removed. Filtering returns only with more than about 15 automations.** Today three tabs split one question. _(layout; slice 5.13)_

### `automations-inbox-03` Automation page

On a phone: The same page in one column.

1. **A status pill beside the name.** Today Pause is hidden in a clickable status cell. _(layout; slice 5.14)_
2. **Run now, Pause, Edit and ⋯ (Duplicate, Delete).** All are existing operations. _(layout; slice 5.14)_
3. **"Every weekday at 8:00 AM, Denver time": the rule in its own zone.** The jobs table does this today. _(copy; slice 5.14)_
4. **The next five runs.** They come from the existing schedule preview. _(layout; slice 5.14)_
5. **"What it does" shows the prompt verbatim.** _(layout; slice 5.14)_
6. **A run strip (16 runs) and a legend.** They come from the job's run log. _(layout; slice 5.14)_
7. **Each run links to its chat or task.** Today no run links to the chat it ran in. A dedicated target is one chat for every run, so the link must land on that run's turn. Anchoring a turn by client turn id needs a backend check. _(new screen state, backend check first; slice 5.14)_
8. **Skipped runs say why, in plain words.** The reason comes from the skipped-as-late record and the 6 hour lateness cutoff. _(layout; slice 5.14)_
9. **"Who runs it": agent, engine and model, where results go, and "Asks first, like any chat".** Runs go through the chat's approvals. Today's form says "Each run is a message in the chat, with its approvals". _(layout; slice 5.14)_
10. **Two plain lines under "Who runs it": it pauses itself after 5 failed runs, and skips a run more than 6 hours late.** These are two real behaviours. Both are confirmed in code. There is no per-run limit in v1, by decision. _(copy; slice 5.14)_

### `automations-inbox-03b` Automation page with run limits (later version, not v1)

On a phone: The same page in one column. This is a later version, not v1.

1. **LATER, not v1: a "Limit per run" with "last run used" meters.** Scheduled jobs have no budget today. A budget type exists but is enforced only for GitHub event rules and pull request monitors, so the proposal reuses it for scheduled jobs. It adds a "Change" control on the form. "Last run used" also needs tokens per run, which are recorded by conversation and turn. The meter fill is neutral ink, and status colour is used only when a limit is near. _(server work, new screen state, backend check first; not in the first release)_

### `automations-inbox-04` New and edit automation

On a phone: A full-screen sheet with Cancel and Create pinned at the bottom. Today the form scrolls inside a window about 340px tall.

1. **"What should it do?" comes first.** That is the decision a person starts from. _(layout; slice 5.15)_
2. **Presets replace the two rows of mode tabs: Every day, Weekdays, Weekly, Every few hours, Once, Custom.** Today's form has "Calendar / Exact interval / One time", then "Every / Weekly / Cron". Custom opens the existing cron editor, and presets map to the existing schedule kinds. _(layout, new screen state; slice 5.15)_
3. **A read-back sentence plus the next three dates.** Kept from today's preview, which works well. _(layout; slice 5.15)_
4. **An agent picker, with engine and model shown read-only.** _(layout; slice 5.15)_
5. **"Where results go": Its own chat, or A new task in a project.** "This chat" is added when the form opens from a chat. The project option is behind a feature preview today. It ships only if a project schedule can be edited and deleted from Automations, which this slice settles first; otherwise the first release offers "Its own chat" only. _(layout, backend check first; slice 5.15)_
6. **Name moves last and takes plain words, suggested from the instructions.** A job stores a display name beside its slug. Station derives the slug from the name and keeps it hidden. Edit has a Name field that renames without changing the slug or its runs. _(server work; slice 5.15)_
7. **Not on the form for v1: Retries and Retry delay, "Station engine, output file", the GitHub pull request monitor fields, and "Run with".** They are technical, and the first two apply only to file runs. _(layout; slice 5.15)_
8. **"Once" defaults to tomorrow at 9:00 AM, and "Remove it after it runs" is unticked. No screen is specified for it.** Until the presets of change 2 exist, the default applies to the "One time" tab. _(copy; slice 0.18)_

### `automations-inbox-05` Automation that paused itself

On a phone: The same page in one column.

1. **A notice: "Paused itself after 5 failed runs in a row", with the shared reason in plain words.** Today the list shows "off" plus a toast. _(new screen state, server work; slice 5.14)_
2. **One next step that fixes the cause: "Sign in to Codex", which goes to Customize › Engines.** The agent's runnability reason already exists. _(layout; slice 5.14)_
3. **Resume sits where Pause was.** It is the same enable call. _(layout; slice 5.14)_
4. **The engine flag "Not signed in" in "Who runs it", with the two real behaviours under it.** _(layout; slice 5.14)_
5. **Each failed run, with its reason on one line.** _(layout; slice 5.14)_

### `automations-inbox-06` Chat proposes an automation

On a phone: The same card in one column.

1. **The same frame as the other proposal cards: title, a "Proposed" tag, and facts.** _(layout; slice 5.16)_
2. **"When" reads as a sentence plus the first run.** Today it reads "Next at …" or a raw cron expression. _(copy; slice 5.16)_
3. **"Runs in: This chat · Station Assistant".** It is honest. An approved proposal runs in the chat that proposed it, on that chat's engine. With a project it runs as Tasks. _(copy; slice 5.16)_
4. **Create automation, Edit first, Not now.** "Edit first" opens the form pre-filled. _(new screen state; slice 5.16)_
5. **"Nothing runs until you create it."** _(copy; slice 5.16)_

### `automations-inbox-07` Delete an automation

On a phone: A sheet.

1. **It names what happens: "It won't run again. Its chat and past results stay where they are."** Whether deleting a job keeps its conversation needs a backend check. _(copy, backend check first; slice 5.14)_
2. **"Pause instead" is the reversible alternative.** Deleting cannot be undone. Pausing can. _(layout; slice 5.14)_
3. **Delete is in the danger colour.** _(layout; slice 5.14)_

### `automations-inbox-10` Bell popover

On a phone: A bottom sheet.

1. **The badge counts Needs you only (2).** Updates never raise the badge. _(new screen state; slice 4.15)_
2. **"Needs you 2 · Open inbox" replaces the "Needs attention / Activity" tabs.** Today the bell popover, the Notifications page, the chat dock Inbox and Home's lists disagree. _(layout, copy; slice 4.15)_
3. **Approve in place: the command, then Allow once, Deny or Open chat.** The inline approval component exists. _(layout; slice 4.15)_
4. **Answer a question in place.** The inline reply component exists. _(layout; slice 4.15)_
5. **Updates: one row per thing, with one action ("Sign in").** _(layout; slice 4.15)_
6. **Done, with the flag "Last reply may not have arrived".** It replaces a separate "Delivery unconfirmed" lane. _(new screen state; slice 4.15)_
7. **"Mark updates done" replaces "Dismiss eligible items".** This is the bulk acknowledge. _(copy; slice 4.15)_

### `automations-inbox-11` Inbox

On a phone: The same page in one column.

1. **The page is named "Inbox".** It matches Settings › Notifications, which says "Open inbox". _(copy; slice 4.14)_
2. **Tabs All, Needs you and Snoozed replace the three event-type chips and the From and To date pickers.** Today the page is filtered by event-type chips, which show event names, and two date pickers. _(layout; slice 4.14)_
3. **A project filter and search.** Search keeps today's behaviour. _(layout; slice 4.14)_
4. **Needs you rows open with the answer controls visible.** _(layout; slice 4.14)_
5. **A question is answered in the row.** _(layout; slice 4.14)_
6. **The Updates group, with "Mark all done".** _(layout; slice 4.14)_
7. **An automation failure says what failed and offers one step ("Sign in to Codex").** Today a failed-turn notification shows raw text about provider connections needing an application default. _(layout; slice 4.14)_
8. **Raw server text is translated: "Couldn't start: two providers are turned on and neither is the default.", with "Choose a default".** Today the page shows raw server text. The mapping is new copy per failure code. "Choose a default" goes to Customize › Providers. _(copy; slice 0.17)_
9. **Done, plus a flag, plus "Check".** It follows the Tasks board rule. _(layout; slice 0.16)_
10. **A row ⋯ menu.** It opens the menu specified on the row actions screen. _(layout; slice 4.13)_
11. **The gear opens Settings › Notifications.** The separate "Notification settings" link and "Dismiss eligible items" button are removed. _(layout; slice 4.14)_
12. **One row per chat. The duplicate "Session failed" and "Turn Failed" pair collapses into one Failed row.** Today one failed run appears twice on the Notifications page. _(new screen state; slice 4.13)_

### `automations-inbox-12` Inbox, empty

On a phone: The same state in one column.

1. **"Nothing needs you", plus one line about what lands here.** It replaces "All caught up / Nothing needs your attention right now". _(copy; slice 4.14)_

### `automations-inbox-13` Inbox row menu

On a phone: The same sheet.

1. **The row menu: Open chat, Mark done, Snooze ▸, and Discard draft (only when a draft exists).** _(layout; slice 4.13)_
2. **"Mark done" replaces Settle, Dismiss from inbox, Hide from inbox and notification Dismiss. Reopen undoes it.** Today there are seven verbs for "I'm done with this". _(copy; slice 4.13)_
3. **One snooze list for every surface: In 1 hour, This evening, Tomorrow morning, Next week, each showing its real time.** Today there are two different snooze preset lists. _(copy; slice 4.13)_
4. **Discard draft stays a danger item. "Discard unsent draft" and "Discard draft" become one label.** _(copy; slice 4.13)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Scheduled automations (cron, every, at) | Keep | Core. |
| Templates on the empty state | Keep | Listed as working well. |
| Schedule preview and next runs | Keep | Made more prominent. Real and reassuring. |
| Stat tiles (Scheduler, Jobs, Success rate, Total runs) | Remove | They answer nothing. Health becomes a notice. |
| Calendar tab | Simplify | Becomes the 7-day strip on the list. Same data, no extra tab. |
| Executions tab | Remove | Runs move to each automation's page, and failures go to the Inbox. It was a duplicate view. |
| Pause (status-cell toggle) | Keep | Made visible as Pause and Resume. It is real but undiscoverable. |
| Run now, Duplicate, Delete | Keep |  |
| Name as a slug | Simplify | A display name, with the slug hidden. The slug is technical and blocks rename. |
| Retries and retry delay | Hide for the first release | Hidden for v1. Only "Station engine, output file" runs use them. |
| "Run in: Station engine, output file" | Hide for the first release | Hidden for v1, behind Advanced or developer tools. It is a legacy mode with no chat to link to. |
| "Run with" (scheduler provider select) | Hide for the first release | Shown only when more than one exists. It is internal. |
| GitHub pull request monitor fields on the form | Hide for the first release | Hidden for v1. They take millisecond values and secret-binding ids, which is feature preview territory. |
| GitHub event automations | Hide for the first release | Hidden for v1. They stay behind their feature preview. Owner decision. |
| Per-run limits for scheduled automations | Hide for the first release | Later, not v1 (specified only on the screen recorded for a later release). New server work. Owner decision. |
| Agent check-backs | Keep | They stay in their own chat, not on Automations. They belong to one chat. |
| Project schedules (run as a Task) | Turn on by default | Graduate the preview with this page only if a project schedule can be edited and deleted from Automations, which slice 5.15 settles first. Otherwise the first release offers "Its own chat" only. |
| notifyStart | Remove | Removed from the contract. It is ignored today, a dead field. |
| Bell and popover | Simplify | Kept, with Needs you and updates, answerable in place. |
| Notifications page | Keep | Kept as "Inbox". |
| Date-range filter and event-type chips | Remove | Replaced by tabs, a project filter and search. |
| Open and settled inbox preview | Keep | On by default, as Mark done and Reopen. |
| Snooze preview | Keep | One preset list. |
| Hide, Dismiss, Close and Settle on an inbox item | Simplify | Was four verbs. Now one: Mark done. |
| Chat dock "Inbox" title | Simplify | Becomes "Chats". It is the chat list. |
| Automation status on and off (a clickable dot) | Simplify | Was "on" and "off". Now Active and Paused (plus Running). "off" read as a fact, not a control. |
| "Automation disabled after repeated failures" and "turned off" | Simplify | Was "turned off". Now Paused plus the flag "Paused itself after 5 failed runs". Today it is the same state as a deliberate pause. |
| "N failed" badge | Simplify | Becomes the flag "Last N runs failed", beside a status. |
| Scheduler "Healthy" tile | Remove | A label for the normal state carries no information. A notice shows only when broken. |
| "Needs attention" section | Simplify | Was "Needs attention". Now "Needs you", matching Home and the Tasks board. |
| Session failed and Turn Failed (two rows) | Simplify | Was two rows. Now one Failed row with a plain reason and one step. |
| Turn Completed and "Your agent finished" | Simplify | Becomes Done, as the item's row and not an event. |
| Delivery unconfirmed (Needs you lane) and Done (Just finished) | Simplify | Becomes Done plus the flag "Last reply may not have arrived" and Check. This follows the Tasks board rule. |
| "Waiting" for a scheduled item | Simplify | Was "Waiting". Now "Scheduled · 4 PM". It collided with "Waiting on you". |
| Approval request and Input needed | Simplify | Was two phrasings. Now "Needs approval" and "Needs input", ladder words everywhere. |
| Settle conversation, Dismiss from inbox, Hide from inbox and notification Dismiss | Simplify | Was four verbs. Now "Mark done", one verb for "I've handled this". |
| Reopen conversation and Restore to inbox | Simplify | Was two verbs. Now "Reopen". |
| Close chat on the inbox row | Simplify | Removed from the row. Close stays on the open chat (⌘W). Closing a tab is not an inbox action. |
| Snooze and Unsnooze (two preset lists) | Simplify | Was two lists. Now one "Snooze" list and "Wake now". |
| Discard unsent draft and Discard draft | Simplify | Was two labels. Now "Discard draft". |
| Dismiss eligible items | Simplify | Was "Dismiss eligible items". Now "Mark updates done". |
| Open session, Open and Open task | Simplify | Was three labels. Now "Open chat" and "Open task", which name what opens. |
| Pause, Run, Edit, Duplicate and Delete as hidden or icon-only controls | Simplify | Now labelled: Pause or Resume, Run now, Edit, Duplicate, Delete. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Automations copy, labelled Pause and Resume, status words | copy | Also layout. |
| 7-day strip | layout | The week data already exists. |
| Run-outcome strip in the list | server work | New server data: the last N outcomes per job in the list read. Needs a backend check. |
| Automation page route | new screen state |  |
| Run linking to its turn in a dedicated chat | new screen state | Needs a backend check: anchoring by the run's client turn id. |
| "Paused itself" versus paused by you | server work | Store a disable reason. The repeated-failure path already knows it. |
| Per-run limit for scheduled jobs (later, not v1) | server work | Specified only on the screen recorded for a later release. Reuses the existing budget type, plus new UI. |
| "Last run used" meters (later, not v1) | server work | New server data: usage recorded by turn. Needs a backend check. |
| Display name and rename | server work | New server data. |
| Form presets and read-back | layout | Also new UI state. |
| Proposal card restyle | layout |  |
| "Edit first" on the proposal | new screen state |  |
| Proposal running as its own chat with another agent | chat tool | Extend the "propose a job" tool with a dedicated target. No screen is specified, and it is needed only if wanted. The card shows the real behaviour. |
| Delete keeps the chat | backend check first | Confirm that deleting a job keeps its conversation. |
| Agents adding, enabling and running jobs directly | backend check first | Confirm which chat agents get these tools. Only the proposal path was verified. |
| Inbox rename, tabs, removing chips and dates | copy | Also layout. |
| One row per item (merge the failed-session attention with the failed-turn notification) | new screen state | Dedupe by conversation. |
| Failure reason in plain words plus one step | copy | A map per failure code. |
| "Last reply may not have arrived" as a flag | new screen state | A change to the status lane. |
| "Mark done" acts as Settle where that exists, and as Dismiss otherwise | new screen state |  |
| One snooze preset list | copy |  |
| Bell badge counts Needs you only | new screen state |  |
| Settings › Notifications: two wording changes | copy | The subtitle becomes "What may interrupt you, and where. Everything lands in the inbox; the bell counts only what needs you." The Agent notifications hint adds "Failures include an automation pausing itself." |
| Home: "See all (N)" after Waiting on you | layout | Links to the Inbox once it holds more than 3. |

## Decisions taken during design

- "Mark done" replaces Settle, Dismiss and Hide everywhere, and "Close" belongs to the open chat. The chat menus change to match.
- Per-run limits for scheduled automations are later. They are removed from the automation page, form and failing screens, and specified only on the screen recorded for a later release.
- GitHub event automations are hidden for v1.
- The Inbox is reached from the bell and the palette only. There is no sidebar row.
- A budget limit is real and enforced only for GitHub event rules and pull request monitors, not for the scheduled automations on this page. The per-run limit is recorded as new work. The chat path that could be verified is "propose a job", and its approved job runs in the proposing chat. The card shows that instead of a separately chosen agent.
- Considered: "Settle, Mark done, keep in Recent" in the chat menus, which needed its own explanation line to say what the word does. Use "Mark done". "Close" belongs to the open chat, not the inbox row.
