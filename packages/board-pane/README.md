# @kontourai/station-board-pane

The Console Board as a Station Workspace Pane — a first-party, in-process
React + SDK package (epic station#4142 M4a; `docs/design/pane-or-shell.md`,
"Runtime tiers", tier 2).

The package consumes **published contracts only**:

- `@kontourai/station-contracts` — the Workspace Pane descriptor/instance
  contract (`./workspace-board-pane` subpath, React-free).
- `@kontourai/station-sdk` — the operating-state, availability, and board
  intent query hooks.
- `@kontourai/console-ui` — the published `BoardView` and `deriveBoard`.
- `@kontourai/ui` — the shared `Empty`/`Skeleton` primitives.

It imports nothing from `src-ui` or `src-server`
(`src/__tests__/package-boundary.test.ts` pins the boundary), so core cannot
drift under it silently. Shell affordances with no published equivalent yet
(navigation, the confirm dialog, the error primitive, the mobile derivation,
the D8 redirect notice) arrive through the typed `ConsoleBoardPaneHost`
contract, supplied by the pane's single mounter in core.
