# First-release design: Agents, Skills and Tools

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

Agents, Skills and Tools become items in the Customize page. An agent is one object built from instructions, skills and tools, and its sections are tabs.

## What is wrong today

- The agent list is mostly engines. "AI APPS" lists ten engines as agents, nine of them READY, including ones never signed in. The user's own agents come after them.
- The agent editor is one form about 2,900px tall: Basics, a radio list of ten engines, a model block that shows Region, Temperature and Steps for every engine, Instructions, Skills and tools, and "Delegated-child denials (9 built-in)". Create stays disabled until there are instructions, and the rule is unclear.
- Nothing explains what an agent is made of. Skills, tools and the model look like unrelated form sections, and the tool picker lists servers with a bare "Add" and no status.
- Five places pick tools or skills: the agent editor's tool picker, its "+ new / + Add" skills, Registry › Skills and Integrations, Connections › Tools, and Project settings › Tools and Agents.
- Skills has two entry points and three vocabularies: a Skills tab, a Commands tab, a "Commands only" filter that does the same thing, "Import .md" and "Browse Registry Skills". A command is only a skill with a command word. "Integration" means three things, and tools are called "tool server", "integration" and "Server" in different places.
- The Tools editor is broken in ways people hit. "Add tool server" inherits the previous server's fields. "Advanced: Secret bindings" covers the editor so Save, Enable and Delete cannot be clicked. Raw transport error text is shown, Enable gives no feedback, and nothing says which agents use a server.
- Project Agents is a wall of 11 checked boxes, and Project Tools holds a single "Use Knowledge" switch beside an "Add tools" button.
- Some actions are unsafe or silent. The editor's "+ new" skill button abandons the unsaved agent with no warning. Registry skill Install and Remove act instantly with no confirm. Required-field errors are silent on Create agent and Create skill. The Agents list says Station Assistant is "Not set up" while it is Home's working default. The Registry itself is hidden behind six overlapping tabs.

## Agreed structure

- Agents, Skills and Tools are items in the Customize page's grouped left list: Your agents (Agents, Skills) and What they can reach (Tools). Each one can be pinned to the sidebar.
- Customize › Agents is a list (yours first, then "Ready-made", one per set-up engine), then an agent page. The agent's sections are tabs across the top: Overview, Instructions, Skills, Tools, Runs on, Permissions, Advanced. A "New agent" dialog asks for a name only. Agents has no Browse in v1.
- "Available in" shows on the agent's Overview and is edited under Permissions. On a phone the tabs become a list of rows that push one page each.
- Customize › Skills has two tabs. Your skills is a list beside a detail view, with chips All, Written by you, Added from Browse, From apps, Has a command. Browse is the shared catalogue filtered to skills, shown in place. Apps › Discover is the full catalogue.
- "New skill" offers Write one, Import a .md file, Import from Codex… and Browse published skills. The Commands tab goes away, and the command word is a field on the skill.
- Customize › Tools shows a list with honest status and "Used by", a server page, and one "Add tool server" dialog with "From the list" (the same catalogue filtered to tool servers) and "Your own".
- The relationship is shown once, on the agent's Overview ("What PR reviewer is made of"). The agent's Skills and Tools tabs are the only places a skill or tool is attached to an agent. The Skills and Tools pages link back through "Used by".
- Chat can create and edit agents (with an approval card) and propose tool servers. It navigates to the setup and the person completes the secret step.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| Create an agent | 5+ clicks and a scroll (Customize dialog or Cmd-K, Agents, New agent, pick a starting point, long form, Create) | 4 (Customize, Agents, New agent, name, Create), or 3 when Agents is pinned |
| Give an agent a tool server | 5 clicks and a scroll (Agents, agent, scroll, Add tools, Add, Save) | 5 (Customize, Agents, agent, Tools, Add tool server, pick) |
| See which agents use a tool server | Impossible | 2 (Customize, Tools) |
| Add a skill from the catalogue | 4 to 5, on a separate hidden page (Customize, Skills, Browse Registry Skills, card, Install to workspace) | 4 (Customize, Skills, Browse, pick, Add to my skills) |
| Add GitHub tools | No path from Tools to the catalogue (Connections, Tools, Registry, Integrations …) | 3 (Customize, Tools, Add tool server, GitHub) |

## Screens

### `agents-skills-tools-01` Agents list

On a phone: A "‹ Customize" back link, then list rows with "Runs on" as one truncated line, and "New" next to the title.

1. **A one-line definition of an Agent: instructions plus skills plus tools, running on an engine, provider, account and model.** The old screen never says what an agent is. This uses the agreed vocabulary. _(copy; slice 5.1)_
2. **Your agents come first, with a "Runs on" column showing engine, provider and model.** Today the engines bury the user's own agents. _(layout; slice 5.1)_
3. **"Linear needs sign-in" appears under the agent.** It is worked out from the agent's tool servers and the server's check state. It surfaces a broken dependency before a run fails. _(new screen state; slice 5.1)_
4. **Engines are shown as "Ready-made", with the same honest statuses as Customize › Engines.** Station Assistant reads "Ready" with its real route, which fixes the "Not set up" contradiction. There is no blanket READY. _(copy, layout; slice 5.1)_
5. **A ready-made agent offers "Copy to customize".** Station's engine agents are editable, so this is a shortcut, not a lock. _(copy; slice 5.1)_

### `agents-skills-tools-02` Agent overview

On a phone: The tabs become a list of section rows, each pushing its own page. Duplicate and Chat are pinned at the bottom.

1. **Section tabs replace the single 2,900px form.** They are tabs rather than a second left list, because the Customize list already owns the left edge. _(layout; slice 5.2)_
2. **A "What PR reviewer is made of" diagram.** It draws agent, instructions, skills and tools once, so a first-time user can tell the three apart. _(layout; slice 5.2)_
3. **A "Runs on" strip shows engine, provider and account, model, and the week's usage.** An agent can pin an account. The meter appears only for Claude and Codex subscriptions. _(layout; slice 5.2)_
4. **"Where it's used": Available in, Automations, and Who can use it.** The Automations list needs a lookup from automation to agent, which needs a backend check. _(server work, backend check first; slice 5.2)_

### `agents-skills-tools-03` Agent: Tools tab

On a phone: A pushed page with "Add tool server" pinned at the bottom. The "Keep / Use only these" control goes full width.

1. **Each tool server is a card with its live status and an "Ask me first / Run without asking" select. "Choose tools" opens per-tool exceptions.** _(layout; slice 5.3)_
2. **"Claude Code's own tool servers: Keep them / Use only these".** It says honestly that Station cannot see them. _(copy; slice 5.3)_
3. **The Browser tools switch.** _(layout; slice 5.3)_
4. **"Add and sign in to servers in Customize › Tools" links to the place that owns the server.** A tool server is added and signed in once, in one place. An agent only chooses whether to use it. _(copy; slice 5.3)_

### `agents-skills-tools-03b` Agent: Skills tab

On a phone: A pushed page with "Add skill" pinned at the bottom.

1. **Skills are rows with origin tags and run counts labelled "all agents".** Run counts are Station-wide, so they are not shown as per-agent. "Add skill" here picks from existing skills, and writing a new one happens in Customize › Skills. _(layout; slice 5.3)_
2. **"Every agent also gets commit-style".** It makes visible that a skill can be offered to every agent. _(layout; slice 5.3)_
3. **Explicit Save and Discard with an unsaved count.** Today there is one Save for a 2,900px form. _(layout; slice 5.3)_

### `agents-skills-tools-04` Create an agent

On a phone: A full-screen step with the primary action pinned at the bottom. Required-field errors use the visible red pattern, not today's silently disabled button.

1. **Only Name is required. "What should it do?" is optional, with "Draft it for me".** Backend check: creating an agent accepts empty instructions, since the seeded Station agent has an empty prompt. _(backend check first; slice 5.4)_
2. **"Runs on: Same as new chats", with a Change button.** This depends on a saved default, which does not exist today. Until then, prefill from the first runnable agent. _(server work, new screen state; slice 5.4)_
3. **"Start from: Blank / Copy an agent" replaces the three starting cards.** _(layout; slice 5.4)_
4. **"Runs on › Change" opens the provider and account picker from Customize › Engines, and the model picker, plus "Use the engine's account".** An agent can pin its own account, unlike the engine setting, which changes every chat. _(layout; slice 5.4)_

### `agents-skills-tools-05` Skills list

On a phone: A "‹ Customize" back link and the list only. A tap pushes the skill detail.

1. **Filter chips replace the Skills and Commands tabs and the "Commands only" button.** Today the same list exists twice. _(layout; slice 5.5)_
2. **The "New skill ▾" menu: Write one, Import a .md file, Import from Codex…, Browse published skills.** It is the single entry point, replacing New skill, Import .md and Browse Registry Skills. Import from Codex opens the first-run dialog. _(layout; slice 5.5)_
3. **A stats line shows runs, worked or did not, last run and size.** The data exists. Size is the length of the skill text. _(copy; slice 5.5)_
4. **"Readable / Source" switch.** _(layout; slice 5.5)_
5. **An About column: Command, You'll provide, Offered to, Used by, Created.** "Used by" is new and derived from agents' skills. _(new screen state; slice 5.5)_

### `agents-skills-tools-06` Skill detail (phone)

On a phone: This screen is phone only.

1. **The pushed skill detail, with Edit and Use pinned at the bottom.** This screen is phone only. _(layout; slice 5.5)_

### `agents-skills-tools-07` Browse skills

On a phone: Your skills and Browse are a segmented control under the title. A tap pushes the preview.

1. **A Browse tab inside Skills: the shared catalogue filtered to skills, shown in place.** It is the only way to browse skills. _(layout; slice 5.5)_
2. **A list beside a preview, with "Added" marks.** _(layout; slice 5.5)_
3. **"Add to my skills" sits on the preview, after you have read it.** Today Install acts instantly. Remove now asks first. _(layout; slice 5.5)_
4. **"Adding it doesn't give it to any agent yet."** Installing a skill does not attach it to an agent, and the screen says so. A line notes it is the same catalogue as Apps › Discover. _(copy; slice 5.5)_

### `agents-skills-tools-08` Tool servers

On a phone: A "‹ Customize" back link, grouped list rows and a full-width Add button.

1. **A strip showing a tool server reaching the agents you add it to, and then their chats.** The claim "changes reach a chat on its next message, nothing restarts" needs a backend check. _(layout, backend check first; slice 5.7)_
2. **Status uses the existing wording: Connected · N tools, Needs attention, Turned off, Not checked yet.** "Needs sign-in" needs the check error classified, which needs a backend check. _(copy, backend check first; slice 5.7)_
3. **"Used by" lists the agents that use each server.** It is derived from every agent's tool servers. UI only. Nothing says this today. _(new screen state; slice 5.7)_
4. **One row action per state: Sign in, Check now, Turn on.** This replaces the global Apply and Restart. _(layout; slice 5.7)_
5. **A "Built into Station" group that can be turned off but not removed.** This is the existing behaviour. _(copy; slice 5.7)_

### `agents-skills-tools-09` Tool server detail

On a phone: "Used by" moves above "Tools it provides". Actions go full width.

1. **"Tools it provides", from the server's own names, with tools that are turned off struck through.** _(layout; slice 5.7)_
2. **"Sign-in and secrets" is an inline card, not an overlay.** Today the overlay covers Save, Enable and Delete. Secret bindings use the environment, Keychain and 1Password backends. _(layout; slice 5.7)_
3. **Raw JSON, address, trust and layout rendering sit behind "Advanced".** Plain words first. Raw settings stay available for someone who wants them. _(layout; slice 5.7)_
4. **"Used by", with each agent's ask or auto posture and "Add to agent".** _(new screen state; slice 5.7)_
5. **Provenance: "From Station's checked list".** _(layout; slice 5.7)_

### `agents-skills-tools-10` Add tool server: from the list

On a phone: The chosen entry is pushed as a full-screen step list.

1. **The catalogue, filtered to tool servers, shows honest qualification labels.** The labels are "Checked by Station" (qualified), "Needs your own sign-in app" (setup required) and "Not checked by Station" (unqualified). _(copy; slice 5.8)_
2. **GitHub's real constraint in plain words: no dynamic registration, and a token cannot be stored for a remote server yet.** _(copy; slice 5.8)_
3. **Secure fields with a Keychain note.** The OAuth client section exists today. _(layout; slice 5.8)_
4. **"Give it to agents" step.** _(new screen state; slice 5.8)_

### `agents-skills-tools-11` Add tool server: your own

On a phone: The same pieces stacked, with "Add and check" pinned.

1. **"Paste a config / Fill in a form".** _(layout; slice 5.8)_
2. **A pasted secret is pulled out of the text and moved to a secure field.** Secrets never land in config text. UI only parsing. _(new screen state; slice 5.8)_
3. **A trust notice for programs that run locally.** A local tool server is a program that runs on your computer with your access. _(copy; slice 5.8)_
4. **"Starts turned off. Station checks it, then you choose agents."** Today's "Disabled until you explicitly enable it" gains feedback. _(copy; slice 5.8)_

### `agents-skills-tools-12` Chat: make an agent

On a phone: Transcript only, with a compact approval card.

1. **Read tools run first: list agents, list skills, list integrations.** _(unclassified; not in the first release)_
2. **A "Create an agent" approval card.** Creating an agent needs a person to confirm. _(layout; not in the first release)_
3. **"Edit first" opens Customize › Agents prefilled.** Needs the navigate action to carry a prefill payload. _(chat tool; not in the first release)_

### `agents-skills-tools-13` Chat: add GitHub tools

On a phone: The same, with the waiting line wrapping.

1. **The agent finds GitHub in the catalogue, then opens the Customize › Tools setup. It does not install anything.** Installing and creating tool servers are person-only actions. _(unclassified; not in the first release)_
2. **"Waiting for you to finish".** Needs a way to tell the chat that setup completed, such as an event or a poll. _(chat tool; not in the first release)_
3. **The follow-up approval "Give PR reviewer the GitHub tools" is shown as pending.** It uses the existing update-agent action. _(layout; not in the first release)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Agent object (single) | Keep | One object bound to engine, provider and account, and model. No Bots. |
| Engine agents ("AI APPS") | Simplify | Become "Ready-made", listed after the user's agents, with honest status. |
| Agent editor long form | Simplify | Section tabs inside Customize › Agents, with one Save per agent. |
| Engine radio list (10 options) | Simplify | A "Runs on" picker shared with Customize › Engines. |
| Temperature, Longest reply, Steps and Region | Hide for the first release | Behind Advanced. They are Station-engine-only knobs shown for every engine. |
| Advanced: agent ID | Hide for the first release | Behind Advanced. Rarely needed. |
| Unattended approvals | Keep | Kept in Permissions. A real safety control. |
| Delegated-child denials (9 built-in) | Hide for the first release | Behind Permissions › Advanced. Expert-only, and the built-ins are not editable. |
| Workflow files | Hide for the first release | Depends on a feature that is not installable yet. |
| Per-agent slash commands | Hide for the first release | They duplicate skill command words. |
| Agent "who can use it" setting | Keep | Read-only on Overview and edited under Available in. |
| Skills page | Keep | The route is renamed from /guidance to /skills. |
| Commands tab | Remove | It is the same object as a skill with a command word. A "Has a command" filter replaces it. |
| "Commands only" filter | Simplify | Becomes a chip. |
| Import .md | Keep | Under "New skill". |
| Registry › Skills | Simplify | Becomes Customize › Skills › Browse. One catalogue, entered from where you are. |
| Registry › Integrations | Simplify | Becomes Customize › Tools › Add tool server › From the list. One catalogue, filtered in place. |
| Registry › Agents and Agents › Browse | Simplify | No Browse tab in Agents for v1: on a fresh install the catalogue is empty beside "Manage sources (6)", and agents arrive inside apps. The agent catalogue stays a page of its own, and Agents links to it only while a source the person added supplies agent entries. |
| Registry › Plugins, Layouts and Kits | Simplify | Out of scope here. Apps › Discover owns them. |
| Registry sources | Keep | Behind "Sources…" in Skills › Browse and Add tool server. |
| Tools tab | Keep | Now the Customize › Tools page. |
| Tool server Form and Raw JSON | Keep | Raw JSON moves behind Advanced. |
| Secret bindings | Keep | Inline, which fixes the covered editor. |
| Trust review and content trust | Keep | Behind Advanced, plus a notice when adding. |
| OAuth client | Keep | Shown as "Sign-in and secrets". |
| Layout rendering switch | Hide for the first release | Behind Advanced. |
| Delivered tools toggles | Keep | Shown as "Choose tools". |
| Agent tool picker | Simplify | Replaced by the agent's Tools section: server cards with status and an ask or auto posture. |
| Project › Agents (checkbox wall) | Simplify | Becomes "Available in" on each agent plus the project's default agent. |
| Project › Tools | Remove | Removed as a section. "Use Knowledge" moves to Project knowledge, and tools attach to agents. |
| Import Codex prompts as skills | Keep | Kept as "New skill › Import from Codex…". One entry point. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Definitions, statuses, Ready-made and all relabels | copy | Wording only. |
| Agent section tabs, list beside detail, catalogue dialogs, mobile push navigation | layout |  |
| "Used by" for tools and skills | new screen state | Derived from existing data. |
| Agent "X needs sign-in" | new screen state | Derived from existing data. |
| "Give it to agents" step | new screen state |  |
| Secret extraction on paste | new screen state | UI-only parsing. |
| Prefilled "Edit first" | new screen state | Also needs the navigate action to carry a prefill. |
| Empty instructions on create | backend check first | Confirm creating an agent accepts them. |
| Automations that reference an agent | backend check first | Needs a lookup from automation to agent. |
| Classifying check errors as "Needs sign-in" | backend check first |  |
| "Changes reach a chat on its next message" | backend check first | Confirm nothing restarts. |
| Built-in servers for non-Station agents | backend check first | Confirm whether they get the built-in servers by default. Today only the Station agent does. |
| Saved default for "Same as new chats" | server work | New saved data. Needs a backend check. |
| OAuth renewal copy on the tool server page | backend check first |  |
| Chat wait or notification when a tool server setup finishes | chat tool | New. |
| Propose a tool server from chat | chat tool | New tool. The propose then person-completes pattern exists only for apps. |
| Create a skill from chat | chat tool | New tool. Only update and install skill are callable by agents today. Confirm whether the save upserts. |
| Navigate with a prefill payload | chat tool | New. |

## Decisions taken during design

- One Agent object and no Bots, because Station has no per-agent memory, and scheduling is already Automations.
- No Browse tab in Agents for v1, and the tool-server catalogue stays inside Add tool server.
- Creating an agent from a name alone needs the server to accept empty instructions. That is a backend check for slice 5.4.
- Agents, Skills and Tools are items in the Customize page. The agent page's own sections became tabs, because two left lists left the content about 650px wide.
