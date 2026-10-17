# Agent Development Guide

> **Keep this file minimal.** This is a quick reference that points to detailed docs. Add specifics to the pattern files, not here.

## For AI Coding Assistants

When working on this codebase:

1. **Check pattern docs first** - Review the relevant pattern file before implementing
2. **Follow established patterns** - Use existing patterns rather than inventing new approaches
3. **Update docs when patterns are missing** - Add new patterns to the appropriate file
4. **Ask if unclear** - If a pattern isn't documented and you're unsure, ask before proceeding
5. **No TypeScript shortcuts** - Understand types before fixing errors; don't blindly use `as any`

### Pattern Documentation

| Area | File | When to Read |
|------|------|--------------|
| Frontend | [Frontend Patterns](../patterns/frontend.md) | React, hooks, styling, SDK, plugins |
| Backend | [Backend Patterns](../patterns/backend.md) | Routes, services, Station runtime, routes |

**Update these docs when:**
- You implement a reusable pattern not yet documented
- You discover a pitfall that others should avoid
- You establish a convention for a new area

---

## Agent Configuration

Agents live in `<STATION_HOME>/agents/<slug>/agent.json`. The directory name is the agent's slug.

For full field reference see [docs/reference/config.md](../reference/config.md). Key fields:

| Field | Description |
|-------|-------------|
| `name` | Display name |
| `prompt` | Agent instructions (supports `{{key}}` template variables); delivered as a system prompt where supported, or with the first message on Codex and other first-turn engines |
| `model` | Station-engine model preference; see resolution order below |
| `execution.agentConnectionId` | Saved engine connection binding; absence selects Station's engine |
| `execution.modelConnectionId` | Model connection selection for Station's engine; separate from the engine binding |
| `execution.modelId` | Explicit model preference on that execution binding |
| `tools` | MCP server IDs, allow-list, auto-approve list |
| `guardrails` | `maxSteps`, `maxTokens`, `temperature` |
| `audience` | Who besides the operator may list, read and use the Agent; absent means operator only ([reference](../reference/config.md#audience)) |

### MCP Tool Configuration

The **Tools** section is shared by creating, copying, and editing an Agent.
Choose **Add tools**, search the list, then choose **Add**. The list covers MCP
sources and tool-providing plugins. Engine-native tools use their engine’s
settings. Each row shows its
source: Station, a registry, a plugin, or a connection on this Station. Open a
source for its description and actions. Click an action name for its description;
approval choices sit beside selected actions. **About this source** holds
provenance, Station-wide Project sharing and external connection settings. Click a registry name to browse its tools without leaving
the draft. Catalog browsing retains Project permissions and approval defaults.
**Origin not recorded** means provenance is missing, invalid, or no longer
matches the saved connection; it does not describe connection health.

Personal Board authoring uses three actions from the **Station** source:
`list_personal_boards` and `get_personal_board` are readers;
`propose_personal_board` writes a private proposal. Open the source and select
those actions for an Agent that should build dashboards. Review the proposal
action's approval choice beside its selection. These tools cannot publish:
the person reviews and applies the proposal in the Board. **Build with chat**
offers context in a new projectless chat without sending it; see
[Personal Boards](../user/personal-boards.md).

Station Control publishes native MCP titles, behavioral annotations and
`ai.kontour/tool-group` hints. These catalog hints do not grant access or change
approval rules. MCP has no standard category field; grouping does not require
separate servers.

On Station and Claude, newly added Station-classified reads default to **Always
allow**. Changes, unknown actions and publisher-classified reads default to
**Ask me**. Existing choices remain. Other engines show their supported controls;
explicit Ask rules refuse startup on an engine that cannot deliver them.
**Check for new tools** in source details fetches the current list without
changing selections. **Edit connection** opens the server settings. Built-in
Station sources need neither control. **Include new tools automatically** opts
into actions added later, with Ask protection on Station and Claude.

Operators can add catalog sources or **Connect your own source** without leaving
the Agent draft. Sources that need configuration open setup before attachment.
Tool-providing plugins use the existing package permission review. Catalogs mark
these with `providesTools: true`; this is a browsing hint, not a permission grant.

### Shared Projects

The Station operator installs and connects sources. Project Admins and Owners
can create and edit Project agents and attach permitted installed sources. An
uninstalled source offers **Request**, then **Pending**. The operator handles
requests in the existing Inbox, including connection or plugin consent setup.
Requests survive restarts and become available only when setup succeeds and the
Project still permits the source. Installation approval never widens an Owner's
selected policy.

Project **Tool permissions** defaults to all sources shared by the operator. A
Project Owner can select a smaller list. The operator can withdraw a source from
Projects using **About this source → Share with Projects**. This setting covers
all Projects on the Station; turning it off blocks new Project runs using the
source without uninstalling it. Already-running engines without pre-tool
interception cannot guarantee immediate withdrawal. Station Control remains
operator-only. Installed tools,
Project permissions and personal account sign-in are separate; installing a
source does not share someone's OAuth credentials. Personal tool accounts
require the managed Station engine; external engines cannot deliver that
principal-bound connection and report it as unsupported. Existing instance-level
credentials retain their existing execution semantics.

Open **Profile → My access** to see Station authority and roles across Projects.
Admins and Owners can reach **Agents and tools** there and from their shared
Project. Shared Project pages load Agent management only when it is opened;
viewers and contributors do not load the tool catalog. This authoring surface does not enable member agent execution: member
turns remain refused by the existing execution gate. Computer contribution and
execution authority remain separate requirements. The engine picker includes
managed **Station** alongside installed engines. Station Agents keep no external
engine binding; editing and saving preserves that choice and its tool approvals.

New and recovered sessions both recheck authored tools against current Project
permissions. Missing Agent definitions or unreadable Project policy refuse
engine startup; the conversation stays recoverable after the cause is fixed.

**Browser access** is a separate Agent capability. The current delivery path
connects Claude Code to the Project's Station browser; other engines disclose
that this delivery is unavailable. **Workflow files** holds the workflow editor.
Browser access is independent of attaching MCP sources. See the
[browser and computer capability proposal](../design/agent-interaction-capabilities.md)
for the proposed cross-engine behavior; it is not implemented.
