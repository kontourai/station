import { ConsoleBoardView } from '../../views/ConsoleBoardView';

/**
 * Layout adapter for the `session-board` layout type. Kept as its own
 * adapter file (the stable swap point noted at #586's filing) rather than
 * inlining board logic into `layoutRegistry.ts` directly — the layout
 * `type: 'session-board'` string and the `/session-board` route are left
 * unchanged (persisted project-layout config compatibility; renaming a
 * persisted layout `type` is a separate, un-scoped migration), but the
 * component it mounts is now the Board Workspace Pane's standalone
 * placement host (`ConsoleBoardView` -> `BoardWorkspacePane` ->
 * `@kontourai/station-board-pane`'s `ConsoleBoardPane`, which mounts
 * `@kontourai/console-ui`'s published `BoardView`; epic station#4142 M4a) —
 * the bespoke `SessionBoardView` this file used to adapt is deleted (roadmap
 * #586, part of epic #580, S6; see `docs/design/work-plane-composition.md`
 * Decisions 5-7).
 */
export function SessionBoardLayout({
  projectSlug,
}: {
  projectSlug: string;
  layoutSlug: string;
  config: Record<string, unknown>;
}) {
  return <ConsoleBoardView projectSlug={projectSlug} />;
}
