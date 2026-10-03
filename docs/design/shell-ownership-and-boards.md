# Shell ownership scopes and Boards

> **Reading status: accepted design; all nine delivery slices landed.** Epic
> #2058's slices shipped in three pull requests: slices 1, 2 and 6 in #2080;
> 3, 5 and 8 in #2084; 4, 7 and 9 in #2095. Personal Boards have an
> authenticated [layout route](../../src-server/routes/me/personal-layouts.ts),
> [service](../../src-server/services/layouts/personal-layout-service.ts), and
> [view](../../src-ui/src/views/PersonalBoardView.tsx); the
> [sidebar](../../src-ui/src/components/project-sidebar/ProjectSidebarBoards.tsx)
> consumes that surface. Still unbuilt: instance-shared Boards (storage only,
> no route or UI), placing the Review layout kind on a Board, adding panes to
> a Board from the UI, Board reorder and clone. Use the
> [pane authoring guide](../guides/workspace-pane-authoring.md) for the
> current pane contract.
>
> **Amended 2026-09-29.** [shell-plugins-distributions.md](shell-plugins-distributions.md)
> extends D1 with a layout *subject* (personal project layouts and personal
> templates), clone, and a per-project personal-layout policy, adds a personal
> hide/disable layer on top of D2, and replaces the open question about Home
> becoming a Board with Home as a required kernel slot.

Status: **accepted direction, slices landed** (owner decisions
2026-09-13, recorded from a design session). This record owns the reasoning
for the next shape of the left panel and for the ownership model that makes
project-less, user-owned views possible. All nine slices of epic #2058 have
landed (see the reading status above for what remains unbuilt); the problem
statement below describes the panel before them.

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
   and carries the only badge. Review — the global `/review-queue` page, since
   retired by D4 below — aggregated four unrelated stores: pending proposed
   changes, unresolved diff comments, paused Survey and Flow gate reviews, and
   independent-review receipts. Neither read the other's data, so "what needs
   me" had no single answer and Review read as an unexplained global page.
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
  ([placement.md](placement.md)): each row opens its surface as the page
  (`main` at `/`), and the row whose surface is the page is current.
- **Activity details** keep transcript events chronological and open at the
  latest message. New content follows the tail until the reader scrolls back;
  **Jump to latest** resumes following. Pending decisions stay above the
  transcript, and errors or attention take priority over following. A failed
  conversation-window read shows its error and Retry rather than an empty
  conversation. The Station-owned detail's live indicator reads the app-wide
  transcript stream; session metadata and the raw event log stay collapsed.
  Explicit evidence links still open and focus the evidence disclosure.
  Follow-up drafts use the canonical device draft store under the selected
  Station URL and exact session identity. Switching sessions preserves each
  draft; pending sends stay with their session and cannot clear a newer draft.
  Draft rows use creation age, matching their lane order and older-draft group,
  even when runtime housekeeping updates the session's other timestamps.
  A routed item missing from the inventory gets an exact-session read. Only
  the requested identity is admitted. If that read fails, Activity discloses
  that the item is not in the current list, offers Retry, and can return to the
  list through a fresh Activity surface intent; it does not infer deletion.
  Owners: [`SessionTranscript`](../../src-ui/src/components/session-detail/SessionTranscript.tsx),
  [`MutableSessionDetail`](../../src-ui/src/components/session-detail/MutableSessionDetail.tsx),
  and [`useSessionTranscriptEvents`](../../src-ui/src/hooks/orchestration/useSessionTranscriptEvents.ts).
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
- **Footer**: live work and joined-room participants, Schedule, Customize, and
  Settings. Notifications remain in the header, and the command palette keeps
  its keyboard shortcut. Schedule and Customize do not occupy project-list rows.
  The live-work count reads the authorized session inventory; participant faces
  read task-room publication. A connected browser is not treated as a person.

The original slice moved Agents, Connections, Guidance, Registry, Plugins,
Schedule, and Developer behind the Settings gear and command palette, removing
the old Customize/System disclosure groups. The October settings simplification
supersedes that entry-point placement: a separate **Customize** button opens a
chooser for Agents, Skills, Engines & Models, and Plugins, with Developer gated
by this device's flag. Schedule is a footer destination. Settings contains only
settings-topic navigation; its gear remains available from management screens.

The destination registry owns `sidebar: { order }` for panel destinations and
`customizeNav: { group, order }`, read by `getCustomizeNav`, for chooser entries.
Composition refuses a destination claiming both. Routes and pages keep their
existing identities. The chooser uses canonical guarded navigation, with native
modified-click behavior for its links.
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
comments resolve inside the diff. (As built, the Coding inspector tab was
never mounted and has been removed; the project's Review layout is the live
surface for receipts, receipt detail, and the run action.)

The Review page's role as the host for sibling Kontour products is preserved
by making **Review a layout kind** backed by the Survey review workbench
([survey-flow-review.md](survey-flow-review.md)). A project places it — and,
because its configuration is empty, it also **renders without being placed**:
nothing materializes the builtin layouts, so a project has only the layouts
its starter applied, and every link the inbox, Starter work and the
retired-route redirect mint into Review would otherwise 404. When the API
answers "no layout by that slug" for `review`, `ProjectLayoutRenderer`
resolves the builtin definition instead, and writes nothing — so the
project's layout chips still list only what someone actually added. Scoped to
`review` alone: `coding` and `tasks` read persisted configuration, where an
absent record is not an empty one. Board placement is **deferred** and not implemented. When the slice-7 state
mapping was recorded on [#2065](https://github.com/kontourai/station/issues/2065),
slices 1-4 had not merged, so there was no Board owner to place one. They have
since landed (#2080, #2084, #2095), but `ReviewLayout` still requires a
`projectSlug` and no Board-owned test exists, so the deferral stands. The global `/review-queue` destination
retired once the inbox and
the layout kind both shipped (#2064, #2065): the route is gone, its
`NavigationView` member and sidebar destination with it, and
`src-ui/src/components/review/ReviewLayout.tsx` is the layout kind's host. A
stored `/review-queue?project=<p>&…` link resolves into that Project's Review
layout with its item selector intact; one that names no Project goes to
`/notifications`, which lists the same work across Projects, rather than
guessing a Project.

### D5. Presence is a tray, not a section

Decision: the footer shows an avatar stack and a count of people present on
projects the viewer shares. Opening it lists people (with a message action)
and agent workers (with a follow action) together. Data comes from the
host-wide live-activity projection (`useLiveActivityQuery`) and the task-room
presence authority. Activity no longer renders its own collaborator section;
the footer tray is where presence is shown. Direct messaging requires the membership
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
7. **Review as a layout kind**, then retire `/review-queue`. *(Shipped
   project-scoped: the layout kind and the retirement both landed; Board
   placement is still deferred although Boards themselves have landed.)*
8. **Presence tray.** Read-only people and workers; message action gated on
   membership admission.
9. **Per-principal plugin visibility.** Required before a Board built from
   plugin panes can be shared.

## Open questions

- Should Home itself become the viewer's default Board once slice 4 lands?
- Does an instance-shared Board need its own role, or is operator-only
  sufficient for the first cut?
- Which Survey workbench states map to inbox items versus layout content?
