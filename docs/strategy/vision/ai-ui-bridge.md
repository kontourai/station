# Vision: AI ↔ UI Bridge

> The north star for Station's core differentiator. This document describes
> where we're going, what exists today, what's next, and what's aspirational.
> It evolves as capabilities are built.

*Last updated: 2026-08-27 (rewritten to reflect the MCP Apps host, workspace
panes, and the engine-unified orchestration layer; the original 2026-04 draft
proposed a bespoke UI-block system that Belief 7 of the constitution —
standards over opinions — has since resolved in favor of MCP Apps)*

---

## The Thesis

Most AI tools treat the UI as a display layer and the AI as a backend. Station
treats them as peers. The AI can reshape the workspace. The UI can enrich the
AI. Both share the same primitives — tools, knowledge, agents, project context
— and can invoke each other.

This bidirectional integration is what makes Station a *platform* rather than
a *chat wrapper*. And because every AI→UI action rides the same orchestration
seam as every other agent action, the bridge inherits the trust loop: what the
agent did to the workspace is as inspectable as what it said.

---

## Where We Are Today

### Standards carry the rendering surface

Where the original vision drafted a bespoke `UIBlock` component system, the
constitution's Belief 7 (adopt standards where they exist) decided otherwise:
**MCP Apps is the rendering surface.** Station ships a native MCP Apps host —
on by default (`mcpUiHost`), targeting MCP core `2026-07-28` and the MCP Apps
extension `2026-01-26` — rendering declared interactive UI from installed MCP
integrations in an open, hardened host (ADR-0007). Agents don't return
proprietary block types; integrations declare UI the standard way, and any
MCP-Apps-capable client benefits.

### SDK as the bridge

The `@kontourai/station-sdk` package is the bridge layer. Plugin layouts import
the same hooks and APIs the AI uses: agents, chat, tools, knowledge,
conversations, projects, and layouts.

**UI → AI context flow:** the SDK `contextRegistry` lets layouts register
`MessageContextProvider` implementations that prepend ambient context to
outgoing messages. Chat input supports attachments, snippets, and project
references; Layout Panes seed chat with contextual data.

**AI → platform control:** the `station-control` MCP server exposes agent CRUD,
integration/skill/playbook management, project management, config, scheduler
jobs, navigation, and message sending — an agent with `station-control` can
set up an entire project environment programmatically.

### One orchestration seam under everything

Every interactive caller — the UI composer, `station chat`, queue drain, voice,
playbooks — sends through one seam (`POST /api/orchestration/chat` →
`executeForegroundMessage` → provider adapter), with a unified event model
(`CanonicalRuntimeEvent`) across Station's own engine and external engines
(Claude Code, Codex, ACP-connected CLIs). The bridge is engine-agnostic by
construction: workspace effects and context flow work the same regardless of
which engine is doing the work.

### Workspace panes

Tasks compose bounded workspace panes — file previews, browser previews, and
plugin-contributed surfaces — beside the conversation, with pane lifecycle
owned by the server so pane state is durable and inspectable rather than
ephemeral UI state.

---

## What's Next

- **Richer context capture.** Layouts declaring what's visible (active file,
  selection, terminal tail, current diff) through opt-in SDK exposure hooks,
  and agents requesting bounded snapshots — no ambient surveillance, explicit
  contracts on both sides.
- **Agent-directed workspace composition.** The AI arranging panes for the
  task at hand — a debugging task gets a different composition than a review
  task — drawing from installed plugin components, through the same declared
  pane contracts users compose by hand today.
- **Progress and notification surfaces.** Long-running agent work pushing
  structured progress into the workspace rather than a spinner.

## Long-Term

- **Reactive context flow.** The UI streaming relevant context as the user
  works — scroll to a function, its signature enters context — without
  copy-paste, under per-layout opt-in.
- **Self-improving workspaces.** Combining `station-control` (agents managing
  agents) with composable panes and playbooks: the workspace setup for a task
  class improves as the platform observes which configurations lead to good,
  *gated* outcomes — learning from receipts, not vibes.

---

## Anti-Goals

- **Not arbitrary runtime React.** Rendered UI comes from the MCP Apps host or
  installed plugin components — declared, sandboxed, typed.
- **Not competing with design tools.** Composition is functional workspace
  arrangement, not visual design.
- **Not surveillance.** Context capture is opt-in per layout. Users control
  what's exposed. No keystroke logging, no screen recording, no ambient
  monitoring without explicit layout participation.
- **Not magic.** Every AI→UI action is an explicit tool call; every UI→AI
  context flow is a registered provider. The bridge is transparent and
  debuggable — and because actions ride the orchestration seam, auditable.
