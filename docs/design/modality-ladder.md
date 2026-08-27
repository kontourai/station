# The modality ladder

> Status: design contract, adopted 2026-08-14 (station#2685). Cited in review:
> when a PR introduces or moves a surface, name its rung. Deviations from the
> ladder are design decisions and get a sentence of rationale in the PR body —
> not silent precedent.

## Why this exists

The same kind of task currently gets a different container depending on which
corner of the app it lives in. Creating a project is a full-screen route-modal
(`/projects/new` renders `NewProjectModal` as a route); creating an agent,
skill, tool server, or model provider is an inline pane in a
split-pane page; creating a schedule job, ACP connection, plugin install, or
machine is each a bespoke modal; adding a provider was a modal that navigated
to a page — half modal, half page. Thirty-three
files match `*Modal*.tsx`, and three separate modal-stack aggregators exist
(chat dock, guidance, plugin management). Every one of these was locally
reasonable; collectively they mean a user cannot predict what the app will do
when they click "New", and a contributor cannot predict which primitive to
reach for.

A container is a promise about state: what survives navigation, what the URL
captures, what Escape does, and what happens to half-typed input. The ladder
makes those promises consistent.

## The ladder

Each rung is defined by the promise it makes. Pick the **lowest rung whose
promise the surface actually needs.**

### 1. Page

**Promise: this place has an address.** Anything a user might want to return
to, share, or open from a notification is a page. Sub-state that changes what
the user is looking at (active tab, selected channel, highlighted row) goes in
query params so deep links capture it. A page's content survives app restart
by construction — it re-derives from the URL.

Use for: every top-level destination; any multi-section surface (`?view=` /
`?tab=` for the section); anything a badge, notification, or command-palette
entry navigates to.

### 2. Split-pane (list + detail)

**Promise: selection is navigation.** The existing `SplitPaneLayout`
convention: the list is the page, the selected entity is a path segment
(`useUrlSelection`), and the detail pane is where the entity is viewed *and
edited*. Creation happens here too — `new` as a pseudo-selection — because
**creation belongs where the created thing will live**; the user learns one
place per entity, and an interrupted creation is recoverable (it is just a
URL).

Use for: entity management (agents, skills, tool servers,
providers, plugins). If an entity list exists, its create flow is this rung —
not a dialog.

### 3. Dialog

**Promise: one decision, then you are back where you were.** A dialog holds a
short, single-outcome interaction whose abandonment is cheap: destructive
confirms, a rename, a picker that assembles one value, a genuinely short form
(≤ ~5 fields, no sub-navigation). A dialog must never contain its own
navigation, tabs, or a second dialog's worth of workflow. If a form has grown
tabs, it has outgrown this rung.

Dismissal: Escape and backdrop-click close it, **but not past unsaved input**
— an accidental-dismiss guard holds the dialog while a form field is dirty
(one confirmation, not data loss). Focus is trapped; focus returns to the
invoking element on close.

### 4. Sheet / drawer / dock

**Promise: context stays visible.** A secondary surface that must coexist
with the page under it — the chat dock, a details drawer, a terminal panel.
Sheets own the "ambient companion" role; they persist across navigation when
their subject does (the chat dock), or dismiss with their subject when it
does not (a row-details drawer). A sheet that needs an address has outgrown
the rung and should become a page (or a pane with a URL shape).

### 5. Popover / tooltip

**Promise: glance, don't commit.** Read-only context: field help,
disabled-state reasons, status detail, keyboard hints. Never a mutation
control inside a popover; the moment it needs a button that changes state, it
is a dialog (or an inline control on the page).

## Cross-cutting rules

- **One overlay-primitive kit.** Focus trap, Escape/backdrop handling,
  dismiss-guard, and stacking come from shared primitives, not per-surface
  implementations. The three modal-stack aggregators converge onto one
  stacking host; a fourth must not appear.
- **Overlays declare themselves.** Every overlay primitive tags its root
  (`data-slot`), so keyboard arbitration (shortcuts that must not fire under
  an open overlay) is one selector query, not per-feature plumbing.
- **No hybrids.** A flow lives on one rung at a time. Modal-then-navigate
  (the current provider-add flow) is the anti-pattern this document exists to
  name: it makes the modal's promise ("you'll be back where you were") false.
  Hand off between rungs explicitly — a dialog may *end* by navigating to a
  page, but then the page owns the rest of the flow and the URL says so.
- **Escape pops one rung.** Popover → closed; dialog → closed (guarded);
  sheet → closed; page → its parent view. Escape never skips levels or
  silently discards a dirty form.
- **Mobile maps rungs, it doesn't invent them.** Dialog and sheet may render
  as bottom sheets on narrow viewports; the promise (single outcome vs
  coexisting context) is unchanged.

## Current deviations and target rungs

| Surface today | Today's container | Target rung |
| --- | --- | --- |
| Provider add | converged in station#2685 | 2 — create inside the providers split-pane (proving slice for this doc) |
| Project create (`/projects/new` route renders `NewProjectModal`) | route-modal | 1/2 — a real page (it already has the URL; drop the modal dressing) |
| Schedule job create (`JobFormModal`) | dialog | 2 if jobs are list+detail; 3 only while the form stays short |
| ACP connection add (`ACPAddConnectionModal`) | dialog | 2 — connections are entity management |
| Machine add (`AddMachineModal`) | dialog | 3 is defensible (short form); revisit if it grows probe/config steps |
| Plugin install (`InstallPluginModal` + `InstallPreviewModal`) | stacked dialogs | 2 — install/preview inside the plugins or registry detail pane |
| Chat display prefs (`ChatSettingsPanel` in the dock) | sheet-local modal | stays 4 for quick toggles, but each control is the *same* device-scoped setting `/settings` renders — one source of truth, two renderers (settings#2679/#2680 rails) |
| Agent sub-selection (`AgentAddModal` for tools/skills) | hand-rolled overlay | 3 on the shared primitives — or inline disclosure in the editor tab |
| Modal-stack aggregators ×3 | three hosts | one stacking host (cross-cutting rule) |

Deviations converge as small slices, each citing this doc; the provider-add
hybrid goes first as the proving slice (station#2685). Nothing here licenses a
big-bang rewrite.

## Refs

- station#2685 (this document's issue), #692 (design program), #2559 (polish
  epic), #803 (new-chat modal semantics), #1948 (micro-UX batch).
- `docs/design/settings-architecture.md` — the scope model this document's
  "creation belongs where the thing lives" rule extends to containers.
