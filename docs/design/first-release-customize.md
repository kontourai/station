# First-release design: Customize: engines, providers and knowledge

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

Engines, Providers and Knowledge become items in the Customize page, and the old Connections destination goes away.

## What is wrong today

- Connections has no page of its own. It redirects to a tab, so nobody can answer "what can this Station run right now" in one place.
- Every tab is a narrow list beside a big "Nothing selected" box. Models repeats its list in a right-hand card.
- Nine engines read READY, including ones with no sign-in check. READY only means the program was found, plus a check where one exists.
- The Models tab lists connections, not models, and "Model connection" is a noun nobody uses outside Station.
- Creating an empty OpenAI-compatible connection saves a junk entry. The picker has two search boxes, and a generic form says "OpenAI requires an API key". A failed connection is also offered as a proxy and auto-picked as the embedding model.
- "Connect through" is a bare list of every OpenAI-compatible connection with no format check, so Claude Code can be pointed at an endpoint that cannot answer it.
- Add engine is a 6000px catalogue with duplicates and dozens of "Unavailable" rows, and it drops the tab rail.
- Computers mixes pairing, peer Stations, SSH and broker routes under one noun with five names. "Add knowledge source" sends you to Settings. Raw transport errors and command-line flags appear in user-facing copy.

## Agreed structure

- Connections no longer exists as a destination. Its parts are items in the Customize page: Engines and Providers under "What they run on", Tools and Knowledge under "What they can reach". The old Connections overview becomes the Customize landing.
- Engines are grouped as What can run now, Needs attention, Installed with sign-in not checked, and Found on this Mac. "What can run now" leads the page: engine, provider and account, what is left, status, with the "New chats start on …" line under it.
- Engine detail shows Runs through (provider and account), the in-use account's limits, an "About <engine>" summary of features and safety notes, and a details aside.
- Providers replaces Models, in two groups: Subscriptions (signed in through an engine, with accounts and limits) and Keys and local models (kept by Station, one key or address each).
- Add provider is a catalogue grouped by service, then key or sign-in, then a check, then "use it for". Nothing is saved until the check passes.
- Tools is covered in the Agents, Skills and Tools area.
- Knowledge has one status ("Agents can search your files: On or Off"), the search model, what gets searched, and storage under Advanced. It has no add button.
- Devices left this area. Devices with access, People, Other Stations and saved Stations are on the Station page. SSH computers and broker routes are hidden for v1.
- On a fresh install the Customize landing says "Ready to go. Nothing needs you." and shows the six items as cards with one next step each.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| See whether Claude Code is signed in and how much is left | 4 (Customize, Connections, Engines row, scroll) | 0 from the Home line, or 1 from the Customize landing |
| Fix a rejected key | 4+ (find the dot, Models, row, edit) | 2 (Customize, Update key on the card), or 1 when Providers is pinned |
| Add a Z.AI coding plan | 6+, and you must know the base URL (Models, Add, OpenAI-compatible, fill URL) | 4 (Customize, Providers, Add provider, Z.AI Coding Plan), then paste, or ask in chat |
| Route Claude Code through CLIProxy | 5 (Customize, Connections, Engines, Claude Code, Connect through) | 4 (Customize, Engines, Claude Code, picker), or 1 from the CLIProxy page |
| Pair a phone | 4 (Customize, Connections, Computers, Add a computer, option) | 2 (Station menu in the header, Connect a device) |

## Screens

### `customize-02` Providers

On a phone: Rows stack with "Used by ·" labels. Chevrons are dropped and the whole row taps.

1. **A Subscriptions group with the sentence "The engine owns the sign-in; Station reads what's left".** Accounts exist only for Claude Code, Codex and Muse sign-ins. The copy states that limit so the UI does not promise control it lacks. _(copy, layout; slice 2.11)_
2. **One bar per account, never summed.** Usage is shown per provider and account pair. _(layout; slice 2.11)_
3. **A Keys and local models group: "1 key", "localhost · 1 key", "This Mac · no key needed".** A Station-managed connection holds exactly one key. No accounts were invented under it. _(layout; slice 2.11)_
4. **CLIProxy carries a Proxy tag and Ollama a Local tag.** Proxy providers are labelled as proxies. _(copy; slice 2.11)_
5. **The Z.AI row's primary action is the fix, not a chevron.** A row that needs attention should offer its fix, not a way to go and look for it. _(layout; slice 2.11)_
6. **Footer sentence: Station only switches accounts if you turn it on.** The opt-in recovery exists and is off by default. There is no silent failover. _(copy; slice 2.11)_

### `customize-03` Subscription provider

On a phone: Account blocks become one column: name, then each meter at full width.

1. **Accounts are the main content, with both provider-reported windows ("5-hour limit", "Weekly limit") and reset times.** The data already exists as used percent, reset time and label. _(layout; slice 2.12)_
2. **An "In use by Claude Code" tag, and a "Use for Claude Code" button.** This wraps the existing apply action, which today is reachable only from the chat's usage-limit banner. New placement, existing endpoint. _(layout; slice 2.12)_
3. **Footer copy: switching affects every Claude Code chat, and Claude reports the numbers.** Existing behaviour, now stated. _(copy; slice 2.12)_
4. **Models show the canonical name first and the engine's own id small.** Needs a new model catalogue on the server. _(server work; not in the first release)_
5. **"When an account runs out: Ask me / Automatically".** Surfaces the existing opt-in recovery, off by default, as a visible setting. _(new screen state; slice 2.12)_
6. **No budget control is drawn.** None exists. Budgets would be new server work and are kept out of v1 screens. _(unclassified; slice 2.12)_

### `customize-04` Proxy provider

On a phone: The engine and format table becomes stacked rows. Aside cards move below.

1. **"Engines that can use it", with the format each engine needs and whether the proxy answers it.** Claude Code needs Anthropic Messages and Codex needs Responses. Station does no translation and nothing checks the format today. Needs a format check on the server. _(server work; slice 2.10)_
2. **"Route Claude Code here", offered only after the format check passes.** The proxy route exists. The gate is new. _(server work, new screen state; slice 2.10)_
3. **The OpenCode row says Station cannot route it.** Routing exists for Claude Code and Codex only. _(copy; slice 2.10)_
4. **"What's left: Not visible to Station", with the reason.** An empty meter says nothing. A stated reason does. _(copy; slice 2.12)_
5. **"Sent, last 7 days: 1.8M tokens" and "Cost: Not priced".** Tokens per model connection are already counted with no UI. Prices exist only for Bedrock. _(new screen state; slice 2.12)_
6. **Models show canonical names and raw ids. An Unrecognised group lists names as the proxy gives them.** Needs the new model catalogue. Unknown ids are never guessed. _(server work; not in the first release)_

### `customize-05` Local provider (Ollama)

On a phone: Rows are labelled (Kind · Used by · Size).

1. **Models are listed with their kind (Chat or Embedding) and what uses each.** Model role is the only other classification. _(layout; slice 2.12)_
2. **Canonical name without version ("Qwen Coder", "Llama", "Gemma"), the Ollama tag and the quantization as an attribute.** Embedding models Station does not recognise, such as nomic-embed-text, appear as Unrecognised. _(server work; not in the first release)_
3. **Model sizes.** Ollama reports sizes. We have not confirmed that Station stores them. _(backend check first; slice 2.12)_
4. **Usage tiles: tokens, "Free · runs locally", and pieces indexed.** Tokens are existing data with a new UI. Indexed counts come from the existing knowledge status. _(new screen state; slice 2.12)_

### `customize-06` Provider needs attention

1. **One notice names the failure, its impact ("chats on Station that use GLM will stop") and the fix.** Today raw errors lead and the fix is hard to find. _(copy, layout; slice 2.13)_
2. **The fix is inline: paste a new key, then "Save and check".** Today you must find the row and edit a long form. _(new screen state; slice 2.13)_
3. **"What uses it", with a "Will fail" pill.** The list of chats and automations that picked the model is not built yet and needs a backend check. _(backend check first; slice 2.13)_
4. **Raw HTTP and JSON are collapsed under "Technical detail".** Plain words first. _(copy; slice 2.13)_

### `customize-07` Add provider: pick a service

On a phone: One column. Steps collapse to numbered dots with only the current label.

1. **The three steps are named in plain words.** Today's "Choose, Connect, Ready" line is kept and renamed. _(copy; slice 2.14)_
2. **One search box.** Today the picker has two. _(layout; slice 2.14)_
3. **Grouped by service. "Claude subscription" and "Claude API" sit side by side as two ways into Anthropic.** Auth is part of the provider, so a subscription and an API key are two providers under one service. _(layout; slice 2.14)_
4. **Ways already added show "Added · 2 accounts" instead of being offered again.** _(layout; slice 2.14)_
5. **Z.AI Coding Plan and Z.AI API presets.** No Z.AI preset exists in the catalogue today. It is copy and config only. _(copy; slice 2.14)_
6. **"8 more" collapses the long tail of OpenAI-compatible presets. "Proxy or gateway" and "custom endpoint" are separate, plainly named exits.** Today's catalogue lists every preset at the same weight. _(layout; slice 2.14)_

### `customize-08` Add provider: paste the key

On a phone: The primary action is sticky above the chat dock.

1. **The key field fails with a reason a person can act on ("a Coding Plan key, not a pay-per-use API key").** Validation should explain how to recover. _(copy; slice 2.14)_
2. **"Nothing is saved until the key works."** Today Create saves first and verifies later. The new flow checks, then saves, using the existing test action. _(new screen state; slice 2.14)_
3. **Where to find the key, in three steps.** No documentation needed. _(copy; slice 2.14)_
4. **Address and default model sit behind Advanced.** Plain words first. _(layout; slice 2.14)_

### `customize-09` Add provider: verified

1. **"Verified" states what was proved: answered, listed 2 models, test message sent.** Uses the existing test and smoke checks. _(copy; slice 2.14)_
2. **"Use it for", with one sensible default checked.** Guided where there is a decision. _(layout; slice 2.14)_
3. **Claude Code and OpenCode rows are present but disabled, with the reason.** API format appears only as the reason a pairing is unavailable. _(copy; slice 2.14)_
4. **"Make GLM the default for new chats"** Needs the saved default for new chats. _(server work; slice 2.14)_

### `customize-10` Add provider: custom endpoint

1. **An empty address is refused inline with recovery text. The primary button is disabled with the reason beside it.** Today an empty form saves a broken connection. _(new screen state; slice 2.15)_
2. **API format appears only here, behind Advanced, defaulting to "Detect when I check".** Detecting the format is new and needs a format check on the server. _(server work; slice 2.15)_
3. **"Engines can only be routed through a proxy that has a key."** Station refuses keyless proxies. Say it before, not after. _(copy; slice 2.15)_
4. **Placeholders start with "e.g."** Today placeholders look like real values. _(copy; slice 2.15)_

### `customize-11` Engines list

On a phone: The status pill sits under the title and actions get their own line.

1. **"What can run now" leads the page: engine, provider and account, what is left, status.** It moved here from the deleted Connections overview. _(layout; slice 2.8)_
2. **The "New chats start on …" line sits under it.** Today the default for new chats changes on its own while engines are added, and nothing shows what it is. _(layout; slice 2.8)_
3. **"What can run now" means checked: signed in, or a passed provider check for Station's own engine.** READY today only means the program was found. _(copy; slice 2.8)_
4. **Each working engine shows provider and account, and what is left (Claude Code and Codex only).** The thing you select and meter is provider and account. Station can read what is left only for Claude Code and Codex. _(layout; slice 2.8)_
5. **"5 of 6 features", from the existing capability list.** The six features are system prompt, tool servers, skills, commands, model selection and mid-turn steering. _(layout; slice 2.8)_
6. **"Needs attention", with the observed reason and Retry check or See why.** Today "Troubleshoot" opens a bug report. _(new screen state; slice 2.8)_
7. **"Installed, sign-in not checked" is its own group.** Fixes the nine-engines-READY problem. _(layout; slice 2.8)_
8. **"Found on this Mac" rows with Add.** Today detected engines appear only deep inside Add engine. _(layout; slice 2.8)_

### `customize-12` Engine detail

On a phone: Selects stack and the feature list is one column.

1. **"Runs through": a provider select and an account select.** Merges today's "Connect through" and the view-only account select into one pair. _(layout; slice 2.9)_
2. **A warning that the change affects every Claude Code chat.** This is the existing behaviour of the apply action. _(copy; slice 2.9)_
3. **The in-use account's limits.** The existing account overview, moved up. _(layout; slice 2.9)_
4. **An "About Claude Code · 5 of 6 features · 2 safety notes" disclosure with a feature checklist and two plain safety sentences.** The content comes from Station's own capability summary. Recovery and durability stay one click deeper. _(layout; slice 2.9)_
5. **A details aside: version, sign-in owner, models, last check, and where it is the default.** _(layout; slice 2.9)_
6. **No list of which agent new chats start on is drawn on the engine page.** The owner decided against it. _(unclassified; slice 2.9)_

### `customize-12b` Engine route picker

1. **The picker groups subscription accounts and proxies, plus a disabled "Can't be used by Claude Code" group with reasons.** A picker that knows each engine's API format is new. _(server work, new screen state; slice 2.10)_

### `customize-13` Add engine

1. **"Found on this Mac" comes first, with one-click Add.** There is nothing to install. _(layout; slice 2.16)_
2. **"Install one": Station runs the official install command after you confirm, and shows its output.** Where no host terminal is available, the copyable command is the fallback. Six engines are shown, with "Show 9 more · 4 can't run here, each with the reason". Today the catalogue is 6000px long. _(layout; slice 2.16)_
3. **Custom engine is one card, not a section.** _(layout; slice 2.16)_
4. **The flow stays inside the Customize page.** Today the add flow drops the tab rail. _(layout; slice 2.16)_

### `customize-14` Knowledge

1. **One status: "Agents can search your files · On".** Knowledge setup is spread over four places today. _(layout; slice 2.17)_
2. **Search model, indexed count and last update.** These come from the existing knowledge status. "From 3 projects" needs a backend check. _(layout, backend check first; slice 2.17)_
3. **"What gets searched" links to each project's knowledge and to Settings › your knowledge. There is no "Add knowledge source" button.** Today the button sends you to Settings. _(layout; slice 2.17)_
4. **The vector database sits behind Advanced.** Station's built-in store is the default nobody changes. _(layout; slice 2.17)_

### `customize-17` Chat: add a provider

On a phone: The inbox is hidden, the transcript is full width and the card's buttons wrap.

1. **Plain step lines ("Looked at your providers") with a chevron. The tool name is behind the expand, on desktop and phone.** Plain words first. The tool name is detail for someone who wants it. _(copy; not in the first release)_
2. **A proposal card "Add a provider · Proposed", saying what will happen and who handles the key.** Agents cannot create providers today. The pattern is propose, then the person completes. Needs a new tool that creates the proposal without a secret and opens the guided flow prefilled. _(chat tool; not in the first release)_
3. **It says which engines will not use the provider, and why.** Not every engine can use every provider. Saying so first avoids a provider that is added and then never appears in a picker. _(copy; not in the first release)_
4. **"Nothing changes until you finish."** This follows the existing approvals pattern. _(copy; not in the first release)_

### `customize-18` Chat: secure key entry

On a phone: A bottom sheet.

1. **The key step opens as Station's own dialog over the chat, not in the transcript.** No secrets are typed into chat. _(new screen state; not in the first release)_
2. **It says where it came from and that the agent cannot read the key.** A key is never typed into chat. The field belongs to Station, and the agent learns only that a key was saved. _(copy; not in the first release)_
3. **"Use for Station's engine" carries the proposal's choice and stays editable.** _(new screen state; not in the first release)_

### `customize-19` Chat: diagnose a problem

1. **Plain step lines, with tool names behind the expand.** Needs a new tool so the agent can read an engine's route. The route is visible to the screen today, not to agents. _(chat tool; not in the first release)_
2. **A three-line diagnosis: what failed, what is fine, what is unaffected.** Summarise first, then let people inspect downward. _(copy; not in the first release)_
3. **Two fixes in words, one as a proposal card "Change what Codex runs through".** Needs a new tool that proposes a route change. "Open Codex page" uses the existing navigate action. _(chat tool; not in the first release)_
4. **The finished Z.AI chat sits under "Just finished".** It closes the loop from the add-provider chats. _(layout; not in the first release)_

### `customize-20` Customize landing on a fresh install

1. **"Ready to go. Nothing needs you.", with Start a chat.** Station should work out of the box. _(copy; slice 1.3)_
2. **"New chats start on Claude Code · Opus because it was signed in first. Change"** Needs a saved default. The rule "first one signed in" is a proposal and needs a backend check. _(server work, backend check first; slice 1.3)_
3. **The six Customize items as cards, each saying what is there and the one next step.** The next steps are New agent, Browse skills, Add a provider, Add tool server and Set up search. There is no pre-checked list to opt out of. _(layout; slice 1.3)_
4. **The Customize list shows no attention dots.** Nothing needs the user. _(layout; slice 1.3)_

### `customize-21` Model picker

On a phone: A real bottom sheet over a dimmed composer, titled "Model", with a close button and 44px rows. It scrolls inside.

1. **Each model appears once, with the ways to reach it underneath ("Claude subscription · Personal Max, in Claude Code · 62% left").** Models are named canonically, once. _(server work, new screen state; not in the first release)_
2. **Unavailable ways stay visible, with the reason ("key rejected").** Hiding a broken way to reach a model would leave you wondering where it went. _(copy; not in the first release)_
3. **A local model shows "Ollama · 4-bit" as the way, not as a separate model name.** One model has one name, however many providers serve it. _(copy; not in the first release)_
4. **Unrecognised ids are collapsed and never guessed.** Station records the name a provider reports and never guesses which model it is. _(layout; not in the first release)_
5. **The footer says: pick a model, then a way. Station starts the engine.** Removes "pick the agent first" from the common path. Needs the model catalogue and a new picker. Today the picker goes agent first, then model. _(server work, new screen state; not in the first release)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Models tab | Simplify | Becomes Providers. It lists connections, not models. |
| Add model connection picker | Simplify | A service-grouped catalogue with one search. Today it has duplicates and two search boxes. |
| Create then verify | Simplify | Becomes verify then save. Today it creates junk connections. |
| Raw JSON toggle | Keep | Under Advanced, for power users. |
| Engines list | Simplify | Four honest groups. Nine READY engines today. |
| Engine detail tab URLs without tabs | Remove | Remove the dead routes, or ship the tabs later. They fall back silently today. |
| Connect through | Simplify | Becomes Runs through (provider and account), format-aware. Merges two controls. |
| Account selector (view-only) | Keep | Made actionable through the existing apply action. |
| Opt-in account switching | Keep | Shown as a visible setting, default Ask. No silent failover. |
| Capability summary | Keep | Reshaped as "About · N of M features · K safety notes". |
| Recovery and delivery details | Keep | One level deeper. Expert detail. |
| Add engine catalogue | Simplify | Found, install six, show more, custom. It is 6000px today. |
| Install offers without installing | Keep | Inherited from the earlier audit's keep list. |
| Knowledge tab | Simplify | One status page with no add button. Setup is in four places and the add button goes to Settings. |
| Developer › Memory | Hide for the first release | An operator concern. |
| Integration status strip | Hide for the first release | A preview. It is not reachable today. |
| Explicit delete confirms | Keep |  |
| Budgets and spend caps | Hide for the first release | None exist. A proposal only, not in v1. |
| The /connections redirect | Remove | Replaced by the Customize landing, which answers "what can run". |
| Computers tab | Simplify | Moves to the Station page. Four relationships under one noun today. |
| Pair a device and Connect a Station | Keep | Real flows, now on the Station page. |
| SSH computers and broker or relay routes | Hide for the first release | Hidden for v1 behind a flag. They are native-only and not demonstrable. |
| Tools tab | Keep | Covered in the Agents, Skills and Tools area. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Providers two-group list | layout | Subscriptions come from engine accounts. The regroup is UI only. |
| Provider detail (subscription) | new screen state | Layout too. The apply action and recovery setting exist. |
| Proxy detail | server work | A new format check. Tokens per model connection are existing data with a new UI. |
| Local provider sizes | backend check first | Confirm Station stores the sizes Ollama reports. |
| Needs-attention "what uses it" | backend check first | The list of chats and automations using a model is not built yet. |
| Add provider catalogue | layout | Layout and copy. The Z.AI presets are new copy and config only. |
| Verify then save | new screen state | Uses the existing test and smoke checks. |
| Custom endpoint format choice | server work | Format detection and storing a format are new. |
| Engines grouping | new screen state | Uses existing engine status and account sign-in state. |
| Runs-through picker | server work | Format-aware filtering is new. Also a new UI state. |
| "N of M features, K safety notes" | layout | Derived from the existing capability list. |
| Add engine | layout | Install runs through the existing install terminal. A copy-the-command fallback exists. |
| Knowledge status page | layout | "From N projects" needs a backend check. |
| Chat proposals | chat tool | New tools: add a provider, read an engine's route, propose a route change. The "Guided engine setup" preview must graduate for the setup-list tool. |
| Secure key dialog from chat | new screen state | Reuses the add flow. |
| Stable default for new chats | server work | New saved data. |
| Model catalogue, picker and canonical lists | server work | Maps a provider type and raw id to a canonical model, at read time. Receipts stay raw. An Unrecognised fallback exists. By-model totals apply only to Station's own engine. Usage on outside engines, including through a proxy, is grouped by engine and provider. |
| Mobile layouts | layout | Today's Connections overflows at phone width. Other current phone behaviour was not verified. |
| Customize landing and frame | new screen state | Composes existing list and health data. The allowance column needs a backend check (admin permission, live call, must be cached and admin-only). |
| Devices | layout | Moved to the Station page. Device naming needs a backend check. |

## Decisions taken during design

- Providers are drawn as two groups, and "Account" is used only for sign-ins. Accepted: accounts exist today only for engine sign-ins; an API-key provider holds one key.
- Station's own engine has no single "Runs through". It picks a provider per model, so its page lists its providers. Accepted.
- Budgets are not drawn. Accepted: nothing stores or enforces a money budget today.
- Usage left needs admin permission and a live call to the provider. People without that permission see "Visible to the Station admin".
- Add engine first said Station only shows the install command. Corrected to today's behaviour: Station runs the official installer after you confirm, with the command as a fallback.
- Usage by model: I first ruled that proxied usage counts toward the model it was named as. The code check showed Station does not reliably know the model per turn for outside engines. Final rule: by-model totals only for Station's own engine; usage on outside engines, including through a proxy, is grouped by engine and provider and always counted.
