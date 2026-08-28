# Design: Shell skeletons (archive#193 shell convergence)

> Status: **rule recorded, ratchet enforced** (Wave 1 of archive#242, opening archive#193's six-view
> shell-convergence effort). This doc names the two canonical view skeletons, gives a usable
> decision rule for choosing between them, maps all six archive#193 views to their target skeleton, and
> records the enforcement mechanism (`shell-conformance` ratchet) plus one explicit,
> evidence-backed deviation from the original steal-list hypothesis (Knowledge).
>
> Source inputs: the internal UX inspiration notes §1a,
> §3 ("Prioritized steal list for the six S4 ports"), and §5 (sequencing recommendation — the S5
> allowlist note below is that recommendation, recorded here as instructed). Do not re-derive new
> skeleton vocabulary against this doc without updating that source table too.

## 1. The two canonical skeletons

Station's view shells converge on exactly two skeleton classes. Every archive#193 view targets one of
these two — there is no third shape.

### 1.1 `SplitPaneLayout` — list + detail

- **Component:** `src-ui/src/components/SplitPaneLayout.tsx`.
- **Shape:** a searchable left item list + a right detail pane. Already wires the S3 state
  primitives (`Empty`/`SkeletonList` slots) internally — a port that adopts `SplitPaneLayout`
  inherits loading/empty/error handling for free instead of re-implementing it.
- **Proven reference instances (shipping today):** `src-ui/src/views/ProviderSettingsView.tsx`
  and `src-ui/src/views/AgentConnectionView.tsx` render `<SplitPaneLayout>` directly as their
  list+detail shell. The former tool-management view was deleted and has no live UI consumer;
  its server routes remain live (no CLI equivalent exists for agent-tools
  management — see archive#2693).
- **Also present, nested:** `src-ui/src/views/SkillsView.tsx` renders a `<SplitPaneLayout>` for
  its skills list *inside* an outer `.page--full` root wrapper (see §1.2) — the two skeletons are
  not mutually exclusive at different DOM levels; a page-layout root can host a `SplitPaneLayout`
  as its primary content when the page itself needs chrome (e.g. `GuidanceTabs`) above the
  list+detail pane. For the purposes of the six-view mapping in §3, each named view's *governing*
  skeleton is judged by the shape of its primary content, not by which root CSS class technically
  wraps it.

### 1.2 `page-layout.css` + `DetailHeader` family — single-page

- **Root classes:** `src-ui/src/views/page-layout.css`'s `.page`, `.page--narrow`, `.page--full`
  (combinable with a view-local modifier class, e.g. `"settings page page--narrow"` — the literal
  `page` token must be present).
- **Header component:** `src-ui/src/components/DetailHeader.tsx` (sticky header: title left,
  action buttons right; optional `subtitle`, `badge`, `statusDot`, `icon` props).
- **Proven reference instances:**
  - `src-ui/src/views/SkillsView.tsx` — root is literally `<div className="page page--full">`
    (verified) and imports/renders `DetailHeader` for its detail-pane header.
  - `src-ui/src/views/SettingsView.tsx` — root is `<div className="settings page page--narrow">`
    (verified, combined-form root class).
  - `src-ui/src/views/ProjectSettingsView.tsx` — already imports and renders `DetailHeader`
    (verified: `import { DetailHeader } from '../components/DetailHeader'`, used as the header of
    its returned JSX) — this is the proven, shipping `DetailHeader` pattern the Knowledge port
    below reuses. Its own **root wrapper** is still the bespoke `<div className="project-settings">`
    (verified), not yet the literal `page` class — ProjectSettingsView.tsx is itself one of the
    five views still tracked by the shell-conformance ratchet (§4) pending its own future archive#193
    port (steal-list order item 4). It is cited here only as the `DetailHeader`-adoption
    exemplar, not as an already-fully-converged root.

## 2. Decision rule — which skeleton does a view get?

Ask one question about the view's **primary content**, not its settings-vs-non-settings label:

> **Does the view present an arbitrary-cardinality, user-navigable collection of items where
> selecting one item changes what's shown in a detail pane?**

- **Yes** → `SplitPaneLayout`. The collection is open-ended (providers, agents, skills — items
  can be added/removed, and the *point* of the view is picking one to inspect/edit).
- **No** — the view is a single subject (one project, one connection type, one dashboard, one
  account) with a fixed, bounded set of sections/cards, and nothing in it is "select one of N to
  see its detail" → `page-layout.css` + `DetailHeader`. Any internal grouping is sections, tabs,
  or cards, not a navigable list.

### 2.1 Heading ownership — who names the screen (archive#2931)

§2 says which **skeleton** a view gets. It did not say who owns the **heading** once the view is
inside one, so every view decided independently and the same screen could print a collection name,
a pane name and an item name with no hierarchy between them — both views "conformant", titles
stacked. The rule:

> **In a `SplitPaneLayout` screen the shell owns the COLLECTION title; the detail pane owns the
> ITEM title; the view never adds a third heading.** In a page-layout screen `DetailHeader` owns the
> single subject's title and everything below it is a section heading, not a second title.

Rationale: a collection title and an item title are one hierarchy at two levels, not two peers — so
exactly one component renders each, and any heading a view writes itself is by definition a third.

Consequences, in the order a view meets them:

- **Do not pass a `label` whose only breadcrumb segment restates the `title`.**
  UNFRAMED, `SplitPaneLayout` drops a one-crumb trail that repeats the title one line below it
  (`visibleBreadcrumbSegments`) — that name printed twice with no ancestor to navigate to — but
  keeps a real multi-segment trail as-is, current-page crumb included, because the list pane's own
  `<h2>` still sits below it as a second, lower-weight heading the trail precedes.
  FRAMED (§2.2 — this is now the case for every split-pane route in practice), the rule is
  stricter: `framedBreadcrumbSegments` drops the TRAILING crumb that restates the title
  unconditionally, whether the trail has one segment (a top-level route, which then gets no
  eyebrow at all) or several (a subpage, which keeps only its ancestor(s)). There is no second
  heading below the framed eyebrow for a restated crumb to precede, so keeping it is pure
  duplication — the self-referential `SCHEDULE`-above-**Schedule** pattern the 2026-08-26 shell
  audit retired (archive#4463 slice 1). A KEPT trailing crumb (one that does not restate the
  title) is still not assumed to be a real route, framed or not: only earlier, non-terminal
  segments auto-link.
- **Inside a detail pane, use `DetailHeader` for the item title.** It renders one level down
  automatically: the detail slot provides `DetailPaneContext`
  (`src-ui/src/components/detail-pane-context.ts`) and `DetailHeader` reads it. A view cannot
  opt out, which is the point — the rule is expressed by the components, not remembered by each
  view. Visual output is unchanged; `.detail-header__title` sets its own size.
- **Never write `<h1>`/`<h2>` in a file that renders `<DetailHeader>` or `<SplitPaneLayout>`.**
  Something in that file already owns the page-level title. An item title inside a detail pane and
  a section heading under a page title are both `<h3>`. This is counted — see §4.

Known instance outside the counted scope, recorded rather than silently passed:
`src-ui/src/components/session-detail/SessionDetailHeader.tsx` renders the Sessions detail pane's
item title as a raw `<h2>` from a file that renders neither canonical header, so the §4 counter
cannot see it. Ownership is already correct there (the detail pane names the item, and the shell
names the collection); only the level is inconsistent with the rule above. It is a follow-up, not a
regression.

The four views archive#2931 named as suspected double headers — `SkillsView`,
`ProviderSettingsView`, `ReviewQueueView`, `AgentConnectionView` — were captured as rendered before
any change was made, and all four already satisfied the ownership rule: `SplitPaneLayout`'s title
renders **inside the left list pane**, not as a page banner, so the shell title (0.92rem) and the
detail `DetailHeader` title (1.125rem) sit side by side in different panes at different weights.
That is correct two-level hierarchy, and the issue's own caveat anticipated it. The defects the
captures did find were the two above: a degenerate breadcrumb repeating the title, and page-level
headings written beside a canonical header.

This is a structural test, not a "does it live under Settings" vibe test — `SkillsView.tsx` lives
under a settings-adjacent surface but still gets `SplitPaneLayout` because skills are an
open-ended, selectable collection; `KnowledgeConnectionView.tsx` (§3) looks like a settings page
and *is* single-page precisely because it fails the cardinality test (see the deviation note).

### 2.2 The page frame — who renders the header (station UX audit, SHELL-11)

§2 says which skeleton a view gets; §2.1 says who owns the heading inside it. Neither said who
renders the **page header**, so every view rendered its own — and the running app was measured at
**six page-title sizes, nine title x-positions, four content widths and two top paddings across 28
routes**, with eight split-pane routes carrying no page header at all (their 14.7px panel title
stood in for one).

The rule now:

- **`components/page-frame` renders every page header.** Eyebrow · title · subtitle ·
  right-aligned actions, at one x-origin (264px at 1440) and one top padding (2rem), stacking on
  mobile. The x-origin, top padding, and title/subtitle sizing are the treatment Schedule already
  had — the audit named it the canonical instance for the header's SHAPE. Schedule is no longer a
  canonical instance of the EYEBROW specifically: archive#4463 slice 1 retired its self-referential
  `SCHEDULE`-above-**Schedule** eyebrow (Schedule is top-level, so it now renders none). For a
  current eyebrow example, see a subpage instead — Connections → Models renders eyebrow
  `Connections`, title `Models`. That eyebrow is deliberately **static text**: an eyebrow ancestor
  is linked only when it has a real landing surface, and `/connections` is a redirect-only
  resolver, so a link there would be a no-op or a sibling jump dressed as "up"
  (`ConnectionsSectionFrame.tsx` carries the full rationale). Note eyebrows are produced on two
  paths — `SplitPaneLayout`'s breadcrumb trail and `PageEyebrowTrail` — and the linked-only-when-
  navigable rule governs both.
- **`src-ui/src/app-shell/page-frame-registry.ts` decides which routes get one.** It is a `Record`
  over `NavigationView['type']`, so a route added to the union without a decision is a **type
  error**. `null` is a decision, and every one carries its reason in the table.
- **A view never writes page-header markup.** Where a title is only knowable at runtime (a
  project's name, a tab remembered in `sessionStorage`, the active Developer tab), the view
  publishes the TEXT with `usePageHeader({ eyebrow, title, subtitle })` and the frame renders it.
  Nodes passed to that hook must be memoised — the store settles on `Object.is`-equal slots.
- **Every framed route still resolves a title without its view.** The frame sits above Suspense, so
  between the click and the chunk arriving there is a window in which no view has run.
  `resolvePageFrame` fills that window from the surface the sidebar highlights
  (`surface-registry.ts`'s own `label()`, not a second copy) — so the word in the header is the word
  on the row the user just clicked — and the registry test refuses a framed route with no title at
  all. The two framed routes reached from inside a project rather than from a sidebar row name
  themselves in the table.
- **A header contribution belongs to the route its contributor mounted for.** One rule, both halves
  of the header: `usePageHeader` publishes nothing, and `PageFrameActions`/`SplitPaneLayout` portal
  nothing, once the route they mounted for has been left — the frame falls back to the route table's
  name for the route now on screen. The frame deliberately outlives the route (that is what keeps
  the header up while the next chunk loads), and when a chunk is slow React can keep the DEPARTING
  view committed for the whole load, still publishing; nothing about the frame's own state can tell
  that apart from a live view, so the contributor is what carries the identity. It is the same
  `routeIdentity` the entrance and the pending publisher use. The rule relies on the route body
  remounting on a route-identity change, which `AppViewContent` guarantees by keying the entrance
  wrapper on that identity, and which its own test pins.
  There is a second half, for the contributor that never renders again: React keeps a departing
  view mounted but HIDDEN while the next chunk loads, and a portal's children are not inside the
  hidden subtree — they are in the header. So the frame keys the action cell itself on the route
  too, and the cell leaves with the route whose actions were portaled into it.
- **The body holds the frame's shape while the chunk is in flight.** The header names the
  arriving route from ~8 ms; until archive#3660 the body under it was one generic six-row `SkeletonList`
  for every route, so a split-pane destination announced itself as a full-width list and then
  jumped to a 280 px rail plus a detail pane. `app-shell/RoutePendingSkeleton.tsx` reads the shape
  off the destination's own `PageFrameSpec` — the SAME object `AppViewContent` hands `PageFrame`,
  resolved once and passed to both — so the placeholder and the page cannot disagree:
  `flush` + `body: 'fill'` (the shared `SPLIT_PANE` spec, and only it) gives a rail beside a detail
  pane, any other spec gives `SkeletonBlock`, and a route with no frame keeps the unshaped
  `SkeletonList` because nothing has named an arriving page.
  Three facts the frame cannot supply are read through the SAME function the arriving view reads
  them with, never a second copy: the **Guidance tab** (`views/guidance-tab.ts` — its Commands tab
  is a single-column list under the same `SPLIT_PANE` spec that makes Skills a pane),
  the **mobile breakpoint** (`useIsMobile`, because below it a split pane shows one side and opens
  on the detail whenever the route names a record), and the pane's **persisted collapse**
  (`split-pane-metrics.ts`, whose pane ids are declared once and imported by both the view that
  mounts the pane and the placeholder). Getting the last one wrong is a 252 px jump.
  There is no timer and no cap on the departing body. React shows a Suspense fallback — hiding the
  boundary's previous children with `display: none` — when an **urgent** update suspends, and
  Station's navigation is urgent (`App.tsx` calls a plain `setCurrentView` for clicks and
  `popstate` alike; nothing wraps navigation in `startTransition`). Under a transition React keeps
  the departing content revealed and renders no fallback, which is the archive#3660 symptom itself; both
  halves are pinned by test. And the fallback renders if and only if the outlet is suspended, so a
  warm transition shows no placeholder at all.
- **A page action goes in the header's action slot**, via `<PageFrameActions>` or
  `SplitPaneLayout`'s `headerActions`/`onAdd` (which portal there when framed). List chrome — a
  card, a bulk-action row — stays in the list, in `sidebarActions`.
- **`SplitPaneLayout` renders INSIDE the frame**: header above, panes below. It publishes its
  `label`/`title`/`subtitle` upward instead of drawing a heading of its own, and a host that owns
  the page title for a tabbed page (Guidance) wraps its tab bodies in `<PageHeaderScope>` so the
  tab's collection title cannot overwrite the page's.

Recorded exceptions, matched one-for-one by a `null` in the registry and an entry in the ratchet's
`BESPOKE_HEADER_EXCEPTIONS`: **Home** (its `<h1>` is a prompt, not a page name), the **shared-answer
route** (renders outside the shell), the **project workspace's identity row** (its avatar/name/path
header IS the content of that surface), two **dialog surfaces** whose `<h2>` is a modal's accessible
name rather than a heading for a route, and the surfaces that own their whole viewport — **project**,
**task**, **layout**, **workspace-pane**, **project-new** (a route-level dialog), **project-edit**
(editor chrome: an unsaved badge and a Save/Back pair) and **not-found** (`ErrorState` is the page).

`.page`/`.page--narrow`/`.page--full` remain only for those last self-shelled surfaces;
`page-layout.css` keeps the section/card/tab/row families every view still uses.

## 3. Six-view target mapping (archive#193)

Root wrapper classes below are verified directly against the current tree (byte counts via
`wc -c`, classes via direct file inspection) as of this doc's writing.

| # | View | Current root wrapper (verified) | Target skeleton | Status |
|---|---|---|---|---|
| 1 | `src-ui/src/views/KnowledgeConnectionView.tsx` | `knowledge-view` (5,375-byte CSS) | **page-layout single-page** (`.page`/`.page--narrow` + `DetailHeader`) | Ports **this PR** — deviation from the steal-list's `SplitPaneLayout` hypothesis, see §3.1 |
| 2 | Deleted tool-management view | No live UI surface | SplitPaneLayout | Historical port completed in archive#245; server routes and CLI remain live without a UI consumer |
| 3 | Deleted workflow-management view | No live UI surface | SplitPaneLayout | Deleted; server routes and CLI remain live without a UI consumer |
| 4 | `src-ui/src/views/ProjectSettingsView.tsx` | `project-settings` | page-layout, sectioned | Remaining — tracked by the ratchet ceiling |
| 5 | `src-ui/src/views/ConnectionsHub.tsx` | `connections-hub` (9,160-byte CSS + 15,970-byte TSX) | page-layout, hub | Remaining — tracked by the ratchet ceiling |
| 6 | `src-ui/src/views/MonitoringView.tsx` | `monitoring-view` (32,014-byte CSS — the largest of the six) | page-layout, dashboard | Remaining — tracked by the ratchet ceiling |

This is the exact steal-list §3 port order (Knowledge → Tool → Workflow → ProjectSettings →
ConnectionsHub → Monitoring), reproduced here as the target mapping rather than re-derived.

### 3.1 Knowledge deviation — recorded explicitly (flag for PR review)

The steal-list (the internal UX inspiration notes §3, row 1) recommended `SplitPaneLayout` for
Knowledge, reasoning from a surveyed knowledge-browser tree+reader pattern. This plan targets
**page-layout single-page** instead. Reasoning:

- `KnowledgeConnectionView.tsx` has **no natural navigable list** — its content is one
  vector-database slot and one embedding-provider slot (two fixed cards), not an
  arbitrary-cardinality collection a user selects among. It fails the §2 decision-rule test
  outright.
- Forcing the literal `<SplitPaneLayout>` component onto it would require inventing a
  list-select interaction that doesn't correspond to anything the current UI does — that is a
  **redesign**, not a structural convergence, and would violate the parity requirement this port
  is judged against (before/after screenshots must match).
- It would also require touching `src-ui/src/views/ConnectionsHub.tsx` (the list this view is
  reached from) to wire a new selectable-item affordance — `ConnectionsHub.tsx` is explicitly out
  of scope for this PR (its own separate archive#193 port, mapping row 5 above).

This is recorded here as an **explicit, evidence-backed deviation**, not a silent scope change —
flag it at PR review. If a reviewer disagrees, the fallback is a follow-up slice that revisits
`ConnectionsHub.tsx` together with `KnowledgeConnectionView.tsx`, not a mid-PR scope expansion.

## 4. Enforcement — the shell-conformance ratchet

A new count-ratchet gate, `scripts/shell-conformance-ratchet.mjs` (+ checked-in
`scripts/shell-conformance-baseline.json`, + `scripts/__tests__/shell-conformance-ratchet.test.ts`),
lands in the same PR as this doc and the Knowledge port. It follows
`scripts/state-primitives-ratchet.mjs`'s exact, established architecture (pure exported
functions, `main()` gated behind `import.meta.url === file://process.argv[1]`, a checked-in
numeric ceiling that only decreases, reasoned per-file exclusion lists with staleness checks) and
is wired into `verify:static` immediately after `state-primitives:ratchet`.

- **Signal (first count, `bespokeHeaderCeiling`):** over **every** git-tracked `.tsx` under
  `src-ui/src/views/**` and `src-ui/src/pages/**` — a glob, not a named list — a file is bespoke
  when it writes canonical page-header markup itself (`page__header`/`page__title`/`page__label`,
  guarded so `project-page__header` — and only that family — does not match), a page-level `<h1>`,
  or a **header block titled at page level**: an element whose class names a `*__header`/`*-header`
  family, or a `<header>` element, containing an `<h1>` or `<h2>`.
  `BESPOKE_HEADER_EXCEPTIONS` names each allowed file with its reason, and an exception whose file
  no longer carries a header fails the gate, so the list cannot outlive its reason. Recorded at
  **0**.
  The third signal exists because the first two only recognise a bespoke header written in the
  canonical vocabulary. `<header className="tools-view__header"><h2>Tools</h2></header>` is
  ordinary markup in a vocabulary of its own, it is exactly the shape that produced six title sizes
  and nine title x-positions across 28 routes, and it passed this gate at ceiling zero. `<h3>` is
  deliberately NOT counted — §2.1 prescribes it for card, dialog and section headers, and including
  it matched 16 files in this repo, an exception list that long being a rubber stamp. What the
  signal does not see: a page-level `<h2>` with no header element or header class around it, where
  the file also renders no canonical header (the stacked-heading count below covers the rest).
  This REPLACED the original signal — a root-wrapper classification (`renders <SplitPaneLayout>` or
  a `page`-token root) over a fixed six-file `TRACKED_VIEWS` list. That gate was green while the app
  had six title sizes and nine title x-positions, because a `page`-rooted wrapper says nothing about
  the header inside it, and because a fixed list cannot see a seventh view — a gap the script's own
  header disclosed. §2.2 moved the header out of the views, which is what makes the wider,
  simpler signal possible.
- **Second counted signal — `stackedHeadingCeiling` (archive#2931):** over every git-tracked
  `src-ui/src/**.tsx`, each file that renders `<DetailHeader>` or `<SplitPaneLayout>` (i.e. something
  in it already owns the page-level title for its screen) contributes one to the count for every
  page-level heading element (`<h1>`/`<h2>`) the file writes **itself**. Recorded at **0**, down from
  5 measured on `c22bed9cc`: `ReviewQueueView.tsx` (4 detail-pane item titles) and
  `TaskWorkspaceView.tsx` (1 section heading) moved to `<h3>` with their CSS selectors, so computed
  styles are unchanged. Scope honesty is asserted before any count is reported
  (`assertScopeIsHonest`, with both of those files pinned so the roots cannot be narrowed to hide
  them). `bespokeShellCeiling` is deliberately unchanged at 0 — archive#2931 ported no view onto a new
  skeleton, it only fixed heading levels inside skeletons already adopted. The counter is textual
  and therefore cannot see a heading reached through an indirection (a computed tag, or a heading in
  a child component that renders neither canonical header) — the `SessionDetailHeader.tsx` instance
  named in §2.1 is exactly that case, which is why it is written down there.
- **Shrink path:** both counts are recorded at 0 and hold the line. A new bespoke header fails the
  gate on the file that introduced it, in the PR that introduced it, wherever under `views/`/`pages/`
  it lives.

## 5. S5 forward note — inline-style/token allowlist policy

Per the steal-list's sequencing recommendation (§5): the S5 token/hex ratchet's allowlist policy
should be **decided during the S4 ports**, not discovered ad hoc once S5 starts, so S5's gate
doesn't have to grandfather surprises it didn't anticipate. Two known-legitimate exception
classes, named now from the UX inspiration research so any S4 port that creates one records it here
rather than inventing new exception language later:

- **Chart-color bridges for SVG charting** — a `themeColor()`/`readDashboardPalette()`-style
  runtime bridge that reads computed CSS custom properties (with a `MutationObserver` on theme
  change) because SVG charting libraries need real color strings, not CSS variable references
  (surveyed precedent, cited in
  the internal UX inspiration notes H7). Most likely to surface in the **Monitoring** port (§3, row 6
  — the one view in this set with charts).
- **Brand-icon SVGs** — hardcoded hex inside icon assets/definitions (not component styling),
  the same shape as the surveyed reference's own near-zero exception set (the internal UX inspiration notes T7:
  "~13 files repo-wide contain a raw hex literal — icons + one decorative effect").

This Knowledge port (this PR) creates **no new exception of either kind** — it removes bespoke
CSS, it doesn't add inline styles or hex literals. This section is left in place for the next
five ports to append to, per the steal-list's instruction to record allowlist decisions as they
happen rather than after the fact.
