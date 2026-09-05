/** One host control is the target for legacy tab-local action references. */
export function workspacePaneHostActionControlId(
  projectSlug: string,
  pluginId: string,
  actionId: string,
) {
  return ['workspace-host-action', projectSlug, pluginId, actionId]
    .map(encodeURIComponent)
    .join(':');
}

export function focusWorkspacePaneHostAction(
  projectSlug: string,
  pluginId: string,
  actionId: string,
) {
  const control = document.getElementById(
    workspacePaneHostActionControlId(projectSlug, pluginId, actionId),
  );
  const target =
    control instanceof HTMLButtonElement && control.disabled
      ? control.closest('fieldset')
      : control;
  target?.scrollIntoView?.({ block: 'nearest' });
  target?.focus();
}
