/**
 * The built-in Workspace Pane renderer names this Station build registers.
 *
 * station#3798: the Pane catalogue synthesises a Pane tab for every builtin
 * layout using the layout's `type` as the renderer name, and two of those
 * types — `session-board` and `tasks` — have no Pane renderer at all (the
 * Board and the Tasks layout are reached as routes). The catalogue advertised
 * them anyway, so the resolver had to answer for a Pane whose renderer does
 * not exist and said "Temporarily unavailable / The pane renderer is
 * currently unavailable": a transient sentence for a permanent structural
 * fact, with no action that could repair it.
 *
 * The list lives in the contracts package because BOTH halves of the build
 * need the same answer and `src-server` cannot import `src-ui`: the server
 * decides whether a layout contributes a Pane at all, and the UI holds the
 * component table. It is not a capability grant and authorises nothing — it
 * is the inventory of names for which this build ships a renderer. The UI's
 * `BuiltinWorkspacePaneRendererName` union is checked against this list with
 * `satisfies`, so a renderer added on one side without the other fails to
 * typecheck.
 *
 * Absence from this list is PERMANENT for a given build — it is a
 * compile-time constant, and no extension, retry, or later plugin load adds
 * to it. Plugin and MCP renderers are a different question entirely and are
 * never answered from here.
 */
export const BUILTIN_WORKSPACE_PANE_RENDERER_NAMES = [
  'flow-run-console',
  'workspace-chat',
  'task-room-editor',
  'coding',
  'workspace-coding-file-browser',
  'workspace-coding-diff',
  'workspace-coding-terminal',
  'workspace-plan',
  'workspace-readiness',
  'workspace-trust',
  'workspace-browser-preview',
  'workspace-file-preview',
  'workspace-home',
  'workspace-activity',
  'workspace-spatial-board',
  // The Console Board (epic station#4142 M4a). Its descriptor lives in
  // `@kontourai/station-board-pane`, not here — the name alone joins this
  // inventory so both halves of the build keep one answer to "does a
  // renderer exist". Deliberately NOT `session-board`: that remains the
  // layout `type` string, and registering it would make the catalogue
  // synthesize a pane tab for every session-board layout — a behavior
  // change M4a does not make.
  'workspace-board',
  'workspace-basis',
] as const;

/** Whether this build ships a built-in Pane renderer under that name. */
export function isRegisteredBuiltinWorkspacePaneRendererName(
  name: string,
): boolean {
  return (BUILTIN_WORKSPACE_PANE_RENDERER_NAMES as readonly string[]).includes(
    name,
  );
}
