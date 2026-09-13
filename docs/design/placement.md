# Placement: regions, surfaces, layouts, panes, pane hosts

Status: **accepted direction with an implemented core** (owner decisions on
station#928, 2026-09-01 through 2026-09-04). It describes `main` once the
2026-09-04 placement batch has landed: the docked-capability pins, #1446 and
#1420 are delivered by sibling pull requests that merge before this record. The two placement layers below
ship today, and so does the "arrangement" record. The "region occupant is a
pane host" shape is implemented through its second slice (#2045, slice 1 of
the tabbed-dock epic #2044; #2046 parts 2a and 2b): each dock region holds a
SET of surfaces — its panes, in tab order, one of them selected — renders a
tab strip of them in its chrome bar, and renders the selected one as a pane
of the region's own pane-host document. What is and is not yet true is
stated under "A region's occupant is a pane-host document" below. The vocabulary here is
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
(`src-ui/src/components/header/RegionToolbarControls.tsx`) places, swaps,
shows and hides; an empty region offers what can occupy it. No surface reads
its own placement (pinned by `region-surface-boundary.test.ts`).

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
  leaving pane was the selected one) or, left empty, hides.
- **A placement into `main` navigates to `/`.** `main` renders only at `/`
  (`App.tsx` renders `main`'s occupant there through `MainRegionSurface`; a
  null occupant is Home). `RegionModelContext` is the one place that knows a
  placement landed in `main`, so it navigates after the state write, through
  the same store call `useShowSurface` makes. On any other route the routed
  view renders and the occupant is kept, not cleared. The Home destination
  (`regionSurface: 'home'`) therefore reveals Home by placing it, rather than
  navigating to `/` and showing whatever occupies `main`.
- **Coarse devices defer `main`.** The `main` toolbar control (a filled centre
  glyph; its click opens the placement menu, since `main` has no show/hide)
  exists on a fine pointer only. A bottom-only device folds its region
  commands into one control (#1400's toolbar occlusion floor) and this slice
  does not widen that fold; Home still reaches `main` there through the
  sidebar's two Home affordances (the header's app-name button and the Work
  list's Home row, `ProjectSidebar.tsx`) and the `?surface=home` deep link.
  Home is `hiddenFromNav` and has no palette entry.
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

## What reads what (verified 2026-09-05 against the placement batch (#1462, #1463, #1464) and #928 slice iii (#1385))

A placement declaration is only as real as its reader. This is the reader
map; anything not listed is a label.

| declaration | vocabulary | readers |
|---|---|---|
| `REGION_SURFACE_REGISTRY` | surface ids | `RegionModelContext` (direct), `ActivityRegionShell` (direct, for `main`'s frame title), `RegionShells` via `regionModel.surfaces` (a dock region mounts a host only for a registered occupant), the region toolbar and `useRegionSurfaceMenu` via `regionModel.surfaces`, `CommandPalette` via the destination registry's `regionSurface` field |
| `REGION_SURFACE_PANES` (#2045) | surface id → canonical `WorkspacePaneInstance` | `RegionPaneHost`: the region's document is its panes' entries in tab order, and a persisted or opened pane is admitted only when `regionSurfaceOfPane` names a surface in the region's `panes` (a stale document naming a surface the region no longer holds restores without it); `region-surface-panes.test.ts` pins the keys to the registry's dock-capable surfaces both ways, which is what lets `RegionShells` decide "mount a host" from the registry alone |
| `RegionState.panes` (surface ids, tab order; #2046 2a) | surface ids | `occupiedRegion`, `occupiedDockRegion`, `chatRegion`, `firstFreeDockRegion`, `foldedDockRegion` (a surface behind another's tab is still IN its region; a region with no panes is free), `placeSurface` (joins a dock region's panes, replaces `main`'s, removes the surface from the region it leaves), `removeRegionPane` (a closed tab: the surface leaves and is placed nowhere), `moveRegionPanes` (the region bar's placement: every pane, in order, moves), `dockMirrorDiff` (a region holding Chat, selected or not, is Chat's region; Chat leaving every region reads as the dock closing), the record writer (one pane → `surface`, two or more → `pane-host`), `RegionPaneHost` (the document is DERIVED from it; a mount reconciles a persisted document that lacks a pane), the tab strip (`RegionChromeBar`, #2046 2b: one tab per pane in this order; a reorder writes it back), `DockShell` and `useDockShellChrome` (a region whose panes include Chat is Chat's shell — `#chat-dock`, the "Dock" landmark, the `dock.maximize` registration, the persisted snap key and the project binding's cleanup — whichever tab it shows; D3), `DockShellChrome.regionPanes` (Chat's mobile overflow sheet lists the region's other panes from it), and `useRegionSurfaceMenu` (a segment for a region the surface already holds is a select, and claims no displacement; the folded menu's rows are per region, in this order) |
| `RegionState.occupant` (the SELECTED pane, a member of `panes` or null) | surface ids | every pre-2a reader keeps its meaning for a one-pane region: `useDockShellChrome` (`surfaceTitle`, `surfaceShortcutId` and `canMaximize` name the pane the region SHOWS, so the region bar's visibility control reads "Hide Activity" while Activity's tab is selected; a non-Chat region's landmark takes the same title), `RegionShells` (a host mounts for a registered selected pane), `MainRegionSurface`, `ProjectSidebar`, `useRegionSurfaceMenu` (a surface is SEEN only when its region is visible and it is the selected pane; the picker reads Hidden otherwise, and the folded menu's row for the selected pane is the region's Hide), `toggleSurface` (only the selected pane's toggle hides its region; a pane behind selects), `revealSurface`/`showSurface` (select the pane's tab), `selectRegionPane`/the provider's `selectPane` (what a tab click writes), the record's `selected`, the tab strip (the pressed tab), the `dock` host (the one pane it mounts, as the strip's `tabpanel`), and `RegionPaneHost`, which makes the controller's active pane follow it (`focusExisting`) |
| `RegisteredSurface.regions` | `main`, `left`, `right`, `bottom` | `placeSurface` via `surfaceMayOccupy` (refuses an undeclared region), `RegionModelContext.placeSurface` (a refused placement does not navigate), the region toolbar (each region's menu lists the surfaces declaring it; `useRegionSurfaceMenu` lists dock toggles only) |
| `WorkspacePanePlacement.supportedRegions` | `primary`, `secondary`, `standalone`, `docked` | parse validation; `instantiateWorkspaceComposition` (does a composition slot fit this pane); `isWorkspaceHomeRoleEligibleDescriptor` (`standalone` means "may be a route"); the docked-capability pins (`docked` means "may be a region surface"): `src-ui/src/__tests__/docked-capability-derivation.test.ts` over the built-in descriptor constants and `workspace-pane-known-declarations.test.ts` over the server's inline declarations |
| `WorkspacePanePlacement.preferredRegion` | same | parse validation and canonical-identity equality only |
| `WorkspaceCompositionPaneSpec.role` | `navigation`, `content`, `auxiliary`, `inspector` | the composition algorithm groups panes by role: tabs within a role, splits between roles. Runs on real data through the coding file/diff/evidence compositions (behind `workspaceComposition*` layout config controls) and the task room |
| `RegionState.size` | pixels | round-trips through the record; a shell seeds its own region's size from it and falls back to the legacy keys only without a region model (`useDockShellChrome`, #928 D, closed #1380) |
| `RegionState.maximized` | boolean, at most one region, never `main`, never a hidden or empty region (`updateRegion`, the parser) | `useDockShellChrome` (the shell's `isDockMaximized`, for ANY occupant — `DockShell` renders the class and side-panel width from it), `App.tsx` (mobile full-screen, the folded dock region whatever its occupant), `placeSurface` (clears both ends of a move or swap, #1385); navigation's `maximize` param and `lastDockMaximized` are Chat's MIRROR of it (`dockMirrorDiff`, `RegionModelContext`), never its source — the region is also seeded from them inbound (`?maximize=true`, `focusSession`'s restore) |

Two facts that follow from the map and are easy to get wrong:

- **Nothing reads `supportedRegions` to decide where a pane renders.** It gates
  whether a pane fits a slot; the user, the registry and the composition
  builders decide where. Do not add a reader that picks a region from it
  without a decision on #928.
- **Compatibility is context supply, not region words.** The "can this pane
  live here" check is `workspacePaneModesSatisfiableBy` against the contexts a
  host can supply (`workspacePaneHostSuppliableContexts`: project, task,
  session). The chat dock's host applies it to one pane and admits only Chat's
  canonical occurrence; new placement targets should reuse that fold, not a
  new enum.

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
  hidden; `main` reads at most one pane, its selected one; `main` is always
  visible and never maximized, nor is a hidden or empty region, and a second
  maximized region reads as restored. Chat's placement, visibility, size and
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
region else joining the requested one — a closed dock leaves it unplaced.

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

**Still direction.** The dock catalog — the "+" that offers a region the
panes it can add (slice 3; the strip deliberately renders no inert button
for it) — and `openInRegion` (slice 4). Nothing in `region-model.ts`
precludes either; the surface registry keeps its id-keyed API, and each
registry entry maps to the pane the host opens for it through
`REGION_SURFACE_PANES`.

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
