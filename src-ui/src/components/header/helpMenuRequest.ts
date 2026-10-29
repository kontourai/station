/**
 * "Open the help menu" for a control outside the header. The header's view
 * model owns the help menu because its prompts and chat target read the
 * header's current view and Project; the sidebar's account menu asks it rather
 * than mounting a second, context-free copy. Returns false when no header is
 * mounted to answer.
 */
type HelpMenuRequestListener = () => void;
const helpMenuRequestListeners = new Set<HelpMenuRequestListener>();

export function requestHelpMenu(): boolean {
  if (helpMenuRequestListeners.size === 0) return false;
  for (const listener of [...helpMenuRequestListeners]) listener();
  return true;
}

export function subscribeHelpMenuRequests(
  listener: HelpMenuRequestListener,
): () => void {
  helpMenuRequestListeners.add(listener);
  return () => {
    helpMenuRequestListeners.delete(listener);
  };
}
