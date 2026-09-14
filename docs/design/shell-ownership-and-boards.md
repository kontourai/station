# Shell ownership scopes and Boards

Status: **accepted direction, not yet implemented** (owner decisions
2026-09-13, recorded from a design session). This record owns the reasoning
for the next shape of the left panel and for the ownership model that makes
project-less, user-owned views possible. It does not change shipped behavior.
The sequence of slices is tracked on epic #2058.

Vocabulary follows [the glossary](../glossary.md). Where this record
introduces a term (**Board**, **personal scope**, **attention inbox**) it
says so; those terms enter the glossary with the slice that ships them.

## The problem

The left panel today lists Home, the projects, and then eleven destinations
in a bottom band split into `primary`, `Customize`, and `System`
(`src-ui/src/app-shell/destination-registry.ts`,
`src-ui/src/components/project-sidebar/ProjectSidebarNav.tsx`). Three things
make it hard to read:

1. **Configuration sits beside work.** Agents, Connections, Guidance,
   Registry, and Plugins are visited to set Station up, not to use it. They
   take the same rows as Activity and the projects.
2. **Two inboxes with disjoint data.** Notifications is driven by the
   attention projection (`src-server/services/projects/attention-projection.ts`)
   and carries the only badge. Review (`src-ui/src/views/ReviewQueueView.tsx`)
   aggregates four unrelated stores: pending proposed changes, unresolved diff
   comments, paused Survey and Flow gate reviews, and independent-review
   receipts. Neither reads the other's data, so "what needs me" has no single
   answer and Review reads as an unexplained global page.
3. **No project-less view.** Every Layout has a required `projectSlug`
   (`packages/contracts/src/layout.ts`), stored under the project's directory
   (`src-server/domain/file-storage-adapter.ts`). The only project-less surface
   is Home, and Home cannot be customized beyond the unwritten workspace-home
   role grant (`src-server/services/plugins/workspace-home-role-service.ts`).
   Comparable products expose user-defined global pages (a personal board, a
   daily digest, a CI wall) at the top of the panel.

The owner's product stance, restated so later slices do not drift from it:
Station is UI-first. Projects organize work around layouts that leverage
agents, not around chat threads. Chat remains available and familiar, but it
is one layout among several, never the spine of navigation.

## Decisions

### D1. Three ownership scopes, and Boards live in the new one

Station stores artifacts under three scopes today:

| Scope | Holds today | Owner |
| --- | --- | --- |
| Instance (the Station home) | plugins, global agents, Station settings | operator |
| Project | layouts, project agents, tasks, knowledge, memberships | project members |
| Device | region arrangement, sidebar state, device flags (`packages/contracts/src/device-settings.ts`) | this browser or app |

Principals exist for attribution and authorization only
([principals.md](principals.md)); nothing is stored under one. "Personal"
therefore means either instance-wide, which only works on a single-operator
instance, or device-local, which does not follow a person to their phone.

Decision: add a fourth scope, **personal**, keyed by principal and stored
server-side so it follows the person across devices. A **Board** is a Layout
whose owner is a principal rather than a project. Boards render through the
same layout machinery as project layouts; nothing about the renderer, pane
host, or plugin pane contract changes.

Consequences:

- `LayoutConfig` gains a polymorphic owner: a project slug or a principal
  reference. Storage for principal-owned layouts lives outside
  `projects/<slug>/layouts/`.
- A Board can be **promoted**: moving it into a project makes it that
  project's layout, visible to every member. The same promotion rule is the
  intended path for personal agents later (`AgentSpec.project` today admits
  only global or project ownership, `packages/contracts/src/agent.ts`).
- Instance-shared Boards (an operator's "everyone sees this" page) are a
  Board owned by the instance. They are listed with personal Boards, marked
  as shared. This keeps one section for project-less views.

### D2. Plugins stay instance-installed; visibility becomes per-principal

Plugin installation is one directory per instance
(`src-server/services/plugins/plugin-installation-service.ts`), and the
membership design already requires that a collaborator's first-member journey
refuse to enumerate the instance's plugin list
([project-membership.md](project-membership.md)). A Board composed of plugin
panes would otherwise inherit the whole instance's plugin set.

Decision: keep installation instance-wide. Add a per-principal projection of
which installed plugins a member can see and enable. Personal Boards and
personal agents compose only from that projection. This is additive: the
installation service already carries opaque `scope` and `dataScope`
identifiers that the local adapter currently binds to one directory.

### D3. The left panel lists places only

The panel becomes:

```text
Station · <instance> · <pairing status>          [search]
Home
Activity
BOARDS                                              +
  Daily brief                       (personal)
  CI wall                           (shared by operator)
PROJECTS                                            +
  Campfit          [J][M]  2 live  1 needs you
    Coding · Tasks · Chat · Board · Knowledge      (layout chips)
  Ferry                     1 live
  Thread
────────────────────────────────────────────────
[avatars] 3 here          [bell 4]  [gear]
```

- **Home and Activity** keep their placed-surface semantics
  ([placement.md](placement.md)): the rows are pressed, not current.
- **Boards** is the project-less section. Personal Boards list first, then
  instance-shared ones. The `+` creates a personal Board.
- **Projects** keep their model. A project row shows a live-work count, a
  needs-you count, and the avatars of members present. A project's layouts
  render as a chip row under the name instead of a nested tree. The chip
  treatment is a hierarchy decision (layouts are the project's children);
  the visual is not decided here and may change.
- **Chat is a layout chip.** A layout of kind `chat` already mounts the
  fullscreen chat pane with its own inbox
  (`src-ui/src/app-shell/project-layout-kind.ts`,
  `src-ui/src/workspace-panes/ChatWorkspaceLayout.tsx`,
  `src-ui/src/components/chat-dock/ChatDockInboxPanel.tsx`). No conversation
  list appears in the panel. The chat dock (⌘D) is unchanged.
- **Footer**: presence, the attention bell, the gear, and the command
  palette's chord. Nothing else. (Amended during slice 1 (#2059): the chord
  was the one member of the retired status line worth keeping, because the
  palette is one of the two ways to reach everything that leaves the panel —
  advertising the move while deleting its advertisement would be
  self-defeating. The status line's build stamp and open-chat count did not
  survive: the stamp belongs to a problem report, not to navigation chrome,
  and the count restated the panel's own Open chats section.)

Everything below is removed from the panel and reached through the gear and
the command palette: Agents, Connections, Guidance, Registry, Plugins,
Schedule, Developer. The `Customize` and `System` group headers go with them.

The destination registry is the seam. With both disclosure groups gone there
are no sections left to order, so `sidebar.section` is retired: a panel row is
`sidebar: { order }` and a configuration destination is
`management: { order }`, read by a new `getManagement` projection that
Settings' Manage group renders. A destination may be one or the other and the
composer refuses a definition claiming both. Routes and pages do not change.
One palette entry is ADDED rather than moved: Review's panel row was its only
advertised entry point, and D4 below requires it stay palette-reachable until
`/review-queue` retires.

### D4. One attention inbox

Decision: Notifications is the inbox. It widens to carry every item whose
meaning is "a human must decide": tool approvals and pairing (already there),
plus proposed-change decisions and paused gate reviews (from Review). The
bell in the footer carries the single count. A project row carries the same
count scoped to that project.

Independent-review receipts and the "run independent review" action move
into the project's Coding layout, next to the Git range they judge. Diff
comments resolve inside the diff.

The Review page's role as the host for sibling Kontour products is preserved
by making **Review a layout kind** backed by the Survey review workbench
([survey-flow-review.md](survey-flow-review.md)). A project or a Board can
place it. The global `/review-queue` destination retires once the inbox and
the layout kind both ship; until then it remains routed and reachable from
the palette so no decision path is orphaned.

### D5. Presence is a tray, not a section

Decision: the footer shows an avatar stack and a count of people present on
projects the viewer shares. Opening it lists people (with a message action)
and agent workers (with a follow action) together. Data comes from the
collaborator summary the Activity surface already renders
(`src-ui/src/components/live-activity/LiveCollaboratorsSection.tsx`) and the
task-room presence authority. Direct messaging requires the membership
admission work tracked on the membership record and is not part of the panel
change.

## Alternatives considered

- **Global views band in the panel** (Home, Activity, Review, Schedule, and
  pinned layouts as rows): rejected as a transposition of another product's
  panel; it reintroduces a status band above the places.
- **Home as a widget board instead of Boards**: kept as a *use* of Boards
  (Home may itself become a Board later) but rejected as the *answer* to
  global views, because a widget tile is not a full page.
- **Two rails (places rail plus a per-place context column)**: deferred. It
  scales to many places and scopes attention per place, but costs a second
  column of chrome before content.
- **Named cross-project arrangements ("benches")**: deferred. The region
  arrangement is per device today; naming and sharing it is a later idea
  that Boards do not preclude.
- **Time-ordered stream as the panel**: rejected for the panel; retained as
  the Activity surface's design direction.

## Non-goals

- No change to chat semantics, the chat dock, or the composer.
- No change to region and surface placement rules.
- No new plugin contribution types. Boards use existing layout and pane
  contracts.
- No visual system decisions. Chips, pills, and trays in the session
  mock-ups are hierarchy illustrations, not the shipped design.

## Delivery

Slices, in order (epic #2058, issues #2059 through #2067). Each lands behind
the existing registry seams so the panel can move one section at a time.

1. **Registry re-sectioning and footer.** Move configuration destinations
   behind the gear; footer with presence placeholder, bell, gear. Pure
   grouping change.
2. **Layout owner polymorphism.** Contract and storage for principal-owned
   and instance-owned layouts; project layouts unchanged.
3. **Personal scope store.** Principal-keyed server-side store, first used
   by Boards.
4. **Boards in the panel.** Section, create, rename, promote to project.
5. **Project rows with layout chips**, including Chat as a chip.
6. **Attention inbox widening.** Proposed changes and paused gates join
   Notifications; footer bell and per-project counts.
7. **Review as a layout kind**, then retire `/review-queue`.
8. **Presence tray.** Read-only people and workers; message action gated on
   membership admission.
9. **Per-principal plugin visibility.** Required before a Board built from
   plugin panes can be shared.

## Open questions

- Should Home itself become the viewer's default Board once slice 4 lands?
- Does an instance-shared Board need its own role, or is operator-only
  sufficient for the first cut?
- Which Survey workbench states map to inbox items versus layout content?
