# Placement: regions, surfaces, layouts, panes, pane hosts

Status: **accepted direction with an implemented core** (owner decisions on
station#928, 2026-09-01 through 2026-09-04). It describes `main` once the
2026-09-04 placement batch has landed: the docked-capability pins, #1446 and
#1420 are delivered by sibling pull requests that merge before this record. The two placement layers below
ship today; the "arrangement" record and the "region occupant is a pane host"
shape are direction for the remaining #928 slices. The vocabulary here is
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
│ │ (surface)   │ │ route outlet, or a layout      │ │ surface:       │ │
│ │             │ │ whose pane host is a tree:     │ │ activity       │ │
│ │             │ │   split ─┬─ tabs [files]       │ │                │ │
│ │             │ │          └─ tabs [diff, chat]  │ │                │ │
│ └─────────────┘ └────────────────────────────────┘ └────────────────┘ │
│ ┌ bottom region ───────────────────────────────────────────────────┐ │
│ │ surface: chat  (its own pane host: tabs [chat])                   │ │
│ └───────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

**Layer 1: shell regions.** The shell owns four fixed slots: `main`, `left`,
`right`, `bottom` (`REGION_IDS`, `src-ui/src/regions/region-model.ts`). Each
holds at most one registered **surface**, plus `visible` and `size`. The
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
  not spawn a panel nobody asked for. Dock-region swaps keep their relocation
  rule.
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
  than a `Show Activity` that would reveal it where it already is. Home, whose
  default is `main`, has no chord and toggles to nothing.
- **"Go to `/`" and "show Home" are different producers.** Since `/` renders
  `main`'s occupant, a caller that means Home by name — the not-found view's
  "Go home", the landing after a project is deleted — reveals the Home surface
  (`useShowSurface()('home')`), while a dismissal that means "back to where I
  was" — the settings and profile toggles' return, Escape from Settings or
  Skills, the store's `setAgent(null)` fallback — navigates to `/` and shows
  whatever occupies `main`. Each site says which meaning it holds (#1523).

**Layer 2: pane hosts.** Inside a surface, or inside a project layout, a
`WorkspacePaneHost` renders a persisted tree of **panes**. The tree has two
node kinds: `tabs` (a group of panes in one spot, one showing at a time) and
`split` (two children with an orientation and a drag ratio). This is the
plugin and SDK model: plugins contribute pane descriptors, not surfaces, and
the contracts vocabulary (`supportedRegions`, composition `role`) describes
positions inside this tree.

The layers meet at one seam: the Chat surface is itself a pane host — a
chromeless `WorkspacePaneHost` inside the region's `DockShell`
(`AmbientChatDockPaneHost`) holding a one-pane tab group, persisted as
`station:workspace-pane-host:v2:ambient:chat-dock`. Chat is the only pane that
host renders: the legacy path that docked Home as a second pane inside the
chat dock, with an occupant picker to switch between them, was deleted in
slice C2b (owner decision, 2026-09-03) once Home became a region surface. The
document and its key outlived that deletion — the key is a user's dock state
on disk, and the document is the prototype of the per-region document below.
That is why the direction below is cheap.

## The words

| word | means | exists as |
|---|---|---|
| **Region** | a fixed shell slot: `main`, `left`, `right`, `bottom` | `REGION_IDS`, `RegionState` |
| **Surface** | a thing registered to occupy a region: id, title, icon, optional chord, the regions it declares, default region | `REGION_SURFACE_REGISTRY`, `RegisteredSurface` |
| **Layout** | a project's named view the sidebar navigates between (Coding, Tasks, Session board, a plugin's) | `LayoutConfig` server record; `type` selects the renderer |
| **Pane** | the smallest addressable UI unit; what plugins contribute | `WorkspacePaneDescriptor`, `WorkspacePaneInstance` |
| **Pane host** | a tree of panes arranged as splits and tab groups, inside a region or a layout | `WorkspacePaneHost`, `WorkspacePaneHostDocumentV1` |
| **Arrangement** | the user's placement choices: which surface in which region, each region's size and visibility, each pane host's tree | `RegionArrangement` for the region half; persisted per device by #928 slice D |
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

## What reads what (verified 2026-09-04 against the placement batch (#1462, #1463, #1464 and this change))

A placement declaration is only as real as its reader. This is the reader
map; anything not listed is a label.

| declaration | vocabulary | readers |
|---|---|---|
| `REGION_SURFACE_REGISTRY` | surface ids | `RegionModelContext` (direct), `ActivityRegionShell` (direct), the region toolbar and `useRegionSurfaceMenu` via `regionModel.surfaces`, `CommandPalette` via the destination registry's `regionSurface` field |
| `RegisteredSurface.regions` | `main`, `left`, `right`, `bottom` | `placeSurface` via `surfaceMayOccupy` (refuses an undeclared region), `RegionModelContext.placeSurface` (a refused placement does not navigate), the region toolbar (each region's menu lists the surfaces declaring it; `useRegionSurfaceMenu` lists dock toggles only) |
| `WorkspacePanePlacement.supportedRegions` | `primary`, `secondary`, `standalone`, `docked` | parse validation; `instantiateWorkspaceComposition` (does a composition slot fit this pane); `isWorkspaceHomeRoleEligibleDescriptor` (`standalone` means "may be a route"); the docked-capability pins (`docked` means "may be a region surface"): `src-ui/src/__tests__/docked-capability-derivation.test.ts` over the built-in descriptor constants and `workspace-pane-known-declarations.test.ts` over the server's inline declarations |
| `WorkspacePanePlacement.preferredRegion` | same | parse validation and canonical-identity equality only |
| `WorkspaceCompositionPaneSpec.role` | `navigation`, `content`, `auxiliary`, `inspector` | the composition algorithm groups panes by role: tabs within a role, splits between roles. Runs on real data through the coding file/diff/evidence compositions (behind `workspaceComposition*` layout config controls) and the task room |
| `RegionState.size` | pixels | round-trips through device settings; does not yet drive the rendered shell (#1380) |

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
  `right` and `bottom`, its `visible`, its `size` along its own edge, and its
  occupant as `{ kind: 'surface', id }` or `null`. `occupant.kind` is the
  extension point for the pane-host direction below: `{ kind: 'pane-host',
  documentId }` is an additive second variant. A newer variant survives being
  READ by an older build (the parser treats an unknown `kind` as an empty
  region rather than rejecting the record), but the older build's next write
  drops it — the protection is for the same-device stale-tab window while a
  newer build is rolling out, not a migration story. `RegionModelContext`
  writes the record on every arrangement change, coalesced to one write per
  burst (150 ms trailing edge, flushed on `pagehide`), and adopts another
  tab's write through the store's `storage` listener without writing it back.
  A mount never writes.
  Precedence at load, highest first: a URL deep link, for Chat only —
  `dockSlotPlacement` places Chat there through `placeSurface`, relocating an
  occupant by the model's own rule, and `dock=open` shows it; then the
  record, when it differs from the registry default, for every surface's
  placement, size and visibility, Chat's included; then the legacy dock seed
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
  does not declare the region it was stored in, reads as an empty region; a
  surface named by two regions keeps the first in `main`, `left`, `right`,
  `bottom` order and the rest read as empty and hidden; `main` is always
  visible. Chat's placement, visibility and size are still mirrored to the
  legacy keys, which keep every existing reader working. The `?surface=` deep
  link reveals a surface once and then clears itself; it is a command, not
  persistence.
- **Pane hosts:** each host persists its own document in localStorage under
  `station:workspace-pane-host:v2:` plus a scope segment (project/layout, task,
  or `ambient:chat-dock`). The parser rejects malformed data and reconstructs a
  bounded recovery document rather than trusting storage
  (`packages/contracts/src/workspace-pane-host.ts`).
- **Layouts:** server records per project (`LayoutConfig`); the shell restores
  the last project and layout on launch.

Scope decision (owner, 2026-09-01, reaffirmed 2026-09-04): the arrangement is
**per device**. Placement is a property of the screen you are sitting at. A
layout that repositions the dock, or a per-project memory, is the category
error the region model was built to remove; per-project placement may return
later as an explicit additive preference.

## Direction: a region's occupant is a pane-host document

Today a dock region holds a surface *id*. The direction for slices C2 and D is
that a region holds a **pane-host document** whose panes are the surfaces
placed there. That gives, from one mechanism:

- any pane in any region (the epic's "maximum flexibility" decision);
- tabs and splits inside a region, without a second container concept;
- one persistence shape for the whole arrangement (region map plus one
  document per occupied region), so slice D does not persist a single-id
  record that later slices would have to migrate.

The surface registry keeps its id-keyed API until a slice needs the document;
nothing in `region-model.ts` may preclude a region holding more than one pane.

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
