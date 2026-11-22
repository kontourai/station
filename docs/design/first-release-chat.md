# First-release design: Chat: usage, work, setup and actions

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

One Details panel with Setup, Usage and Work tabs replaces four separate chat surfaces, usage stays honest when the model or engine changes, and chat actions get one name each.

## What is wrong today

- Three surfaces answer "what is this chat?" in three places: the dock's "THIS CHAT" aside, the Conversation Statistics modal, and the Basis or "Chat inventory" dialog. Each has its own entry point.
- Stats is a ten-section wall of label and value rows, with a helper subtitle under each heading and no visual. On an engine that does not report usage it prints In: 0 / Out: 0 / Total: 0 for figures the engine never reported. It has no answer for "what's left", because the account's 5-hour and 7-day figures show only on the engine page. The slash command posts its result into the transcript as a message. After an engine switch the stats total is wrong, by-model is empty for outside-engine chats, and the context figure stays stale until the first usage report from the new engine.
- Chat inventory leads with metadata, not results. It has eleven groups in a two-column browser, three "At a glance" tiles that say "Not captured, count unavailable", and Outputs as the sixth group. Its copy explains authorization.
- The Basis chip is on every answer and almost always says nothing. With no published assessment, which is the normal case, it opens "Unassessed" plus a gap paragraph and the same inventory. Its vocabulary (Surface assessment, not-captured, Session) is internal.
- "Chat settings" holds display and device preferences (on a fresh install, 131 words and 14 prose lines), with Session goal and Summarize as the only per-chat items. The chat's real setup (agent, model, effort, approvals, folder) is scattered over composer pills and the aside.
- The same action has different names in different places: "Fork from here…" vs "Branch from this answer", "New chat from this message", "Attach to Task" vs "Add to Task", "Close chat" vs "Dismiss from inbox" vs "Hide from inbox", "History" vs "Browse turns". Stats opens from the ring, a phone sheet and a slash command.
- Four look-alike undo actions have no stated difference. Two slash commands do not do what they say: /clear and /new only empty the message list on screen and post "Conversation cleared". The agent's memory and the transcript on the server are untouched, and /new does not start a chat.
- Chat-level actions live in the composer ("Continue with another agent…", "Reset agent context…"), and the dock's ⋯ menu mixes layout actions with chat actions. The palette has 35 navigation and global rows and nothing scoped to the open chat.

## Agreed structure

- One Details panel with three tabs: Setup, Usage and Work. It replaces the dock aside "THIS CHAT", the stats modal, the chat settings panel and the Basis and inventory dialog.
- Setup answers "what does this chat run on, and what can I change?" It replaces the chat settings panel, "Continue with another agent", the aside's Workspace and Branch, and the stats modal's "Engine MCP servers".
- Usage answers "how full is it, what is left on the account, what did it use, where did it go?" "Now" (context and what is left for the engine, model and account the next message uses) sits above "This chat so far". A model change on the same engine stays one total. An engine change adds one row per engine, never added together. It replaces the stats modal and the /stats transcript message.
- Work answers "what did it do and produce?", for the whole chat or for one answer. It replaces Chat inventory, the Basis dialog, "Answer details" and "Changed files (N)".
- Basis and Chat inventory become one surface with two scopes, Whole chat and This answer. With no answer selected, the second reads Latest answer. An assessment, when one exists, heads the This answer scope.
- Details opens from the header Details icon and ⌘I, from an answer's ⋯ menu as "About this answer", from /usage and /tools, and from the context ring's popover through "Usage details". On a phone it is a pushed screen with the same tabs.
- The context ring opens a small popover with three answers: context percent, this chat's tokens and turns, and the account's tightest limit. The ring shows its percentage next to the arc. Transcript markers show a model change, a fresh context and an engine switch.
- Display preferences (Return key, font size, answer delivery, auto-hide dock, agent browser sessions) move to Settings › Chat and voice. Event replay moves to Developer. Show reasoning and Show tool details stay in Setup as quick toggles.
- Inside a project's Chats view, Details is the first icon in the pane rail and shares the pane slot with Files, Changes and Terminal. Outside a project it opens as the chat's own right panel. Beside an app, Details opens inside the side pane as a pushed view ("‹ Chat"). Changes stays the whole folder's diff, and Work lists what this chat changed.
- Actions get one name each. The three undo actions differ on one axis: Rewind chat to here (the agent forgets after this point), Start fresh context (the agent forgets the whole chat) and Restore files to here (files only). /clear is removed and /new really starts a new chat.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| Actions available across the chat surfaces | About 57 entries across 8 places plus the phone sheet (45 distinct actions, several under two or three names, plus 12 phone-only rows) | 38 distinct actions, one name each, all reachable on a phone |
| Text on the full stats surface (Claude chat) | 203 words, 9 explanatory sentences (the full modal, reconstructed from its copy) | 92 words, 2 |
| Text on the stats ring | Tooltip only | 24 words, 0 |
| Text on the API key, sparse and empty usage panels | Not measured | 63, 29 and 24 words; 2, 0 and 2 explanatory sentences |
| Text on the chat inventory | 135 words (115 in the modal, 20 in the compact card), 4 explanatory sentences | 70 words, 0 |
| Text on the Basis panel, unassessed answer | 145 words, 7 explanatory sentences | 55 words, 2 |
| Text on the Basis panel, assessed answer | Not capturable, because no assessment is published | 96 words, 0 |
| Text on chat settings | 131 words, 10 explanatory sentences | 61 words, 2 (Claude Code). 70 words, 3 (Codex with a goal). |
| Check how full the context is | 1 to 2 (hover or open the ring modal, scroll) | 0 (glance at the ring, "59%") |
| See how much is left on my subscription | 3+ (leave the chat, Connections, Engines, Claude Code) | 1 (ring popover) |
| See what this chat produced | 3 (⋯, Chat inventory, Outputs group) | 2 (Details, Work), or 1 with ⌘I |
| Change the model for the next message | 1 (composer pill) | 1 (composer pill), or 2 (Setup) |
| See which account this chat is on | Not shown in chat | 1 to 2 (Setup) |
| Undo files to an earlier answer | 2 (answer ⋯, Restore workspace…) | 2 (answer ⋯, Restore files to here…), with a file list before you confirm |

## Screens

### `chat-01` Context ring popover

On a phone: A bottom sheet over the chat. The ring keeps its percentage in the composer.

1. **A popover from the ring with three answers only: context percent, this chat's tokens and turns, and the account's tightest limit.** The owner asked for "at a glance" and "not verbose". Today the ring opens a ten-section modal. _(new screen state; slice 4.5)_
2. **"Personal Max · 7-day limit · 62% left · Resets Thu 09:00".** The data exists for Claude and Codex only. It shows the lowest window and never says how much of the allowance this chat used. _(new screen state; slice 4.5)_
3. **The ring shows its number ("59%") beside the arc.** A ring alone needs hovering. The number is the answer. _(new screen state; slice 4.5)_
4. **"Usage details" (⌘I) is the only way on.** Stats stops being a modal. _(layout; slice 4.5)_

### `chat-02` Usage tab

On a phone: A pushed screen titled "‹ Chat" with the same tabs. Meters and bars run full width.

1. **A Context meter: "59% full · 118K of 200K tokens", with one line: "Claude Code compacts it on its own."** The percentage and window are backed by existing stats. The compaction line replaces the whole compaction block when the engine compacts itself. _(layout; slice 4.2)_
2. **Account meters (5-hour and 7-day) with reset times, and "shared by every chat on this account".** The one sentence prevents reading it as this chat's share. It wires existing account data into chat. _(new screen state; slice 4.2)_
3. **"This chat used": Tokens, Turns and Tool calls, then a thin bar: New input, Output, Reused from cache.** The figures are backed. Cache write is counted inside New input, and the legend says so: 18.2K uncached plus 96.4K cache write is 114.6K. With 41.8K output and 1.24M cache read, the total is 1.40M. If an engine reports no cache figures, "Reused from cache" reads "Not reported". _(layout; slice 4.2)_
4. **"By agent": ranked bars for this chat, subagents and delegated tasks. A task not added to the total is a grey bar labelled "own chat".** The usage tree already exists. The earlier by-model bars were removed because the by-model breakdown is empty for outside-engine chats today. _(layout; slice 4.2)_
5. **A chart and table toggle.** Every chart has a table twin. _(new screen state; slice 4.2)_
6. **"More: cost estimate, averages" is collapsed.** Averages and the engine's own cost estimate are not at-a-glance answers. On a subscription the dollar figure is Claude Code's API-equivalent, not a bill. _(layout; slice 4.2)_
7. **Removed from this surface: "Engine MCP servers" (now in Setup), the context breakdown for outside engines, and every helper subtitle.** Outside engines do not report the breakdown. _(layout; slice 4.2)_

### `chat-02b` Usage tab, hovering a bar

1. **A tooltip on the Explore subagent bar leads with the value ("214K tokens"). The hovered bar gets an outline.** The tooltip then reads "Explore · subagent" and "Of this chat 15%". The value leads, the line says what it is, and the mark lifts. _(new screen state; slice 4.2)_

### `chat-02c` Usage tab, table view

1. **A token table lists each reported figure beside the bar segment it lands in.** The figures are Input uncached 18.2K, Cache write 96.4K, Output 41.8K and Cache read 1.24M. Both columns total 1.40M, so the bar, the table and the reported total agree. _(new screen state; slice 4.2)_
2. **"Who", "Tokens" and "In total": the table twin of the By agent bars.** It says "No, own chat" in words. _(new screen state; slice 4.2)_

### `chat-03` Usage tab, pay-per-use API key

On a phone: Same as the Usage tab: a pushed screen with full-width meters.

1. **Context 23%, with "What fills it · estimate" ranked bars: Conversation, Instructions and tools, Files.** Station's own estimates exist only for Station's engine. Five parts are merged into three, which is plainer and avoids a five-part chart. _(layout; slice 4.2)_
2. **"Compact now…" and "Auto-compact at 80%" with a settings cog.** Compaction belongs under the context it shrinks, for Station's engine only and only with the context-compaction preview on. The two paragraphs of copy go into the confirm step. _(layout; slice 4.2)_
3. **"Amazon Bedrock · Work. Pay per use. No allowance to show."** API-key providers have no usage left to show. Say so once instead of drawing an empty meter. _(copy; slice 4.2)_
4. **A cost tile, "$0.96".** It shows only because Bedrock is priced. _(layout; slice 4.2)_
5. **"Reused from cache: Not reported" in muted text, not 0.** An absent figure is not zero. _(copy; slice 4.2)_
6. **"All on Claude Sonnet" instead of a one-bar chart.** A one-bar chart tells you nothing. _(layout; slice 4.2)_

### `chat-04` Usage tab, engine reports little

On a phone: Same as the Usage tab.

1. **The stat strip keeps what is reported (Turns 6, Tool calls 22) and says "Not reported" in place for tokens.** The panel leads with real numbers, so it is not an empty wall. Which engines report turns and tool calls but no tokens needs a backend check. Goose is only an example. _(layout, backend check first; slice 4.2)_
2. **"Not reported by Goose": dashed chips for Context size, Tokens, Models, Cost and Account limits.** One glance shows what is missing. No meters are shown for missing data, and the ring is absent in the composer, as today. _(new screen state; slice 4.2)_
3. **A tool-call outcome strip.** It comes from the inventory's Execution group, which is backed even when usage is not. _(layout; slice 4.2)_

### `chat-05` Usage tab, no stats at all

On a phone: Same as the Usage tab.

1. **An empty state: "No usage for this chat. It runs on Build Box. Usage stays there.", with "Open on Build Box".** Relay chats get no stats today. The relay wording and whether the link can open the other Station need a backend check. _(backend check first; slice 4.2)_
2. **"Tool calls · at least 4".** Inventory counts can be a lower bound. The screen says so in place. _(copy; slice 4.2)_

### `chat-06` Tokens per turn (not v1)

On a phone: Same as the Usage tab.

1. **A "Tokens per turn" chart: one series of columns on one axis (0 to 150K), with a crosshair and tooltip.** The tooltip on turn 12 reads "158K tokens · Turn 12 · 141K reused from cache". It answers "why did context grow", since cache re-reads dominate. It needs a per-turn series from the server, either on the stats route or as a conversation filter on the usage rollup. _(server work; not in the first release)_
2. **One sentence: "Most of each turn is the chat re-read from cache."** It states the reading so the chart is not decoration. It is recommended not to ship this chart in v1. _(copy; not in the first release)_

### `chat-07` Work tab, whole chat

On a phone: A pushed screen with the same tabs.

1. **A scope switch: Whole chat and Latest answer.** These are the two scopes that matter. "Kept in Task" appears as a third segment only in a Task. _(layout; slice 4.7)_
2. **A "Running now" row (Load test, a delegated task).** Live work comes first because it changes. _(layout; slice 4.7)_
3. **"Produced" comes first: a pull request, a declared file, a created GitHub issue. Its ⋯ holds Inspect and Keep in Task.** This answers the agreed "what did it produce". Outputs and Work items are merged. _(layout; slice 4.7)_
4. **"Changed files · 5" with A, M and R badges and a Review link.** It comes from each turn's changed files, with no line counts. The whole-chat union is new aggregation in the UI. Checkpoints marked unavailable need a backend check. _(new screen state, backend check first; slice 4.7)_
5. **A "Tool calls · 63" status strip: succeeded, failed, cancelled, no result, each with icon, label and count.** Status colours are used for status only. Counts carry a "≥" prefix when only some pages are loaded. _(layout; slice 4.7)_
6. **Count chips for the remaining groups: Messages, Files sent, Approvals, Plans, Checks.** Each opens its list, so no row reading is needed. Sources is not shown for the whole chat, because it is a gap there. Resources moves to Usage. Attention, when present, becomes a notice above Produced. _(layout; slice 4.7)_

### `chat-08` Work tab, one answer (not assessed)

On a phone: A pushed screen with the same tabs.

1. **A tooltip on the Explore subagent bar leads with the value ("214K tokens"). The hovered bar gets an outline.** The tooltip then reads "Explore · subagent" and "Of this chat 15%". The value leads, the line says what it is, and the mark lifts. _(layout; slice 4.8)_
2. **"Asked": your message and its attachment.** These are the Inputs. _(layout; slice 4.8)_
3. **A tool-calls strip (9) and Changed files (3, from that turn).** _(layout; slice 4.8)_
4. **One line: "Not assessed. This shows what the agent did, not whether the answer is right."** Without it a list of actions reads like proof. There is no standing badge, no "Unassessed" label and no gap paragraphs. _(copy; slice 4.8)_
5. **No Basis chip in the answer footer on an unassessed answer.** "About this answer" lives in the answer's ⋯ menu. _(layout; slice 4.8)_

### `chat-09` Work tab, one answer (assessed)

On a phone: A pushed screen with the same tabs.

1. **A standing pill "Assessed with gaps" plus "Current as of 14:40" (or "Needs refresh").** Standing and freshness are backed. _(layout; slice 4.8)_
2. **The one claim, quoted.** There is one claim per answer, so there is no "claims by state". _(layout; slice 4.8)_
3. **"Uptime contract policy · not met · 1 item against it".** It shows the policy id, the outcome and the reason. _(layout; slice 4.8)_
4. **Evidence count tiles: Supports it, Cited, Link not stated, Against it (red outline when blocking).** These are the four buckets in plain words: entailing evidence, citations, support relationship not declared, counterevidence. _(copy; slice 4.8)_
5. **Evidence rows with source, locator, observed time, strength and "Blocks".** The fields are backed. _(layout; slice 4.8)_
6. **"What this answer used · 9 tool calls · 3 files", collapsed, below and separate.** Tool calls are never shown as evidence. _(layout; slice 4.8)_
7. **A small "Gaps" chip (or "Policy met") in the answer footer, only when an assessment exists.** The chip earns its place only when it says something. _(layout; slice 4.8)_

### `chat-10` Setup tab

On a phone: A pushed screen with the same tabs.

1. **"Runs on" rows: Agent, Model, Effort and Approvals.** Agent says "Switch" and applies from the next message. Effort is Low, Medium or High. Approvals reads "Ask first" and shows only for engines with a native control. These are the chat's real settings, gathered from composer pills. _(layout; slice 4.1)_
2. **"Account: Claude subscription · Personal Max" with a lock icon and "Same for every Claude Code chat. Change in Customize › Engines".** No per-chat account exists. The account in use is engine-wide, so it is read-only with the reason. _(layout; slice 4.1)_
3. **"Folder: Notes API · main" with a copy icon and "Set when the chat started".** The folder is fixed for the chat, so it is read-only with the reason. _(layout; slice 4.1)_
4. **"Tool servers": GitHub and Linear, with "Linear: sign in" and "Sign in to Linear in Customize › Tools".** Moved from the stats modal's "Engine MCP servers". _(layout; slice 4.1)_
5. **No Goal section on a Claude Code chat.** Session goals exist only for Codex (with a token budget) and Muse (no budget). Claude Code has none. _(layout; slice 4.1)_
6. **"Display · All chats": Show reasoning, Show tool details, and "More in Settings › Chat and voice".** Device and display preferences leave the chat. _(layout; slice 4.1)_
7. **Gone from this surface: the sync caption, Return key, font size, answer delivery, auto-hide dock, browser sessions, event replay.** "Summarize chat" is gone too. It moves to the chat menu as "Add summary". _(layout; slice 4.1)_

### `chat-10b` Setup tab, Codex chat with a goal

On a phone: A pushed screen with the same tabs.

1. **Runs on: Codex · GPT · Medium. Account "ChatGPT subscription", read-only, "Same for every Codex chat".** _(layout; slice 4.1)_
2. **A Goal with a status pill ("Paused"), the objective, and a "Token budget 64K of 200K" meter, with "Codex enforces the budget."** Station passes the budget to Codex and Codex reports the tokens used. Station enforces nothing itself. What Codex does at the limit beyond setting that status is an assumption to confirm, so the screen does not say "stops". At the limit the pill reads "Budget reached". _(layout, backend check first; slice 4.1)_
3. **Actions are "Edit" and "Clear" only.** A goal set from Station is stored paused, and resume is unsupported today, so there is no Resume button. Backend check: what changes when activation ships. _(backend check first; slice 4.1)_

### `chat-11` Model picker in Setup

On a phone: The same picker as a bottom sheet.

1. **The model picker in its in-chat form: the current engine's models first, then a "Switches agent" group.** The group shows provider, account and "% left". It reuses the existing picker instead of adding a new one. _(layout; slice 4.1)_
2. **"Applies from your next message."** Engine and agent changes are staged today. One sentence prevents surprise. _(copy; slice 4.1)_

### `chat-12` Your message: actions

On a phone: The same rows in a bottom sheet titled "Your message". Long-press opens it.

1. **The hover row shows Copy, Edit (promoted) and ⋯.** Today "Edit and resend" sits inside the ⋯ menu. _(layout; slice 4.9)_
2. **The menu: Edit and resend, New chat from here, Add to Task, Rewind chat to here…, Restore files to here…, Copy text.** The first two undo items carry sub-lines. Rewind: "Agent forgets everything after this. You still see it." Restore: "Changes files only. The agent remembers." "Discard unsent message" appears only on an unsent message. _(copy; slice 4.9)_

### `chat-13` An answer: actions

On a phone: An identical sheet. The separate "Branch" icon is removed.

1. **The footer shows Copy, ⋯, thumbs up and thumbs down, plus an assessment chip only when assessed.** The Trace link stays developer-only. _(layout; slice 4.9)_
2. **The menu: Regenerate, New chat from here, Restore files to here…, About this answer, Show reasoning (412 words), Add to Task, Copy text.** Three old names for branching become "New chat from here". _(copy; slice 4.9)_

### `chat-14` Tool approval row

On a phone: The same choices in the request sheet, with the grants in its menu.

1. **The row offers Deny, Allow once (primary), a menu named "Allow for this session", and the row's details disclosure. The approval toast uses the same order and tones.** The inline card already had two labelled buttons with the session grants behind a menu. The toast was the surface that showed up to five buttons, one per choice. The button cap of two labelled actions holds, so the menu is not a third labelled button. _(layout; slice 4.10)_
2. **The menu holds only the session grants the request offered, each in its own words and each "for this session".** These are a command prefix (`Allow "gh pr create *" for this session`), every call of one tool, file edits, folder access, or the Station browser. A grant lasts only until the agent's session ends, so the menu is not called "Always allow". There is no grant for all of an arbitrary tool server's tools; adding one would be new, broader safety work. The only server-wide grant is the Station browser's, offered only for a call the adapter found to be an authentic Station browser call. There is no "Manage rules in Settings" link, because nothing in Settings shows or revokes these grants. _(layout, copy; slice 4.10)_

### `chat-15` Chat menu (⋯)

On a phone: The same sheet without keyboard hints. It replaces the phone Actions sheet's extra dozen rows.

1. **Header icons: New chat (+), Details (panel) and ⋯.** Today the stats open on desktop only by typing `/stats`, and the inventory and settings each open from a different place. _(layout; slice 4.11)_
2. **The menu: Details ⌘I, Jump to a turn…, Add summary, Turn into Task, Switch agent…, Start fresh context…, Copy ▸, Mark done, Close chat ⌘W.** Switch agent says "From your next message". Start fresh says "Agent forgets the whole chat. You still see it." Copy holds Chat ID and folder path. This chat is in a project, so "Move to a project…" is omitted. Mark done replaces Settle. _(copy, layout; slice 4.11)_

### `chat-15b` Chat menu, chat with no project

On a phone: The same sheet.

1. **"Move to a project…", with "Keeps this chat; it joins the project".** Was "Save to Project…". It shows only for chats with no project, and "Turn into Task" is absent because Tasks belong to a project. _(copy; slice 4.11)_

### `chat-16` Composer + menu

On a phone: The same items in a sheet.

1. **The menu: Attach files, Mention a file or chat (@), Saved drafts, Commands (/), and for a project: Open terminal, Open in Coding, Delegate…** Only "add to this message" and "work in this project" remain. Chat-level actions leave the composer. _(layout; slice 4.11)_

### `chat-17` Slash menu

On a phone: The same menu above the keyboard.

1. **The slash menu: /model, /usage, /tools, /fresh, /new, /compact (preview only), /commands.** /usage replaces /stats and opens the Usage tab. /tools replaces /mcp. /fresh opens today's Reset agent context dialog. /new really starts a new chat, which fixes today's behaviour. /stats and /mcp stay as hidden aliases, and /clear is removed. A /goal command is new and not drawn. _(copy, new screen state; slice 4.11)_

### `chat-18` Inbox row menu

On a phone: The inbox list with a visible ⋯ on each row and the same sheet.

1. **The row ⋯ menu: Open chat, Mark done, Snooze ▸, and Discard draft (danger, only when a draft exists).** Mark done replaces Settle, Dismiss from inbox and Hide from inbox, and Reopen undoes it. Snooze uses one shared list (In 1 hour, This evening, Tomorrow morning, Next week), and Wake now replaces Unsnooze. Close is not on the row. It belongs to the open chat (⌘W). _(copy; slice 4.13)_

### `chat-19` Command palette, This chat group

On a phone: Command and key hints are hidden on the phone.

1. **A "This chat" group in ⌘K when a chat is open. The chat menu's actions become searchable ("fresh" finds Start fresh context…).** Today the palette has no chat-scoped actions. This is UI only. _(new screen state; slice 4.11)_

### `chat-20` Restore files confirm

On a phone: A sheet.

1. **The title says what and to when: "Restore files to 14:31?"** The old name, "Restore workspace", did not say what changes or to when. _(copy; slice 4.9)_
2. **A two-column list of what changes and what stays, then "Only files change. Things done outside this folder are not undone."** The list reads: 4 files go back, Messages stay, Agent memory stays, PR #142 stays open. Today's copy is "This changes files only. Conversation history and external tool effects are not undone." This is the same meaning in plainer words. _(copy, layout; slice 4.9)_
3. **The file list (status and path) shows before you confirm.** Backed: the restore preview already returns the paths, and flags when some are not shown. _(layout; slice 4.9)_
4. **"Want the conversation to go back instead? Rewind chat to here".** It routes the wrong choice to the right one. _(copy; slice 4.9)_
5. **The button names the outcome: "Restore 4 files".** _(copy; slice 4.9)_

### `chat-21` Usage after a model switch (same engine)

On a phone: Same content in one column.

1. **"Now": Station · Claude Opus · Amazon Bedrock · Work, context 38% · 76K of 200K, "Pay per use. No allowance to show."** Now shows context and what is left for the engine, model and account the next message uses. _(layout; slice 4.4)_
2. **"This chat so far": one total (412K tokens, 9 turns, $2.18), the token split, and By model bars (251K $0.91, 161K $1.27).** A model switch on the same engine stays one total: same engine, same token scale, same account. By model is backed for Station's engine. _(layout; slice 4.4)_
3. **A transcript marker: "Model: Claude Sonnet to Claude Opus · Same engine, same memory."** The marker comes from consecutive turns' model. _(new screen state; slice 4.4)_

### `chat-22` Usage after an engine switch (later version)

On a phone: Same content in one column.

1. **"Now": Codex · GPT · ChatGPT subscription, context 15% · 41K of 272K, and Codex's 5-hour and 7-day limits.** The Codex context window needs a backend check. If it is unknown, the screen shows tokens only. _(layout, backend check first; not in the first release)_
2. **"This chat so far": 14 turns and 63 tool calls, a bar of turns, then one card per stretch. There is no combined total.** Each card shows engine and model, provider and account, turns, tokens, tool calls and cost in its own unit. Needs a segment record per chat on the server: engine, provider, account, model, first and last turn, tokens and cost per unit. A model change inside one engine does not start a new stretch. _(server work; not in the first release)_

### `chat-22b` Usage after an engine switch (v1)

On a phone: Same content in one column.

1. **The same "Now". "This chat so far" has one row per engine and no turn ranges.** The rows read Claude Code 860K tokens, $2.41 estimate, and Codex 312K, cost not reported. It uses today's usage tree. We need to confirm the tree gives per-provider token sums. If not, the fallback is "Now" only, with a line saying usage before the switch was on Claude Code and is not combined here. _(layout, backend check first; slice 4.4)_
2. **One line: "Not added together: each engine counts its own way."** The stats total for a chat with more than one engine is wrong today, so it is never shown. _(copy; slice 4.4)_

### `chat-23` Right after an engine switch

On a phone: Same content in one column.

1. **Context shows "Waiting for Codex" with an empty dashed track, not 0% and not the old 59%.** It adds "Starts with about 8K tokens of recent messages." Today the meter keeps the previous engine's figure. This needs to know a switch happened and that no usage report has arrived since. The context report must carry its session id, or a reset marker at a switch. _(new screen state, server work; slice 4.4)_
2. **The Claude Code stretch keeps its last context as history. The Codex stretch reads "No report yet".** The history line reads "ended at 59% context". The composer ring is dashed and shows a dash. _(new screen state; slice 4.4)_

### `chat-24` Transcript markers

On a phone: Same content in one column.

1. **Three markers in one transcript: a model change (dashed pill), a fresh context (dashed rule), and an engine switch (accent rule, both engine tiles).** A model change keeps memory. A fresh context keeps the engine but drops memory. An engine switch changes the engine and hands over a bounded slice. _(new screen state; slice 4.6)_
2. **The three marker texts: a model change, a fresh context, and an engine switch.** They read "Model: Sonnet to Opus · Same engine, same memory.", "Claude Code forgot everything above. You still see it.", and "Switched to Codex · GPT · Codex read about 8K tokens of recent messages. Approvals, tool servers and queued messages start fresh. Usage is counted separately." The handed-over amount needs a backend check. The copy says "about 8K" from the default budget. _(copy, backend check first; slice 4.6)_

### `chat-25` Ring popover after an engine switch

On a phone: A bottom sheet.

1. **The popover shows Codex · GPT, Context "Waiting for Codex" (dashed), the 7-day limit at 40% left, and Usage details.** It also shows "Earlier on Claude Code · 860K tokens". The account in Now is the only balance shown. The earlier engine's account is not metered. _(new screen state; slice 4.5)_

### `chat-26` Switch agent confirm

On a phone: Same content in one column.

1. **"Switch this chat to Codex?" with agent and model pickers, the account and its % left, in two columns.** It opens from Setup › Switch. The dialog exists today, and the lists are code facts. _(copy, layout; slice 4.11)_
2. **Carries over: recent messages (about 8K tokens), the folder, the chosen agent and model, the whole chat on screen.** Starts fresh: approvals given to Claude Code, tool-server setup, queued messages, and Claude Code's memory of older messages. The footer says "Usage is shown per engine, not added together." _(copy; slice 4.11)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Conversation Statistics modal | Simplify | Becomes the Usage tab plus the ring popover. One question per section, visual first, no helper subtitles. |
| Context ring | Keep | Add the percentage number. The number is the answer. |
| Context Window Usage | Keep | Shown as a meter. Backed. |
| Context Breakdown | Keep | Only for Station's engine, as "What fills it" with 3 rows. Only Station estimates it. |
| Total LLM Consumption | Simplify | Becomes a stat strip plus the token split. Four raw rows become three plain parts, with raw figures in the table or More. |
| Per Turn Averages | Hide for the first release | Behind "More". Derived and rarely asked. |
| Activity (turns, tool calls) | Keep | Kept in the stat strip. |
| Cost | Keep | Shown where priced. Behind "More" for engine-reported estimates on subscriptions. Cost only where real. |
| Engine-reported usage (credits, EUR) | Keep | Behind "More", never converted or summed. Backed and rare. |
| Usage with children | Keep | Shown as "By agent" bars. Answers "where did it go". |
| Engine MCP servers | Simplify | Moves to Setup › Tool servers. It is setup, not usage. |
| Per-Model Breakdown | Keep | Only for Station's engine. Not shown for outside engines, where it is empty today. |
| Not-reported footnote | Simplify | Becomes an in-place "Not reported" and dashed chips. An absent figure is not zero. |
| Compaction control | Hide for the first release | Hidden for v1 because it is a preview, with the copy too technical. Placement is under Usage › Context, for Station's engine only. |
| /stats message in the transcript | Remove | /usage opens the tab instead. A transcript message for a live panel goes stale. |
| Per-turn token chart | Hide for the first release | Not in v1. It needs a server series, and it is not a top question. |
| Chat inventory pane, dialog and compact card | Simplify | Becomes the Work tab. Results first. |
| Inventory hover card (inbox) | Keep | Shows Produced and Running only. A quick peek. |
| Task picker "Keep output in Task" | Keep | Kept in the output's ⋯ menu. |
| Inventory group: Outputs | Keep | Kept, first, as "Produced". |
| Inventory group: Work items | Simplify | Merged into Produced. Same question. |
| Inventory group: Live now | Keep | Kept at the top as "Running now". |
| Inventory group: Execution | Simplify | Becomes a tool outcome strip, with rows on tap. |
| Inventory group: Inputs | Simplify | Becomes a count chip for the whole chat and "Asked" for an answer. |
| Inventory group: Decisions | Simplify | Becomes an "Approvals" chip. Plain word. |
| Inventory group: Verification and delivery | Simplify | Becomes a "Checks" chip. |
| Inventory group: Attention | Keep | Shown as a notice when non-empty, hidden when empty. |
| Inventory group: Kept | Keep | Only in a Task. |
| Inventory group: Sources | Hide for the first release | Hidden for the whole chat, where it is a gap by design. Shown for an answer only when populated. A gap is never drawn as a list. |
| Inventory group: Resources | Simplify | Moves to Usage. It is a duplicate. |
| Plans (plan snapshots) | Keep | Shown as a chip. |
| Basis chip on every answer | Simplify | Shows only when the answer has an assessment. The unassessed chip says nothing. |
| Basis pane (preview stage) | Simplify | Merged into Work › This answer. The glossary already nests inventory in Basis. |
| /clear (local-only) | Remove | It looks like a reset and is not one. |
| /new | Simplify | Fixed to start a new chat. Today it clears the local list. |
| Unassessed standing label and gap paragraphs | Remove | Removed from the primary surface. One line is kept. Never imply verification. |
| Assessment view (standing, freshness, policy, evidence buckets) | Keep | Shown automatically when present. Backed and rare in v1. |
| "Answer details" (turn provenance) | Simplify | Merged into the This answer header. Same scope. |
| Chat settings panel | Simplify | Replaced by the Setup tab, because it held the wrong contents. |
| Session goal and token budget | Keep | In Setup, only where the engine supports goals (Codex with a budget, Muse without). A real per-chat setting. |
| Return key, Font size, Answer delivery, Auto-hide dock, Agent browser sessions | Simplify | Move to Settings › Chat and voice. They are device and display preferences. |
| Show reasoning and Show tool details | Keep | Quick toggles in Setup, also in Settings. People flip them while reading. |
| Summarize, Dismiss and Show dismissed summary | Simplify | Merged into one "Add summary" toggle in the chat menu. |
| Event replay | Hide for the first release | Moves to Developer. |
| "More chat settings" link | Keep | Becomes "More in Settings › Chat and voice". |
| Sync caption | Remove | Settings pages carry scope tags. |
| Dock aside "THIS CHAT" | Simplify | Merged into Setup. It was a duplicate. |
| Copy your message | Keep | Visible on hover. |
| Edit and resend | Keep | Promoted to a visible icon plus the menu. |
| Fork from here, Branch from this answer, New chat from this message | Simplify | Was three names for one action. Now "New chat from here". |
| Attach to Task and Add to Task | Simplify | Was two labels. Now "Add to Task". |
| Rewind conversation to here | Simplify | Was "Rewind conversation to here". Now "Rewind chat to here…", with a sub-line. |
| Restore workspace to here… | Simplify | Was "Restore workspace to here…". Now "Restore files to here…", with a sub-line. |
| Discard unsent message | Keep | Danger item in the menu of an unsent message. |
| Copy answer | Keep | Visible. |
| Regenerate | Keep | In the answer menu. |
| Answer details | Simplify | Was "Answer details". Now "About this answer", merged with Basis. |
| Basis chip | Simplify | Was a chip on every answer. Now an assessment chip ("Policy met" or "Gaps") only when assessed. |
| Reasoning (N words) | Keep | Shown as "Show reasoning". |
| Rating (thumbs up and down) | Keep | Visible. |
| Trace link | Hide for the first release | Developer mode only. |
| Allow once, trust, trust-server, trust-rule and Deny | Simplify | The toast's up to five buttons become the card's shape: Deny, Allow once, and the offered session grants in one "Allow for this session" menu. |
| Context ring and phone "Conversation stats" | Simplify | Three places become the ring popover plus the Usage tab. |
| Chat inventory (dock ⋯, phone), Changed files (N), Task context | Simplify | Merged into the Work tab. |
| Chat settings (gear) and phone "This chat" | Simplify | Merged into the Setup tab. |
| History and Browse turns | Simplify | Was two names. Now "Jump to a turn…". |
| Summarize chat, Dismiss summary, Show dismissed summary | Simplify | Was three actions. Now "Add summary", which toggles to "Hide summary". |
| New Task from this and Stop shaping this Task | Simplify | Was "New Task from this". Now "Turn into Task", with "Stop shaping". |
| Save to Project… | Simplify | Was "Save to Project…". Now "Move to a project…", only for a chat with no project. |
| Continue with another agent… (composer) | Simplify | Was "Continue with another agent…" in the composer. Now "Switch agent…" in the chat menu and Setup. |
| Reset agent context… (composer) | Simplify | Was "Reset agent context…" in the composer. Now "Start fresh context…" in the chat menu, the slash menu and the palette. |
| Copy chat ID and Copy folder path | Simplify | Now a "Copy" submenu with Chat ID and Folder path. |
| Copy session ID | Hide for the first release | Developer mode only. |
| Delegated-task origin (disabled row) | Simplify | Becomes a header subtitle "from <parent chat>". |
| Coordinator actions | Keep | Unchanged. Backend check: the exact set. |
| New chat (header, inbox, sidebar) | Keep | The inbox button is removed. |
| Refresh inbox | Remove | The inbox is live. |
| Move to Left, Right or Bottom, Add pane…, Restore size, Full screen, Switch to a pane | Remove | Removed from the chat menu. They become dock layout controls on the dock handle or window controls. |
| Clear project scope | Simplify | Becomes an inbox filter chip. |
| Open project | Simplify | Becomes the project crumb in the toolbar. |
| Inbox and Browse all conversations (phone) | Simplify | Merged into a back arrow to the inbox in the phone header. |
| Open chat… ⌘O | Keep | Keyboard and palette. |
| Attach files and Voice | Keep | Visible composer icons. |
| Reference chat… and @ files | Simplify | Was two entries. Now "Mention a file or chat" (@). |
| Commands launcher (⌘⇧L) | Keep | Shown as "Commands (/)" in the composer + menu. |
| Saved drafts | Keep | Moved into the composer + menu. |
| Open terminal, Open in Coding, Delegate… | Keep | In the composer + menu under "Work in this project". |
| Model and effort pill | Keep | Visible. |
| Approval chip | Keep | Only for engines with a native control. |
| Send, Stop, Queue and Steer | Keep | Visible. |
| Clear message | Keep | An icon when there is text. |
| /compact | Hide for the first release | Behind the context-compaction preview. Shown as "Compact now…" under Usage. |
| /stats | Simplify | Was "/stats". Now "/usage", which opens the Usage tab. The old name stays as a hidden alias. |
| /mcp | Simplify | Was "/mcp". Now "/tools", which opens Setup › Tool servers. The old name stays as a hidden alias. |
| /model, /commands, /help and /resume | Keep | Kept. /help stays as an alias of /commands. |
| Row-details hover card | Keep | Becomes a long-press sheet header on a phone. |
| Event replay (settings toggle) | Hide for the first release | Developer mode only. |
| By-model bars on a Claude Code chat | Remove | Dropped for outside engines, not marked. Even a new per-turn source would be approximate for Claude Code. |
| Settle, Reopen, Dismiss from inbox and Hide from inbox | Simplify | Was four verbs. Now "Mark done", and "Reopen" undoes it. This is shared with the inbox design. |
| Snooze and Unsnooze (two preset lists) | Simplify | Was two preset lists. Now one "Snooze ▸" list (In 1 hour, This evening, Tomorrow morning, Next week) and "Wake now". |
| Close chat | Keep | Stays as "Close chat" ⌘W, on the open chat only. It is no longer on the inbox row. |
| Open chat (inbox row) | Keep | The first item in the row menu, as in the inbox design. |
| Restore to inbox | Simplify | Was "Restore to inbox". Now "Reopen" on a done item, merged into Reopen. |
| Discard unsent draft and Discard draft | Simplify | Was two names. Now "Discard draft", with undo. Backend check: whether undo exists. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Action renames: New chat from here, Add to Task, Rewind chat to here, Restore files to here, Start fresh context, Close, Discard draft, Jump to a turn, Turn into Task, Switch agent | copy | Wording only. |
| Undo sub-lines, Usage, Work and Setup labels, plain bucket names | copy |  |
| "Not reported" wherever a value is absent | copy | Fixes the zeros shown today. |
| Slash renames with aliases | copy |  |
| Details panel with three tabs | layout | Moves existing components: stats sections, inventory groups, chat settings rows and aside rows. |
| Answer footer without the Basis chip when unassessed | layout |  |
| Composer + menu reduced | layout |  |
| Chat ⋯ menu reorganised, dock layout actions moved out | layout |  |
| Phone Actions sheet replaced by the same chat ⋯ sheet | layout |  |
| Ring popover, and the ring showing its percentage | new screen state |  |
| Ranked bars, segmented bars, tooltip and table toggle | new screen state | Chart components. |
| Scope switch Whole chat and This answer | new screen state |  |
| Restore-files confirm with a keep and change list | new screen state |  |
| Palette "This chat" group | new screen state | UI only. |
| Whole-chat changed-files union | new screen state | UI aggregation of each turn's changed files. Checkpoints marked unavailable need a backend check. |
| Account meters in chat | new screen state | Wires the existing account usage data to the chat's connection. |
| Setup rows with read-only reasons | new screen state |  |
| /new starts a new chat | new screen state | A behaviour fix: wire the command to the existing New chat action. |
| /clear removed; /fresh opens the existing reset dialog with "Start fresh" preselected | copy | A behaviour fix. |
| Per-turn token series for one conversation | server work | Only for the not-v1 chart. |
| Optional tool so "how much context is left?" works from chat | chat tool | Optional, not required for v1. |
| Who may see usage left in chat | backend check first | It needs credential-management permission. |
| Codex context window (ring for Codex) | backend check first |  |
| Goal activation from Station, and what Codex does at the budget limit | backend check first | Today a Station-set goal stays paused. What Codex does at the limit is an assumption to confirm. |
| Which engines report only turns and tool calls | backend check first | Goose is only an example. |
| Relay chat "Open on Build Box" | backend check first | Wording and whether it can deep-link. |
| Whether Discard draft has undo | backend check first |  |
| Coordinator action set | backend check first |  |
| Delegated-task "not in total" meaning in the usage tree | backend check first |  |
| Whether a model change mid-chat applies from the next message for every engine | backend check first |  |
| Segment record per conversation | server work | Engine, provider, account, model, first and last turn, tokens and cost per unit. Needed for the later usage version and the turn ribbon. |
| Receipts or segments exposed per chat | server work |  |
| Context report tagged with its session, or a reset marker at a switch | server work | Small. Needed for the "Waiting for Codex" state. |
| "Waiting for" state and the window-match check | new screen state |  |
| Transcript markers for a model change, a fresh context and an engine switch | new screen state | Drawn from per-turn model, the recorded context boundary and the lineage. |
| Turn ribbon and per-stretch token split | new screen state | After segments exist. |
| Per-provider token sums in the usage tree | backend check first | The v1 per-engine rows depend on it. |
| Handed-over size on an engine switch | backend check first | The copy says about 8K from the default. |
| Whether an account change on the same engine should also start a new stretch | backend check first | Recommended: yes, since the account owns the limits. |
| Switch agent confirm lists | copy | Also layout. |

## Decisions taken during design

- No engine lets you change the account for one chat; the account in use applies to every chat on that engine. Setup shows it read-only with a link to Customize › Engines.
- Considered: treating `/clear` as resetting the agent. The code shows `/clear` and `/new` only empty the message list on screen. Decided: `/clear` is removed, `/new` really starts a new chat, and `/fresh` opens the reset dialog.
- Today's stats show 0 for figures the engine never reported. That is listed as a defect: an unreported figure reads "Not reported".
- Only Codex has a goal with a token budget, and Codex enforces it. The Goal section is specified on a Codex chat, not on Claude Code.
- "Chat inventory" becomes the Work tab and "Basis" becomes "About this answer", with a chip only on assessed answers. Both change glossary terms. Decided by the owner on 2026-11-21; the slices that rename them (4.7 and 4.8) amend the glossary.
- A model change on one engine does not start a new stretch; one total stays honest.
- By model is dropped for outside engines, not promised. Claude Code may record the model it launched with, so even new data would give approximate bars.
