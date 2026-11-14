/**
 * Pane copy shared by the Project layout renderer, the direct pane route and
 * the pane picker, so the same state reads the same way on each surface.
 */
export const WORKSPACE_PANE_AVAILABILITY_CHECKING =
  'Checking which panes are available…';

/**
 * The fallback for an availability action this host cannot run. Hosts render
 * an action only when `canExecuteAction` accepts it, so this is a guard.
 */
export const WORKSPACE_PANE_ACTION_ELSEWHERE =
  'Do this from the pane picker in the Project’s layout.';

export const WORKSPACE_PLUGIN_PANE_UNBOUND =
  'This plugin pane is missing its Project or plugin. Close it and reopen it from the plugin.';
