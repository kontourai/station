# Placement: regions, surfaces, layouts, panes, pane hosts

Status: **accepted direction with an implemented core** (owner decisions on
station#928, 2026-09-01 through 2026-09-04). It describes `main` once the
2026-09-04 placement batch has landed: the docked-capability pins, #1446 and
#1420 are delivered by sibling pull requests that merge before this record. The two placement layers below
ship today, and so does the "arrangement" record. The "region occupant is a
pane host" shape is implemented through its fourth slice (#2045, slice 1 of
the tabbed-dock epic #2044; #2046 parts 2a and 2b; #2047 and #2048, slices 3
and 4): each dock region holds a SET of surfaces — its panes, in tab order,
one of them selected — renders a tab strip of them in its chrome bar, renders
the selected one as a pane of the region's own pane-host document, offers
the panes it can add from a "+" catalog, and is the target of one
`openInRegion` intent. What is and is not yet true is stated under "A
region's occupant is a pane-host document" below. The vocabulary here is
canonical: [`docs/glossary.md`](../glossary.md) carries the short definitions
and `src-ui/src/__tests__/placement-vocabulary.test.ts` pins the retired names.

This record exists because the region system had no written design at all,
and because five words (`layout`, `region`, `surface`, `tab`, `pane`) were each
being used for two or three different things. Every term below names exactly
one thing that exists in source.

## The two layers

Station places UI at two levels, and they are different mechanisms with
different owners.

```
┌ shell ───────────────────────────────────────────────────────────────┐
│ toolbar / sidebar / palette                                          │
│ ┌ left region ┐ ┌ main region ──────────────────┐ ┌ right region ──┐ │
│ │ (pane host) │ │ route outlet, or a layout      │ │ pane host:     │ │
│ │             │ │ whose pane host is a tree:     │ │ tabs [activity]│ │
│ │             │ │   split ─┬─ tabs [files]       │ │                │ │
│ │             │ │          └─ tabs [diff, chat]  │ │                │ │
│ └─────────────┘ └────────────────────────────────┘ └────────────────┘ │
│ ┌ bottom region ───────────────────────────────────────────────────┐ │
│ │ pane host: tabs [chat]                                            │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

**Layer 1: shell regions.** The shell owns four fixed slots: `main`, `left`,
`right`, `bottom` (`REGION_IDS`, `src-ui/src/regions/region-model.ts`). Each
holds registered **surfaces** — `RegionState.panes`, in tab order, with
`occupant` the selected one (#2046 2a) — plus `visible` and `size`. A dock
region may hold several and renders the selected one as a pane of the
region's own pane host (#2045, below); `main` holds at most one. The
three dock regions (`DOCK_REGION_IDS`) show and hide; `main` is always
visible and is a choosable region since Home became a surface (#928 slice
C2a, below). This layer is user-facing chrome: the region toolbar
(`src-ui/src/components/header/RegionToolbarControls.tsx`) is one toggle per
dock region — pressed while the region is visible, from the model — and it
only shows and hides (#2143, #2155); what goes in a region is that region's
own chooser, which a hold on the toggle also opens (#2154). A pane's own
placement is its tab's move menu (`RegionChromeBar`), and the region bar's
grab moves the whole region. No surface reads its own placement (pinned by
`region-surface-boundary.test.ts`).

### `main`

`main` is the primary area: the route outlet at `/`, and the routed view on
every other route. Four rules make it a region rather than a special case
(#928 slice C2a, owner decisions of 2026-09-05):

- **Surfaces declare where they may be placed.** `RegisteredSurface.regions`
  lists the regions a surface may occupy, and `placeSurface` refuses any
  other (`surfaceMayOccupy`). Home declares only `main`; Activity declares all
  four; Chat declares the three dock regions (its `main` placement would be a
  projectless full-screen Chat, a mount no entry point has made). The toolbar
  offers a surface only for the regions it declares, so this refusal is the
  backstop, not the UI.
- **Displacement from `main` unplaces.** A surface taking `main` replaces what
  it shows; the previous occupant becomes the occupant of no region. It is not
  relocated to a dock region, because a replacement in the primary area must
  not spawn a panel nobody asked for. A dock region does not displace at all
  since #2046 2a (decision 3): a surface placed into an occupied dock region
  JOINS its panes, last in tab order and selected, and the pane it joins
  stays behind it. The pre-2a relocation of a displaced surface (the swap
  back into the vacated region, the `defaultRegion` and opposite-side search
  of #1386) is gone with the single-occupant region it served. A surface is
  in at most one region: placing it elsewhere removes it from the region it
  leaves, which keeps its other panes (selecting the neighbour when the
  leaving pane was the selected one) or, left empty by the move, hides
  (#2153: a close keeps an emptied region open; a move does not).
- **A placement into `main` navigates to `/`.** `main` renders only at `/`
  (`App.tsx` renders `main`'s occupant there through `MainRegionSurface`; a
  null occupant is Home). `RegionModelContext` is the one place that knows a
  placement landed in `main`, so it navigates after the state write, through
  the same store call `useShowSurface` makes. On any other route the routed
  view renders and the occupant is kept, not cleared. The Home destination
  (`regionSurface: 'home'`) therefore reveals Home by placing it, rather than
  navigating to `/` and showing whatever occupies `main`.
- **`main` has no toolbar control on any device** (it is always visible;
  since #2143 the toolbar is per DOCK region). A pane reaches it through its
  tab's "Move to Main" (a surface that declares `main`, so Activity), which
  needs a tab: a region holding two or more panes while the strip renders
  (`RegionChromeBar`'s `showStrip`, gated on `isMobile` — the 768px layout,
  or a short coarse viewport — not on the pointer alone; a wide coarse tablet
  is bottom-only and still gets the strip, so its one dock's tabs offer
  "Move to Main"). A bottom-only device
  folds its region commands into one control (#1400's toolbar occlusion
  floor) and this slice does not widen that fold; Home still reaches `main`
  there through the sidebar's two Home affordances (the header's app-name
  button and the Work list's Home row, `ProjectSidebar.tsx`) and the
  `?surface=home` deep link. Home is `hiddenFromNav` and has no palette
  entry.
- **A `main` occupant's toggle returns it to the dock.** A surface's chord
  (⌘⇧A for Activity) and its row in the folded Regions menu are one model
  command, `toggleSurface` (#1523; the toolbar carries no placement rule of its
  own, #1420): a dock occupant's region is hidden or shown, and a surface
  occupying `main` is moved to its default dock region — visible, Home left in
  `main` — so the folded menu offers `Move Activity to the dock` there rather
  than a `Show Activity in the dock` that would reveal it where it already is. This holds
  from ANY route and never navigates (owner decision, review round 1): on
  `/settings` the chord shows Activity in the dock beside Settings rather than
  hijacking navigation to `/`, and `main` empties to Home behind the routed
  view for the next return to `/`. Home, whose default is `main`, has no chord
  and toggles to nothing.
- **"Go to `/`" and "show Home" are different producers.** Since `/` renders
  `main`'s occupant, a caller that means Home by name — the not-found view's
  "Go home", the landing after a project is deleted — reveals the Home surface
  (`useShowSurface()('home')`), while a dismissal that means "back to where I
  was" — the settings and profile toggles' return, Escape from Settings or
  Skills, the store's `setAgent(null)` fallback, the first-run tour's palette
  step — navigates to `/` and shows whatever occupies `main`. Each site says
  which meaning it holds (#1523).

**Layer 2: pane hosts.** Inside a surface, or inside a project layout, a
`WorkspacePaneHost` renders a persisted tree of **panes**. The tree has two
node kinds: `tabs` (a group of panes in one spot, one showing at a time) and
`split` (two children with an orientation and a drag ratio). This is the
plugin and SDK model: plugins contribute pane descriptors, not surfaces, and
the contracts vocabulary (`supportedRegions`, composition `role`) describes
positions inside this tree.

The layers meet at one seam: a dock region IS a pane host. `RegionShells`
mounts one `RegionPaneHost` per occupied dock region — the region's
`DockShell` around the region's chrome bar (`RegionChromeBar`: placement
grab, tab strip, maximize, visibility) and a `dock`-presentation
`WorkspacePaneHost` holding the region's document, `ambient:<region>`
(persisted as `station:workspace-pane-host:v2:ambient:<region>`) — and the
surfaces placed there are its panes, one tab each in the strip, the selected
one on screen: Chat's renders through `renderAmbientChatPane`
(`ChatDock.tsx`), Activity's through `ActivityDockPane`
(`ActivityRegionShell.tsx`). A pane behind another's tab is reached by its
tab, its chord, its toolbar row and `showSurface`, each of which selects it;
it is not mounted until then. Which surfaces have a pane at all is
`REGION_SURFACE_PANES` (`src-ui/src/regions/region-surface-panes.ts`), pinned
in both directions to the registry's dock-capable surfaces. Before #2045 the
Chat surface alone was a pane host (`AmbientChatDockPaneHost`, document
`ambient:chat-dock`) and Activity had a per-occupant shell of its own; the
legacy path that docked Home as a second pane inside the chat dock, with an
occupant picker to switch between them, was deleted in slice C2b (owner
decision, 2026-09-03) once Home became a region surface. The Chat document
and its key outlived both changes — see "Persistence today" for how a
region adopts it.

## The words

| word | means | exists as |
|---|---|---|
| **Region** | a fixed shell slot: `main`, `left`, `right`, `bottom` | `REGION_IDS`, `RegionState` |
| **Surface** | a thing registered to occupy a region: id, title, icon, optional chord, the regions it declares, default region | `REGION_SURFACE_REGISTRY`, `RegisteredSurface` |
| **Layout** | a project's named view the sidebar navigates between (Coding, Tasks, Session board, a plugin's) | `LayoutConfig` server record; `type` selects the renderer |
| **Pane** | the smallest addressable UI unit; what plugins contribute | `WorkspacePaneDescriptor`, `WorkspacePaneInstance` |
| **Pane host** | a tree of panes arranged as splits and tab groups, inside a region or a layout | `WorkspacePaneHost`, `WorkspacePaneHostDocumentV1` |
| **Arrangement** | the user's placement choices: which surfaces in which region and in what order, which of them is selected, each region's size and visibility, which region (at most one) is maximized, each pane host's tree | `RegionArrangement` for the region half; persisted per device by #928 slice D, `maximized` added by slice iii (#1385), `panes` and the selection by #2046 2a, written by the tab strip since 2b |
| **Destination** | a navigable place in the app the palette and sidebar can send you to | `APP_DESTINATION_REGISTRY` (`src-ui/src/app-shell/destination-registry.ts`) |
| **Panel** | a bounded visual grouping inside a page or pane (Trust panel, inspector) | unchanged; see the glossary |

Words that were retired, and why:

- **"Surface" for a navigable destination.** The app-shell registry of twenty
  destinations (fourteen distinct routes; Settings and Guidance sections share
  theirs) used the same noun as the region occupants. #928's acceptance
  criteria, the toolbar's accessible labels and the `?surface=` deep link all
  mean region occupant, so that meaning won and the route registry became the
  destination registry. `?surface=activity` keeps its name: it names a region
  surface.
- **"Layout" for the region state map.** `RegionLayout` became
  `RegionArrangement`. A layout is a project view; the map of which surface
  sits where is the arrangement.
- **"Layout tab"** (the `tabs` array in a plugin `layout.json`). This is the
  legacy plugin shape, kept as migration input (#265), not a target-model
  term. A plugin layout with N tabs maps onto a pane host whose root is one
  tab group with N panes, which is exactly what
  `createWorkspacePaneHostBaselineDocument` builds.

Names that are deliberately NOT renamed: `SplitPaneLayout` (a list/detail
widget used by eight views; the glossary already scopes it as an
implementation name and its CSS classes are pinned by e2e and ratchets),
`useShowSurface`, `parseSurfaceDeepLink`, and everything under
`src-ui/src/regions/` (they are about region surfaces).

## What reads what (verified 2026-09-05 against the placement batch (#1462, #1463, #1464) and #928 slice iii (#1385); re-verified 2026-09-13 against #2047 and #2048)

A placement declaration is only as real as its reader. This is the reader
map; anything not listed is a label.

| declaration | vocabulary | readers |
|---|---|---|
| `REGION_SURFACE_REGISTRY` | surface ids | `RegionModelContext` (direct), `ActivityRegionShell` (direct, for `main`'s frame title), `RegionShells` via `regionModel.surfaces` (a dock region mounts a host only for a registered occupant), the region toolbar and `useRegionSurfaceMenu` via `regionModel.surfaces`, `CommandPalette` via the destination registry's `regionSurface` field |
| `REGION_SURFACE_PANES` (#2045; #2047) | surface id → the canonical `WorkspacePaneInstance` under the dock's context (`instance({ projectId })` — a coding pane is the dock project's and has no instance without one; Chat, Activity, Agents and Device ignore the context, Device because a device list is the Station host's fact rather than a Project's — #1969), plus `descriptorId` and the entry's constant `instanceId` | `RegionPaneHost`: the region's document is its panes' entries in tab order under the dock's project (an unsuppliable pane keeps its tab and renders "Choose a project for this dock"), and a persisted or opened pane is admitted only when `regionSurfaceOfPane` names a surface in the region's `panes` AND it binds the dock's project (an opened pane bound to another project is refused; a persisted one is re-bound by the catalog match); the empty region's chooser (`RegionEmptyChooser`, #2154) lists registry surfaces and enables a row only where the entry's `instance(context)` is non-null — no prefix family is a registry key, so an instance-keyed pane is never a row (`regionSurfaceOfDescriptor` and `dockCanSupply` are read by the inventory pin alone since the dock catalog was retired); `useOpenInRegion` folds an instance to its surface; `region-surface-panes.test.ts` pins the keys to the registry's dock-capable surfaces both ways and every entry's descriptor to `dockCanSupply`. Since #2049 `RegionShells` decides "mount a host" from `resolveRegionSurface`, not from the registry alone — so what makes that sufficient is this pin PLUS `region-instance-panes.test.ts`, which pins the id-keyed resolver and this module's occurrence minter to admit exactly the same instance ids |
| `DOCK_HOST_SUPPLIABLE_CONTEXTS` (#2047) | `{ project, source, workspace }` — what a dock region can bind for a pane | `dockCanSupply` (`workspacePaneModesSatisfiableBy` over it): the inventory pin's admission check (`region-surface-panes.test.ts`); it was also the dock catalog's filter for "listed disabled with the reason" until #2154 retired that catalog for the registry-driven chooser |
| `RegisteredSurface.exposure` (#2047) | absent (`shell`) or `catalog` | `useRegionSurfaceMenu` (`surfaceList`: a catalog-only surface has no chord and no unplaced Show row; a placed one keeps its folded Show/Hide row, which reads `region.panes`) — a region's chooser (#2154) is a catalog-only surface's only offer, and since #2155 the toolbar offers nothing at all; `?surface=<id>` is a command and reveals either kind |
| `INSTANCE_SURFACE_PREFIXES` / `resolveRegionSurface` (#2049; #2157 adds `board:` and `layout:`) | an id PREFIX (`pr:`, `file-preview:`, `board:`, `layout:`) → a `RegisteredSurface`-shaped description: title, icon, the dock regions it may take, `exposure: 'catalog'`, and the `pane:builtin:…` descriptor id its occurrences carry (named as a STRING — this table is in the entry chunk and may import no pane contract) | THE id-keyed lookup: `surfaceMayOccupy`, the record parser's `parseSurfaceEntry`, the provider's `openSurfaceInRegion` and `toggleSurface`, `RegionShells`' mount rule, `RegionPaneHost`'s tab titles and placeholder titles, `useDockShellChrome` (`surfaceTitle`, `surfaceShortcutId`, the landmark), `useRegionSurfaceMenu`'s folded rows, `DockShell`'s landmark; `RegionEmptyChooser` (#2154) lists `model.surfaces`, which holds none of them, so no route to the chooser — a region's "+", its empty body, or a hold on its toolbar toggle (#2155) — can offer them. `region-instance-panes.test.ts` pins each prefix to the minting half in `region-surface-panes.ts`; `docked-capability-derivation.test.ts` pins each `descriptorId` to a built-in descriptor that exists and declares `docked`. These surfaces are never registry keys — there is no blank occurrence to register — so `model.surfaces` (the SHELL's inventory: what the toolbar may offer, what a chord toggles) holds none of them |
| `MarkdownLinkContext` (#2049) | the conversation a rendered message belongs to: its project slug and id, the DOCK's project slug, whether this device folds to one region, and the `setLayout` route a preview took before | `ChatMarkdownAnchor` (inside `MarkdownRenderer`'s lazy chunk) — the ONLY reader, and the absence of a provider is the default: a document view, a shared answer and a system event have no conversation, so their anchors stay plain anchors. Provided by `ChatDock` alone |
| `RegionState.panes` (surface ids, tab order; #2046 2a) | surface ids | `occupiedRegion`, `occupiedDockRegion`, `chatRegion`, `firstFreeDockRegion`, `foldedDockRegion` (a surface behind another's tab is still IN its region; a region with no panes is free), `placeSurface` (joins a dock region's panes, replaces `main`'s, removes the surface from the region it leaves), `removeRegionPane` (a closed tab: the surface leaves and is placed nowhere), `moveRegionPanes` (the region bar's placement: every pane, in order, moves), `dockMirrorDiff` (a region holding Chat, selected or not, is Chat's region; Chat leaving every region reads as the dock closing), the record writer (one pane → `surface`, two or more → `pane-host`), `RegionPaneHost` (the document is DERIVED from it; a mount reconciles a persisted document that lacks a pane), the tab strip (`RegionChromeBar`, #2046 2b: one tab per pane in this order; a reorder writes it back), `DockShell` and `useDockShellChrome` (a region whose panes include Chat is Chat's shell — `#chat-dock`, the "Dock" landmark, the `dock.maximize` registration, the persisted snap key and the project binding's cleanup — whichever tab it shows; D3), `DockShellChrome.regionPanes` (Chat's mobile overflow sheet lists the region's other panes from it), and `useRegionSurfaceMenu` (a segment for a region the surface already holds is a select, and claims no displacement; the folded menu's rows are per region, in this order) |
| `RegionState.occupant` (the SELECTED pane, a member of `panes` or null) | surface ids | every pre-2a reader keeps its meaning for a one-pane region: `useDockShellChrome` (`surfaceTitle`, `surfaceShortcutId` and `canMaximize` name the pane the region SHOWS, so the region bar's visibility control reads "Hide Activity" while Activity's tab is selected; a non-Chat region's landmark takes the same title — and an EMPTY region, having no pane to be named after, names itself: "Right region", with `canMaximize` false, #2153), `RegionShells` (a host mounts for a registered selected pane, or — #2153 — for a VISIBLE region with no pane at all), `MainRegionSurface`, `ProjectSidebar`, `useRegionSurfaceMenu` (a surface is SEEN only when its region is visible and it is the selected pane; the picker reads Hidden otherwise, and the folded menu's row for the selected pane is the region's Hide), `toggleSurface` (only the selected pane's toggle hides its region; a pane behind selects), `revealSurface`/`showSurface` (select the pane's tab), `selectRegionPane`/the provider's `selectPane` (what a tab click writes), the record's `selected`, the tab strip (the pressed tab), the `dock` host (the one pane it mounts, as the strip's `tabpanel`), and `RegionPaneHost`, which makes the controller's active pane follow it (`focusExisting`) |
| `RegisteredSurface.regions` | `main`, `left`, `right`, `bottom` | `placeSurface` via `surfaceMayOccupy` (refuses an undeclared region), `RegionModelContext.placeSurface` (a refused placement does not navigate), the region chooser (#2154 lists the surfaces declaring the region; `useRegionSurfaceMenu` lists dock toggles only) and a tab's move menu (`RegionChromeBar`, #2143: the regions the pane declares, minus its own) |
| `WorkspacePanePlacement.supportedRegions` | `primary`, `secondary`, `standalone`, `docked` | parse validation; `instantiateWorkspaceComposition` (does a composition slot fit this pane); `isWorkspaceHomeRoleEligibleDescriptor` (`standalone` means "may be a route"); the dock catalog (`dockCatalogEntries`, #2047 — `docked`'s first placement reader: a pane declaring it was OFFERED in a region's "+", which decided fit, never location — retired by #2154, whose chooser reads the registry's `regions` instead, so `docked` has no offering reader today); the docked-capability pins (`docked` means "may be a region surface"): `src-ui/src/__tests__/docked-capability-derivation.test.ts` over the built-in descriptor constants and `workspace-pane-known-declarations.test.ts` over the server's inline declarations |
| `WorkspacePanePlacement.preferredRegion` | same | parse validation and canonical-identity equality only |
| `WorkspaceCompositionPaneSpec.role` | `navigation`, `content`, `auxiliary`, `inspector` | the composition algorithm groups panes by role: tabs within a role, splits between roles. Runs on real data through the coding file/diff/evidence compositions (behind `workspaceComposition*` layout config controls) and the task room |
| `RegionState.size` | pixels | round-trips through the record; a shell seeds its own region's size from it and falls back to the legacy keys only without a region model (`useDockShellChrome`, #928 D, closed #1380) |
| `RegionState.maximized` | boolean, at most one region, never `main`, never a hidden or empty region (`updateRegion`, the parser) | `useDockShellChrome` (the shell's `isDockMaximized`, for ANY occupant — `DockShell` renders the class and side-panel width from it), `App.tsx` (mobile full-screen, the folded dock region whatever its occupant), `placeSurface` (clears both ends of a move or swap, #1385); navigation's `maximize` param and `lastDockMaximized` are Chat's MIRROR of it (`dockMirrorDiff`, `RegionModelContext`), never its source — the region is also seeded from them inbound (`?maximize=true`, `focusSession`'s restore) |

Two facts that follow from the map and are easy to get wrong:

- **Nothing reads `supportedRegions` to decide where a pane renders.** It gates
  whether a pane fits a slot; the user, the registry and the composition
  builders decide where. The dock catalog (#2047) is a reader of exactly that
  kind: `docked` decides whether a pane is offered in a region's "+", and the
  region is the one whose "+" was pressed. Do not add a reader that picks a
  region from it without a decision on #928.
- **Compatibility is context supply, not region words.** The "can this pane
  live here" check is `workspacePaneModesSatisfiableBy` against the contexts a
  host can supply. A dock region's host declares its own set,
  `DOCK_HOST_SUPPLIABLE_CONTEXTS` (`{ project, source, workspace }` from the
  dock's active project; no `task`, no `session`), because the contract's
  `workspacePaneHostSuppliableContexts({ kind: 'ambient' })` is the empty set —
  the ambient scope binds no identity of its own. The region host's admission
  is then `regionSurfaceOfPane` (the canonical occurrence of a surface the
  region holds) plus the dock's project binding, and the catalog's "listed,
  disabled, with the reason" derives from the same set (`dockCanSupply`).
  New placement targets should reuse that fold, not a new enum.

## Persistence today

- **Arrangement (regions):** the `regionArrangement` device setting
  (`packages/contracts/src/device-settings.ts`), one versioned record per
  device inside the device-settings envelope: for each of `main`, `left`,
  `right` and `bottom`, its `visible`, its `size` along its own edge, its
  occupant, and (additive, #928 slice iii) its `maximized`, absent in older
  records and read as false. The occupant is `null` for an empty region,
  `{ kind: 'surface', id }` for a region holding one surface, and — since
  #2046 2a (decisions 1 and 2) — `{ kind: 'pane-host', panes:
  [{ kind: 'surface', id }, …], selected }` for a region holding two or more:
  the surfaces inline, in tab order, so the arrangement never depends on the
  region's localStorage pane-host document to be readable. The variant names
  no document (decision 1 as amended by the 2a review, applied in 2b): the
  host derives the region's document id from the region, so the `documentId`
  the 2a record carried was a fact the region id already held; the parser
  ignores it where an earlier build wrote it. A single-pane region keeps the `surface` form on purpose: a build
  that predates `pane-host` still reads every single-pane region. A newer
  variant survives being READ by an older build (the parser treats an
  unknown `kind` as an empty region rather than rejecting the record), but
  the older build's next write drops it — the protection is for the
  same-device stale-tab window while a newer build is rolling out, not a
  migration story. `RegionModelContext`
  writes the record on every arrangement change, coalesced to one write per
  burst (150 ms trailing edge, flushed on `pagehide`), and adopts another
  tab's write through the store's `storage` listener without writing it back.
  A mount never writes.
  Maximize persists across launches through the record (#928 slice iii);
  before it, `maximize=true` lived in the URL alone and a relaunch lost it.
  A maximized region also owns the dock area in CSS: while one shell is
  maximized every other shell is hidden (`index.css`, pinned by
  `region-maximize-owns-dock-area.test.ts`).
  Precedence at load, highest first: a URL deep link, for Chat only —
  `dockSlotPlacement` places Chat there through `placeSurface` (joining the
  panes the region holds), `dock=open` shows it, and `maximize=true`
  maximizes Chat's region (restoring any other); each of the three selects
  Chat's tab in the region it acts on, since 2b (2a review: they are Chat's
  links, and a region showing another pane's tab is not what they named);
  the same holds for the inbound `dock=open` and `maximize` a
  `focusSession` reveal writes later; then the
  record, when it differs from the registry default, for every surface's
  placement, size, visibility and maximize, Chat's included; then the legacy dock seed
  (`chatDockHeight`/`chatDockWidth`, the `dockSlotPlacement` device setting),
  which is all a pre-record device has. A record equal to the default is one
  the device has never written and reads as absent, which is what carries a
  pre-record device's dock position through the upgrade. Sizes render from
  the record: a shell seeds its own region's size and falls back to the
  legacy keys only without a region model (`useDockShellChrome`). A record
  and legacy keys that disagree are reconciled by Chat's mirror on the next
  user change. The parser (`src-ui/src/regions/region-arrangement-record.ts`)
  is the record's only validation and fails closed per field: a surface the
  registry no longer has (retired since the record was written), or one that
  does not declare the region it was stored in, is dropped — the whole region
  reads as empty for the `surface` form, the one pane for a `pane-host`,
  whose other panes are kept; a `pane-host` without an array of panes reads
  as empty, and a `selected` that is not one of the
  kept panes falls back to the first; a surface named by two regions keeps
  the first in `main`, `left`, `right`, `bottom` order and is dropped from
  the later regions' panes, a region left with nothing reading as empty and
  keeping the visibility the record stored (#2153); `main` reads at most one
  pane, its selected one; `main` is always visible and never maximized, nor
  is a hidden or empty region, and a second maximized region reads as
  restored. Chat's placement, visibility, size and
  maximize are still mirrored to the
  legacy keys, which keep every existing reader working. The `?surface=` deep
  link reveals a surface once and then clears itself; it is a command, not
  persistence.
- **Pane hosts:** each host persists its own document in localStorage under
  `station:workspace-pane-host:v2:` plus a scope segment (project/layout, task,
  or `ambient:<id>`). The parser rejects malformed data and reconstructs a
  bounded recovery document rather than trusting storage
  (`packages/contracts/src/workspace-pane-host.ts`).
- **Region documents (#2045):** a dock region's document is
  `ambient:<region>` — `ambient:left`, `ambient:right`, `ambient:bottom` —
  per REGION, not per occupant: a surface moving from `bottom` to `right`
  leaves one document and joins another (its pane remounts; the pane's own
  live state is the one thing a move no longer carries, and the region's
  `DockShell` is a new node — `RegionShellParity.test.tsx` retired the
  same-node pin with the per-occupant shell it described). The pre-#2045 Chat
  document, `ambient:chat-dock`, is a user's dock state on disk and its key is
  pinned (`RegionPaneHost.test.tsx`). It keeps restoring that state by
  ADOPTION: when a region Chat occupies mounts and its own key has never been
  written, `adoptLegacyChatDockDocument` restores the legacy document against
  the Chat catalog, re-identifies it as the region's and persists it under the
  region's key. This is per REGION, on that region's first Chat mount — a
  device whose Chat has lived in `bottom` and later in `right` adopts twice,
  once into each — and the legacy key never retires: it is left in place for
  an older build in the same-device stale-tab window and, being what every
  later adoption reads from, is never rewritten by a region either. Stated plainly: every build that ever wrote
  `ambient:chat-dock` wrote it with Chat as its only pane, so its content
  equals the region's baseline and the adoption carries nothing a fresh
  baseline would not — it is the mechanism by which the key is honoured, not
  a migration with data at stake. The model-less mount (`ChatDock` without a
  region, the pre-region path App-level tests still take) is Chat alone and
  keeps the legacy document as its own.
  A region's document is DERIVED from the arrangement (#2046 2a): its panes
  are `RegionState.panes`' entries in tab order and its active pane is the
  selected one (`createRegionPaneHostDocument`). The document carries no
  placement fact the arrangement does not; the arrangement is the authority
  for what a region holds and which pane shows, and the record's `pane-host`
  variant carries that inline (above) rather than pointing at the document.
  Two things keep the persisted document in step with it. While a host is
  mounted, a changed pane set is a new authority fingerprint and the
  controller restores the derived document, revoking the panes the region no
  longer holds — the fingerprint path alone, with no per-occupant remount
  (decision 4; `RegionPaneHost.regions.test.tsx` proves it under a stale
  persisted document, the test #2045 named as the condition for dropping its
  occupant key). At mount, hydration can drop a persisted pane the region no
  longer holds but never ADD one, so a region key written with one pane
  while the record now names two is rewritten to the derived document before
  the host reads it (`reconcileRegionPaneHostDocument`) — like adoption, a
  mount that writes the region key, and only when the two disagree.
  Selection runs one way through the host: it makes the controller's active
  pane follow the arrangement's selected pane (through the controller's own
  `focusExisting`), and only when the two differ. A region host's controller
  is constructed with `navigationSelection: false`, so that follow writes no
  history entry and no `?pane=` param, and an inbound `?pane=` naming one of
  its panes moves nothing — the model is the only selection authority for a
  dock region, where the layout hosts keep `?pane=` as theirs. The tab strip (#2046 2b) never
  writes the controller: a tab click is the model's `selectPane`, a close
  its `removePane`, a reorder a `panes` write, the placement grab
  `moveRegionPanes` — so the arrangement stays the one authority and the
  host follows it as it follows a chord. `region-arrangement-record.test.ts`
  keeps pinning that an unknown `kind` reads as an empty region.
- **Layouts:** server records per project (`LayoutConfig`); the shell restores
  the last project and layout on launch.

Scope decision (owner, 2026-09-01, reaffirmed 2026-09-04): the arrangement is
**per device**. Placement is a property of the screen you are sitting at. A
layout that repositions the dock, or a per-project memory, is the category
error the region model was built to remove; per-project placement may return
later as an explicit additive preference.

## A region's occupant is a pane-host document

The direction, recorded on #928: a region holds a **pane-host document** whose
panes are the surfaces placed there. That gives, from one mechanism:

- any pane in any region (the epic's "maximum flexibility" decision);
- tabs and splits inside a region, without a second container concept;
- one persistence shape for the whole arrangement (region map plus one
  document per occupied region), so slice D does not persist a single-id
  record that later slices would have to migrate.

**Implemented by #2045 (slice 1 of #2044), 2026-09-13.** Each dock region
owns one document (`ambient:<region>`) and renders its occupant as a pane of
it through `RegionPaneHost`; Chat and Activity both go through that host, and
the per-occupant shells (`AmbientChatDockPaneHost`, the dock branch of
`ActivityRegionShell`) are gone. The surface-id API is unchanged —
`placeSurface`, `showSurface`, `toggleSurface`, the toolbar, `?surface=`,
chords and the region menu all still speak surface ids — and the host stays
`presentation="chromeless"`. Externally the only differences are that a move
between regions remounts the moved pane (the document is the region's), and
that Activity's loading skeleton renders inside its shell rather than in
place of it.

**Implemented by #2046 part 2a (the model half of slice 2), 2026-09-13.** A
dock region holds a set: `RegionState.panes` in tab order, `occupant` the
selected one, `selectRegionPane` / the provider's `selectPane` to change it.
`placeSurface` into an occupied dock region joins instead of displacing
(decision 3); `main` keeps displacement and one pane. The record writes
`pane-host` for a region holding two or more (decisions 1 and 2) and the
parser resolves the set. The host derives its document from the panes and
follows the arrangement's selection; its occupant key is gone (decision 4).

**Implemented by #2046 part 2b (the chrome half of slice 2), 2026-09-13.** A
dock region renders a tab strip of its panes with the selected pane below
it. The strip lives in the region's chrome bar (`RegionChromeBar`, in the
`RegionPaneHost` chunk), which owns what belongs to the REGION — the
placement grab, the strip, maximize and visibility, and the click surface
that collapses the bar — and carries two slots the selected pane's own
toolbar renders into: `ChatDockHeader` is Chat's toolbar now (identity,
context meter, project context, session counter, More menu) and portals into
the bar, so a dock still has ONE chrome bar (#1064, #3309); `ActivityDockPane`
has no bar of its own. The pane host's `dock` presentation mounts the
selected pane as the strip's `tabpanel` and nothing else — a pane behind a
tab is not mounted, as the chromeless host never mounted it. The strip
writes the model: a tab click is `selectPane`; close is `removePane`, which
UNPLACES the surface (it is in no region afterwards, the state `main`'s
displacement already produces, so its chord, its toolbar row and
`showSurface` all place it afresh; hiding — the visibility control — hides
every pane of the region, which is a different thing); a reorder (Alt+Left
/ Alt+Right on a tab, or a pointer drag over a neighbour) writes `panes`;
the placement grab moves the whole region (`moveRegionPanes`: every pane,
in order, with the selection). Close renders only with two or more tabs;
the strip renders only with two or more panes (a one-pane region's bar is
the pane's toolbar, which #1064 decided is worth more than the pane's own
name). A closed Chat tab is the one close with a navigation mirror: Chat
leaving a showing region reads as the dock closing (`dockMirrorDiff`), and
`syncRegionArrangementFromDock` re-places an unplaced Chat only on an
explicit open (`dock=open`, a `focusSession` reveal), the first free dock
region (`firstFreeDockRegion`: the requested one when empty, else `right`,
`bottom`, `left` — #2156) else joining the requested one — a closed dock
leaves it unplaced.

The four forks of the 2a plan, as taken (each reversible on its own):

- **D1 — collapsed bar: header only.** A collapsed region is the bar alone,
  at the unchanged `--chat-dock-header-height` (38/53px); the strip hides
  with the body (it also shows during a drag from Collapsed, as Chat's
  pane controls do), and the selected pane's toolbar keeps its
  collapsed-state affordances ("Start a chat", #800).
- **D2 — folded menu (bottom-only devices): rows per region.** Each
  occupied dock region contributes its panes in tab order: the selected
  pane's row is the region's Hide/Show, a pane behind a tab gets a Show row
  that selects it (2a's toggle). Then the `main` occupant's "Move … to the
  dock" and a Show row per unplaced dock surface. A coarse device renders
  no strip; from Chat, its mobile overflow sheet lists the region's other
  panes ("Switch to Activity") from `DockShellChrome.regionPanes`, and the
  toolbar's `⋯` rows are the way back. The app toolbar gains no control.
- **D3 — `#chat-dock`, the "Dock" landmark, `dock.maximize` (⌘M), the
  persisted snap key and the project binding's cleanup belong to the region
  whose PANE SET includes Chat**, whether or not Chat's tab is selected.
  `DockShell`'s `occupant === 'chat'` branches are "panes include chat";
  `surfaceTitle`, `surfaceShortcutId` and `canMaximize` still name the
  selected pane, so the visibility control reads "Hide Activity" on Chat's
  shell while Activity's tab is selected.
- **D4 — `SurfaceGlyph` stays keyed on `RegisteredSurface.icon`**; the strip
  labels tabs by title and imports no descriptor.
- **D5 — `placeSurface` into an occupied dock region joins** (2a); the
  strip is what makes the joined pane visible.

**Implemented by #2047 (slice 3: dock admission for the built-in panes and the
dock catalog), 2026-09-13.** Terminal, Diff and Files are dock surfaces
(`coding:terminal`, `coding:diff`, `coding:file-browser` — the
`pane:builtin:<surface id>` rule the pins assert), catalog-only (`exposure:
'catalog'`: no picker row, no chord, no unplaced Show row) and singleton per
kind, each bound to the DOCK'S ACTIVE PROJECT (`chatDockProjectSlug`, else the
route's active project) through `REGION_SURFACE_PANES`' instance factory: a
docked coding pane is the project's, not a layout's (`needsLayout` is "has a
layout binding", the `ChatPane` rule; the working directory falls back from
the layout's to the project's; a layout-less Files pane keeps a file click out
of `setLayout`, and a docked Files pane cannot open a preview until #2049 — a
click selects the row only, because File Preview is no region surface and the
region host refuses its occurrence). A project switch re-binds a mounted pane
through the host's authority fingerprint (the instance's `boundContext` is
part of it). With no active project the placed pane keeps its tab and its
record and the region shows "Choose a project for this dock"; while that
project read is still in flight the region shows the pane's loading skeleton
instead, and the mount-time reconcile is deferred rather than run on a pane
set derived from it (a region whose selected pane the dock already supplies
still mounts its host on the pending-time document, and the deferred
reconcile restores the full set once the read settles). The "+" was not
offered without a project (until #2154, whose chooser lists a projectless
dock's coding rows disabled with the reason). The "+" lives in the region bar's actions
cluster beside maximize, fine pointer only, and renders for a one-pane region;
its catalog as #2047 shipped it (`RegionPaneCatalog`, over `ProjectWorkspacePaneModal` — retired by #2154 for the registry-driven `RegionEmptyChooser`) listed the
panes declaring `docked` for the dock project, a `docked` pane needing a
context the dock cannot supply listed disabled with the resolver's reason
(`missing-task`) — a mechanism no shipped pane reaches today: the task-room
panes declare `primary`/`secondary`, not `docked`, so the catalog's filter
drops them and they are neither listed nor explained; a fixture descriptor is
its only exerciser — and its Open is `openInRegion` — never a host's own open
action, which would refuse a pane the region does not yet hold. Browser
Preview and File Preview are deliberately NOT `docked` yet: they have no blank
canonical instance (a URL, a file path), so a catalog could list but never
open them; #2049's `openInRegion` over instance-keyed panes is their reader,
and their docblocks say so.

**Implemented by #2048 (slice 4: `openInRegion`), 2026-09-13.** One intent
opens a pane instance in a dock region: `useOpenInRegion` (a sibling of
`useShowSurface`) folds the instance to its surface through the inventory and
hands it to the provider's `openSurfaceInRegion(surfaceId, { region?,
placement?, focusExisting? })`, which resolves the target (explicit, else the
surface's own rule: its region if held, else its default region or the first
free dock region — `right`, then `bottom`, then `left`, since #2156), reveals
it and places or selects through the model.
`showSurface` is reimplemented over it. An instance already open somewhere is
revealed where it is (`focusExisting`, default on) rather than opened twice —
unless a DIFFERENT region is named, which moves it there: the default reveals,
it does not override an explicit target; a refusal — `no-surface`,
`unsupported-placement` (`split`: a region holds one tab group),
`region-unavailable` (a side region on a bottom-only device), `refused` (an
undeclared region) — is a typed outcome that writes nothing and navigates
nowhere; no open pushes history or a `?pane=`. The instance-keyed half lives
outside the provider on purpose: the pane contracts are not in the entry
chunk, and importing them there measured +1,820 B gzip against the ceiling's
headroom.

**Implemented by #2049 (slice 5: instance-keyed dock panes and the chat link
handler), 2026-09-14.** A pane that is one-per-THING rather than
one-per-Station holds its own identity in `RegionState.panes` — a pull
request is `pr:<host>/<owner>/<repo>#<n>`, a file preview is
`file-preview:<nonce>` — and `INSTANCE_SURFACE_PREFIXES` +
`resolveRegionSurface` are how every id-keyed reader resolves it: the record
parser, `surfaceMayOccupy`, the provider's open and toggle, `RegionShells`'
mount rule, `RegionPaneHost`'s document, titles and admission, the folded
Regions menu and the dock landmark. The record shape is UNCHANGED
(`{ kind: 'surface', id }`), so a build without this reads such an id the way
it already reads a retired surface — dropped on parse, dropped on its next
write; the stale-tab story above covers it. The table is split in two on
purpose: `region-model.ts` carries the id-keyed half as plain data and
imports no pane contract (entry chunk), `region-surface-panes.ts` mints the
occurrence, and `region-instance-panes.test.ts` pins the two to one family
each. `workspace-file-preview` and the new `workspace-pull-request`
descriptor declare `docked` now that the reader #2047 waited for exists, and
`dockCatalogEntries` dropped both from a region's "+" (and since #2154 the
chooser lists registry surfaces, of which they are none): neither has a blank
canonical occurrence, so a card could be listed and never opened.
`openPullRequestInRegion`/`openFilePreviewInRegion` own what a bare
`openInRegion` cannot — the Project binding a refusal must report
(`unsupplied`) and a preview's persisted state, written before the placement
and rolled back when the model refuses. A preview's IDENTITY is its file
even though its id is a nonce, so a second click on the same path reveals
the tab it already has; a pull request's identity is its normalised id, so
the reveal is the model's own. On the chat side, `classifyMarkdownLink`
decides what a link names by PARSING absolute URLs (the pathname names a
pull request; a host carrying the shape in its query is external) and
`ChatMarkdownAnchor` opens it, leaving the browser what the browser owns: a
modified or non-primary click, a middle click, an already-prevented event,
and every anchor outside a conversation. The CONVERSATION's project resolves
a path, not the dock's binding; where they differ the link keeps the
`setLayout` route it had, because a dock pane binds the DOCK's project and
rebinding would name a file in a checkout the conversation never mentioned.
Bottom-only devices keep that route too. A path with NEITHER a dock pane nor
that route is refused rather than followed, on both hosts: a repo-relative
href resolved against Station's own origin is a route Station does not have,
which on Tauri replaces the running application and on the web is a
same-origin route-miss that drops the conversation pointer.

External links open in the host's browser ON TAURI, where a plain anchor
navigated the webview away from the running application — that is the fix
this carries. **On the web they keep the anchor's default and replace the
Station tab.** #2049's plan asked for a new tab there; this does not do it,
and the deviation is deliberate rather than overlooked: the extracted helper
is the NATIVE half only (`openNativeExternalLink`, `null` = "no native
host"), so the MCP frame keeps its own `location.assign` byte for byte and
the chat anchor keeps the web default. Giving chat anchors
`target="_blank" rel="noopener noreferrer"` is a separate change with its
own question (whether a model's link should be able to open a tab at all)
and is not made here.

**Implemented by #2050 (slice 6: the Agents pane), 2026-09-14.** The
background work of the conversation on screen — tool calls, delegated
sessions, provider subagents — as a dock tab (`workspace-agents`,
`exposure: 'catalog'`, no chord, dock regions only). It is the SAME list as
`BackgroundTasksSheet`: `TaskRow` and its labels moved to
`backgroundTaskRows.tsx` and both render it. The occurrence binds nothing,
like Activity's — which conversation's work it shows is what the pane READS
(`activeChat`), not what it IS — and it reads no region state, so
"View transcript" reveals the delegate through `useShowSurface`. Fields the
store does not carry render absent: tokens print only where the provider
reported them, while the tool count, which Station counts itself, prints its
real zero. The Chat header's "Background tasks — N running" row places the
pane where a side dock region exists and opens the sheet where it does not,
and the dialog semantics go with the sheet. It is not declared to the server
catalog, so a region's "+" does not list it — Activity's precedent, for
Activity's reason.

**Implemented by #1969 (the Device pane), 2026-09-14.** A captured
simulator or emulator screen as a dock tab (`device`, `exposure: 'catalog'`,
no chord, dock regions only, `right` by default because a device screen is
portrait-tall). It rides the #2047 path exactly as this record prescribed:
descriptor with `docked`, registry entry, inventory entry, renderer, and the
lockstep pins. Two things make it the first of its shape.

It is the first registered surface that has a catalog card AND ignores the
dock's context. Its inventory entry answers the same constant whatever the
context, like Chat's and Activity's, because a device list is a fact about the
STATION's host rather than about a checkout — so a Device pane renders in a
dock with no project instead of showing "Choose a project for this dock". It
is also declared to the SERVER catalog, unlike Activity and Agents, because a
region's "+" is its only offer and the catalog's Open needs an entry carrying
an instance. That declaration names neither a `context` nor a
`requirements.hostCapabilities`: Device needs no Project, and viewing a
captured PNG needs no desktop capability, so claiming either would be a
requirement nothing derives (`workspace-pane-known-declarations.test.ts` pins
both omissions against Browser Preview as its control).

The cost of the singleton is stated rather than hidden: one Device pane per
region set, so two simulators side by side waits for an instance-keyed Device
family riding the #2049 prefix mechanism. Which device is selected is bounded
pane STATE, not pane identity — the selected target is what the pane reads,
not what it is — which is the same distinction that keeps a routed session id
out of Activity's instance. The "+" stays project-scoped
(`RegionPaneHost` gates it on `projectSlug !== null`), so a Station with no
project cannot reach a pane that needs no project; that limitation is #2047's
and is documented here rather than widened by this slice.

## A Board or a Layout as a pane (#2157)

**Implemented by #2157, 2026-09-16.** The sidebar's Boards pills and a
project's Layout chips name `LayoutConfig` records; a dock region can now hold
one of those beside Chat, as an instance-keyed pane riding the #2049 prefix
mechanism. Not the Session Board (`pane:builtin:board`, one per project), which
stays a route.

**Id grammar.** A Board is `board:<layoutId>`; a project Layout is
`layout:<projectId>/<layoutId>`. Both parts are the server's own ids
(`randomUUID()` on create, so lowercase UUIDs — `workspace-layout-pane.ts`
pins the shape and refuses anything else, including a slug or a comma, which
`regionStatesEqual` joins on). Ids rather than slugs because a slug is
renamed and reused while an id is minted once, and because a Board carries
the SAME id through promote. A project Layout carries its project IN the id:
the id alone does not name a project, `useProjectLayoutsQuery` is
slug-scoped, and the dock's own project is the wrong answer — a region holds
another project's Layout as readily as its own, and a dock with no project
still renders one. So the occurrence binds the project the id names and the
host's admission (`RegionPaneHost`, which compares `boundContext.projectId`
against the derived occurrence) sees the same project on both sides. A Board
binds none. Both families share one descriptor,
`pane:builtin:workspace-layout` (`docked` only, one requirement-free mode,
not offered by the region's "+": there is no blank occurrence).

**Title.** The tab shows the Layout's `name` — the same word the pill shows —
resolved by `RegionPaneHost` from the SDK's metadata LISTS
(`LayoutPaneTitles`: `usePersonalLayoutsQuery`, `useProjectsQuery` +
`useProjectLayoutsQuery`), mounted only while the region holds such a pane
and reading no record, so the host chunk gains no layout renderer. Until the
list resolves, and for an id the list no longer carries, the tab shows the
prefix fallback ("Board" / "Layout").

**Which kinds render.** The renderer (`LayoutWorkspacePane`, lazy) is
`PersonalBoardView`'s: the one `LayoutRenderer` through the one
`layoutWorkspaceShape` derivation, `SDKAdapter` with `boundProjectSlug` for
a project Layout, local tab state, and NO `LayoutNavigationProvider` (it
writes `location.hash` and would fight the main region's for the one
hash). A Board always renders. A project Layout renders only when
`ProjectLayoutRenderer` would send it to `LayoutView`
(`resolveProjectLayoutRendererKind` === `'layout-view'`); every other kind
shows "Open this Layout in Main" whose action is `setLayout`. `coding` is
refused because it is a whole `WorkspacePaneHost` whose storage key, `?pane=`
scope and DOM ids derive from `(projectId, layoutId)` — a docked copy would
share the main region's persisted document and duplicate element ids.
`chat` is refused because it suspends the ambient regions it would be docked
in (`App.tsx`). `tasks`, `session-board` and `review` are route-shaped pages
(`layoutTypeRegistry`) and docking them is a separate decision this change
does not make. An id the list no longer carries — a Board promoted, a Layout
deleted — renders "not found" in the tab; the tab stays, because closing a
tab is the user's act.

**A built-in tab that reads the route.** `SDKAdapter`'s `boundProjectSlug`
rewrites the SDK's navigation, which every plugin tab reads; the built-in
`flow-run-console` tab reads the UI's own `NavigationContext` instead, so a
docked Layout of project B would have shown project A's runs. `LayoutRenderer`
now carries `boundProjectSlug` (`AgentLayoutProps`) and that registry entry
passes it to `FlowRunConsole`; the route-bound hosts pass none and keep their
behaviour. No other built-in tab reads a project (audited 2026-09-16:
`DefaultLayout`, `UnavailableLayoutTab`, `KitStandardViewLayout`,
`MCPToolUILayout` read none; `UnsupportedLayoutComponent` reads navigation
only to `navigate('/registry')`).

**Deliberately not carried.** A docked Layout gets none of `LayoutView`'s
agent affordances — no `annotateAgentRef` (`agentAvailableInProject`), no
`onLaunchPrompt`, no `onShowChat` — for a Board because there is no project
to filter against (`PersonalBoardView`'s reason), and for a project Layout
because a prompt launch binds a chat session to the ROUTE's project through
`LayoutView`'s handlers and action bar, which a dock tab beside Chat does not
have. A docked Layout reads and navigates; it does not launch. The SDK
header still renders the layout's prompt buttons with a no-op launcher, so a
docked Layout that carries prompts shows inert controls today; wiring the
launch to the pane's bound project, or hiding the bar, is #2171.

**Openers.** `openSurfaceInRegion('board:<id>')` from the model, or
`openLayoutInRegion(model, key)` in `useOpenInRegion.ts`, which mints the
occurrence and refuses an id the grammar cannot (`no-surface`). This slice
adds NO sidebar entry point; #2158 adds the context menu and drag.

**One-way rollback, disclosed and accepted.** The record shape is unchanged
(`{ kind: 'surface', id }`), so a build without this reads a `board:` or
`layout:` id the way it reads a retired surface — dropped on parse, dropped
on its next write — and the tab is lost. The stale-tab story above covers it.

**Still direction.** More instance-keyed families ride the #2049 prefix
mechanism as their own change (a second terminal, Browser Preview): a prefix
entry naming a descriptor that declares `docked`, the minting half in
`region-surface-panes.ts`, a `RegionBuiltinPane` map entry, and the pins in
`region-instance-panes.test.ts` and `docked-capability-derivation.test.ts`.
The Device pane (#1969) rides the #2047 path instead (descriptor with
`docked`, registry entry with `exposure: 'catalog'`, inventory entry,
renderer, the four lockstep pins) — done, see above. A `?surface=pr:…` deep link stays
IGNORED: materialising a pane from a URL is a new entry point nobody asked
for.

## The toolbar is per region (#2143)

#2044's outcome sentence — "the top-of-app region toolbar then only needs
show/hide/maximize/placement per region, because *what* is open lives in the
region's tab strip" — is what this records. Three shapes preceded it: five
unlabeled per-region glyphs (before #1536 F), one "Layout" control (#1552),
and that control's per-SURFACE placement picker (#1571 D2: a row per surface,
a segmented choice of regions plus Hidden). The picker answered "where is
Chat?", while every control the epic shipped after it — the tab strip
(#2046), the "+" (#2047), the region bar's grab, maximize and chevron —
answers "what does this REGION hold, and is it open?". Two vocabularies for
one arrangement, and no control at all that said whether a region was open
(a hidden region has no bar; the only way back was a surface row).

- **One toggle per dock region**, in screen order (left, bottom, right),
  `aria-pressed` derived from `RegionState.visible`; a press shows or hides
  the region, so every tab comes back with the selection it had. The
  accessible name is the region's ("Bottom region") and the panes it holds
  are the tooltip, so a journey finds the same control in every arrangement.
  Two things this slice left open are settled by #2155 below: what the
  control is for an EMPTY region, and the parity gap between the toolbar's
  bare `setRegion(region, { visible })` and the chevron's `applyDockSnap`.
- **A pane's placement is its tab's.** A tab's context menu (right-click, or
  the keyboard's context-menu gesture where the browser turns it into a
  `contextmenu` event; the menu anchors under the tab either way, never at
  the pointer, and flips above the tab when there is no room below rather
  than sliding up over it, so it does not cover its own trigger — #2112's
  rule) offers
  "Move to <region>" for the regions the pane
  declares on this device minus the one its shell renders in, `main`
  included for a pane that declares it; a choice is `placeSurface` (joins
  the target, leaves the source). A tab exists only in a region holding two
  or more panes, so the region bar carries the SAME menu for the pane it
  shows, as a "Move <title>" button in its actions cluster beside the "+"
  (#2160) — one `moveTargets` derivation, one open menu, whichever trigger
  opened it. That is the route a LONE pane has: it reaches every region it
  declares, `main` included, without first acquiring a tab, where the bar's
  ⋮⋮ grab moves the whole region and offers dock edges only. Fine pointer
  only, like the "+"; and the button is absent when the selected pane has
  nowhere to go.
- **`main` has no toolbar control and no tab.** It is always visible and
  renders no `RegionChromeBar`, so a surface holding it (Activity) leaves
  through: a dock region's chooser, which lists it as "Move here from Main"
  (#2154; #2143's "Show Activity here" offer row); its chord
  (⌘⇧A, `toggleSurface`: to its default dock region, Home back in `main`);
  or the sidebar's Home row (`showSurface('home')` places Home, and the
  displaced surface is unplaced — its chord or sidebar row places it
  afresh). With every dock region occupied there is no pointer route in the
  toolbar itself; the picker's `Hidden` segment for a `main` occupant was
  unconditional, and this is the one capability the toggles narrow.
- **Folded devices are unchanged.** A bottom-only device has one dock, so its
  one folded menu (D2 above) is already the per-region control.

Retired with it: `RegionPlacementPicker`, `placementRows` and the
`.region-placement*` rules; `useRegionSurfaceMenu.placement.test.tsx` became
`useRegionSurfaceMenu.toggles.test.tsx`; the e2e helper
`placeSurfaceThroughLayoutPicker` became `toggleRegionThroughToolbar`,
`showSurfaceInEmptyRegion`, `moveTabToRegion` and `moveLonePaneToRegion`. The #2113 finding that the
picker's rows did not clear a 44px touch floor closes with the picker.
`showSurfaceInEmptyRegion` keeps its name through #2155 and drives the two
controls that replaced the offer menu.

### Defaults (#2156)

Which region a surface starts in is a product decision, and the owner's
direction of 2026-09-15 settles it: **Bottom is Chat's.** Terminal joins it
(`coding:terminal`'s `defaultRegion` moves from `right` to `bottom` — a
terminal belongs under the conversation that is driving it), Files stays on
the left (`coding:file-browser`), and everything else that is not Home
defaults to the right: Activity, Agents, Device, Diff, and the four
instance-keyed families (`pr:`, `file-preview:`, and #2157's `board:` and
`layout:`). Home's only placement is
`main`. The table is pinned in `region-model.test.ts`, so a later change to
any entry is an argued edit rather than a drift.

The fallback order moves with it. `firstFreeDockRegion` returns only an
EMPTY region, so under either order nothing lands beside a pane already
there; the order decides which empty edge a surface takes when its own
default is taken. It now tries `['right', 'bottom', 'left']` rather than
`bottom` first, so a surface with nowhere of its own to go takes the right
edge and leaves an empty Bottom for Chat, which is where Chat lands next.
The one journey this changes today is Chat itself: unplaced, with a
remembered `left` dock placement that is occupied and both other edges free,
Chat now re-lands right rather than bottom (`syncRegionArrangementFromDock`).
Accepted: the rule has no Chat-shaped exception. Terminal's new default is
read by the `?surface=coding:terminal` deep link and by nothing advertised in
the UI today (the region "+" always names its region); it is a default that
#2154's chooser and later openers inherit.

Both are DEFAULTS, not rules: Bottom refuses nothing. Every dock-capable
surface still declares all three dock regions, so a tab's "Move to Bottom",
an empty Bottom's "+", and a region grab put anything there, and the
arrangement that results is persisted as the user's.

## An empty region may be visible (#2153)

Until #2153 a dock region existed only while something occupied it: the model
hid a region its last pane left, the record parser hid an emptied one on read,
and `RegionShells` mounted no host for an empty region. The three together
made "empty" and "hidden" the same state, so a region was not a place the user
could open and then fill — it was a side effect of a surface being somewhere.

**Owner decision, recorded on #2153: closing a region's LAST tab leaves the
region visible.** It empties, and stays open showing its chrome bar over a
placeholder that names it ("Nothing in the Right region yet"). Hiding is the
chevron's and the toolbar toggle's act — the two controls that are named for
it — and nothing else writes a region's visibility. A MOVE is different: a
region a surface LEAVES by placement (`placeSurface`'s vacate, the ⋮⋮ grab's
`moveRegionPanes`) hides when it empties, because the user is putting that
content somewhere else, and an empty placeholder left behind would be a
second dock nobody asked for — the join journey in
`project-architecture.spec.ts` pins "does not open a second dock". Both
paths share `withoutRegionPane`; the caller says which rule applies
(`whenEmpty: 'keep' | 'hide'`), so the close and the move cannot disagree
about who selects the neighbour, while disagreeing on purpose about
visibility.

What this slice did NOT do: the placeholder names the region and stops
there. The chooser that offers what can go in an empty region is #2154, so
the region's "+" stayed hidden while it was empty rather than putting two
answers to "what goes here" on screen. Which control the TOOLBAR button is
for an empty region was left to #2155, which made it a plain toggle; #2153
only made that button report the region's real visibility and made
`RegionToggle.onToggle` act on an empty region instead of returning — a
change to the hook's contract whose first caller is #2155's toggle.

Visibility gates only the EMPTY case in `RegionShells`. A region that holds a
pane still mounts its host whether or not it is visible, because hidden IS
the collapsed bar for an occupied region (fork D1) — unmounting there would
take the bar the chevron collapses to off screen with it.

An empty region is still never maximized (`updateRegion`, the parser), and
`main` is unaffected: it was always visible with a null occupant, which the
outlet renders as Home.

**Rollback is benign, not a clean re-hide.** The record shape does not
change — a visible empty region is `visible: true` beside a null occupant,
which every build can already write and parse. An older build reading those
bytes does NOT re-hide it: its parser coerced visibility only inside the
duplicate-drop branch, so a plain visible-empty region parses as open while
that build's `RegionShells` mounts no host for it. The result is a region
the model calls open with nothing on screen for it — invisible in effect,
and the next placement or hide writes it back to a state every build agrees
on. Nothing is lost, because an empty region holds nothing.

**What produced the state when this slice landed: nothing in the product.**
The only `'keep'` path is `removeRegionPane`, reached from a tab's close, and
a close control renders only for a region holding two or more tabs — a
region's LAST tab has no close. So until #2155 gave the toolbar toggle a
plain show on an empty region, the visible-empty state, its placeholder, its
self-named chrome and its chord suppression were exercised by tests and by a
record written that way, not by a control. Since #2155 a press on any hidden
region's toggle produces it. Two consequences that came with it: hiding an
empty region unmounts it (an occupied one collapses to its bar), so it is the
toolbar toggle — never a control inside the region — that brings it back; and
a visible empty region reserves its full workspace clearance for a chooser.

On a coarse device the fold prefers a visible region that HOLDS panes over
a visible empty one when `lastShownRegion` does not decide, so the one dock
such a device shows is never a placeholder while the user's panes sit in
another visible region.

## The empty region is a chooser (#2154)

An empty, visible dock region (#2153) renders ONE chooser in its body —
`RegionEmptyChooser`, inline — and the region bar's "+" opens the same rows
as a `menu` anchored to the button. The toolbar's toggles only open and
close; the pane controls what goes in it. Bottom refuses nothing: the rows
are the registry's decision, not the chooser's.

- **What lists.** Every surface in `REGION_SURFACE_REGISTRY` whose `regions`
  includes this region, in registry order: Chat, Activity, Agents, Device,
  Terminal, Diff, Files for a dock region; Home drops out by its own
  `regions`. No `exposure` filter — a catalog-only surface is exactly what a
  region's own chooser is for. Instance-keyed panes (`pr:`, `file-preview:`)
  are not registry keys and are not listed; their opener stays the chat link
  handler (#2049). The rows are registry-driven, not the resolved project
  catalog (recorded, reversible: the catalog's availability resolver answers
  "can this project's pane run?", and a projectless dock has no catalog to
  ask).
- **What enables.** A row is enabled iff `regionSurfacePane(id).instance(context)`
  is non-null under the dock's context — a coding pane has no instance
  without a project, so Terminal, Diff and Files list DISABLED with the
  dock's own sentence ("Choose a project for this dock before opening that
  pane."), `aria-disabled` so the row stays in the tab order and its name
  carries the reason. Chat, Activity, Agents and Device need no project.
  The rows follow the project read: a coding row enables the moment the
  dock binds a project.
- **Move semantics.** A surface placed elsewhere is listed, not hidden — the
  toolbar's offer menu already offered a placed surface — with "Move here
  from <Region>" derived from `occupiedRegion`. Choosing it is
  `model.openSurfaceInRegion(id, { region })`, which for a held surface with
  an explicit other target is `placeSurface`'s existing move: the surface
  joins this region, selected, and the region it empties HIDES (#2153's
  move rule; nothing new is added for it). A surface this region already
  holds reads "Already here" and reveals its tab. A refusal is one sentence
  under the rows (`describeOpenInRegionRefusal`); nothing closes.
- **The "+" route.** Offered for every dock region under the model, empty or
  not, project or not (A6) — only the project read in flight withholds it
  (review M3). It is a menu trigger (`aria-haspopup="menu"`,
  `aria-expanded`), and its panel carries the toolbar menus' dismiss contract
  (backdrop release, Escape, focus return, arrow-key roving) and flips above
  the button when there is no room below (#2112's rule). A choice closes it.
  Since #2155 a hold or a right-click on the region's TOOLBAR toggle opens
  the same panel, anchored to the toggle instead.
- **Retired.** `RegionPaneCatalog` (#2047 D4's `ProjectWorkspacePaneModal`
  over the dock project's resolved catalog) and `dockCatalogEntries` with
  its tests: nothing else read them. `ProjectWorkspacePaneModal` keeps its
  two layout-picker mounts. The `docked` placement word now has no reader
  that OFFERS a pane; the docked-capability pins still assert it of every
  region surface's descriptor.

## The toggles only show and hide (#2155)

The owner's direction, recorded on #2155, settles what the region toolbar is:
**"by default if you just click it it should just open or close it"**, and
**"maybe if you do a long tap or click that could be an option"**. The toggles
do not control content; the pane does. #2143 had left an EMPTY region's button
as a menu of what could go there, which by #2154 was a second answer to "what
goes in this region" standing beside the region's own chooser.

- **D1 — every toggle is a toggle, in every state.** `aria-pressed` is the
  region's visibility for all three; none carries `aria-haspopup`, and none is
  disabled or `aria-disabled`. A click on a hidden region shows it — empty, on
  its chooser (#2154, #2153) — and a click on a visible one hides it. The case
  that produced the inert button (a region NO shell surface declares) is an
  ordinary toggle too: showing a region is a thing that happens whatever the
  registry says, and what there is to put in it is the chooser's answer.
- **D2 — the hold is the second act.** A press held 500ms without wandering
  past 8px, or a `contextmenu` (a right-click, and the keyboard's context-menu
  key, which browsers deliver as the same event with no pointer sequence),
  opens #2154's chooser anchored under the toggle. `contextmenu` is prevented,
  so the control opens its own panel rather than the browser's. On a coarse
  pointer the hold is the only route, which is why it exists. The click that
  the hold's release still produces is SUPPRESSED — exactly one, cleared at
  the click and again at the next press — or the gesture would open the panel
  and toggle the region under it. The toggle does not announce the panel with
  `aria-haspopup`: its primary act is the toggle, and the panel is a shortcut
  to a control the region also carries.
- **D3 — the toolbar hide IS the chevron's hide.** Each mounted region shell
  publishes its own `setRegionOpen` — the expression its chevron presses,
  which goes through `applyDockSnap` — into
  `src-ui/src/regions/region-visibility-appliers.ts`, keyed by the region it
  renders; `RegionToggle.onToggle` calls it. One derivation with two callers,
  so a region hidden from the toolbar records the snap, clears `maximized` and
  reopens where the chevron would have reopened it. #2143's toolbar wrote
  `visible` alone, so a region hidden while maximized came back maximized and
  its shell's snap never learned it had collapsed — a gap that slice's own
  docblock recorded.

  A module-level registry rather than a field on `RegionModelValue`: this is a
  DOM-lifetime fact (which shells are mounted right now), the model is the
  persisted arrangement's authority, and a member there would be one more
  thing every region consumer and every test double implements plus a
  re-render of all of them on each mount. It is read at PRESS time, not at
  render time, because a shell mounts and unmounts under a toolbar that does
  not re-render for it.

  With NO applier the model is written directly, `maximized: false` in both
  directions. That is not a degraded path: a hidden empty region mounts no
  host at all (#2153), so there is no shell to hold a snap for it, and the
  same is true of every region while the app renders no region hosts (a Chat
  workspace layout). Only the ambient per-region host publishes — a fullscreen
  Chat pane's own chrome instance reads Chat's region without rendering it,
  and letting it publish would give one region two appliers whose unmount
  order decided which survived.
- **D4 — three states, because "hidden" was two.** The toggles get room for
  them: a 32px box, a 1.75 stroke, a 4px gap. `is-pressed` is visible (the
  region's edge filled); `is-holding` is hidden WITH panes (the same edge in
  outline, one step down, and the primary text colour — the region is not on
  screen, but it is not nothing either); the default is hidden and empty (the
  frame alone). #2143 drew the last two identically. There is no `aria-*` for
  "hidden and holding": `aria-pressed` reports the visibility a press changes,
  and what the region holds is the tooltip's — `Hide Right region: Chat,
  Activity`, `Show Right region: Chat, Activity`, `Show Right region (empty)`.
  The accessible name stays the region's.
- **D5 — retired, not flagged off.** `RegionOfferMenu`, `RegionToggleOffer`,
  `RegionToggle.offers` and the inert branch are deleted.
  `ToolbarMenuSurface`'s one remaining caller is the folded device's flat
  Show/Hide menu. The screenshot `overlay-region-offer-menu` is replaced by
  `overlay-region-chooser-from-toggle`, held open from the toggle. The e2e
  helper `showSurfaceInEmptyRegion` keeps its name and signature and now
  drives the two controls that replaced the menu — the toggle opens the
  region, the region's own chooser fills it — and `openChooserFromToggle`
  drives the hold.

The chooser the toolbar opens is loaded lazily (`RegionChooserPanel`), so
neither it nor the pane inventory behind it joins the entry chunk the toolbar
lives in. That module carries the dock's project read with it —
`useDockProject`, moved out of `RegionPaneHost` so the host and the panel
share one derivation rather than two copies of four queries — and renders
nothing while that read is in flight, which is the rule the "+" applies
(#2154 review M3): listing the coding rows disabled with "choose a project for
this dock" would name a remedy for a state the user may not be in.

## Failure shapes this design is meant to prevent

- **A label nothing derives.** `docked` had zero readers for months while three
  descriptors declared it. It now has tests that pin it to the registry in
  both directions (see the reader map). Descriptors arriving through a plugin
  manifest, a portable kit, or a layout-tab adaptation are outside those pins;
  the parser accepts the word from them unchecked. Before adding a word to any
  placement vocabulary, name the reader in the docblock.
- **Two copies of one list.** The composition's region type is
  `Exclude<WorkspacePaneRegion, 'docked'>`, not a second array.
- **A type string standing in for a renderer fact.** `type === 'chat'` on a
  layout used to unmount every region, and a typeless plugin layout defaulted
  to `'chat'` (#1446). The shell now asks which renderer the layout resolves
  to, from the same facts `ProjectLayoutRenderer` dispatches on.
- **A producer reproducing the model's placement rules.** Every reveal goes
  through `useShowSurface` / the model's `showSurface` (#1420); the toolbar is
  not allowed its own copy.

## Related records

- [`pane-or-shell.md`](pane-or-shell.md): which things are panes and which are
  shell machinery. Regions are shell; surfaces and panes are placed by it.
- [`pane-host-contract.md`](pane-host-contract.md): the host interface a pane
  renders against, across in-process and iframe transports.
- station#928: the epic and its decision log. station#570: pane-native
  surfaces. station#265: the layout-tabs to panes migration.
