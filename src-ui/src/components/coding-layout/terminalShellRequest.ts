import { useSyncExternalStore } from 'react';

/**
 * A one-shot "open a shell here" request for a Project's Terminal pane, from
 * an explicit command such as the composer's Open terminal. The pane's own
 * rule opens a shell on mount only when a shell is the only kind it offers
 * (otherwise it shows its chooser); a person who asked for a terminal by name
 * has already chosen. The pane consumes the request once it knows which
 * sessions the Project has: it adopts an existing one rather than adding one.
 */
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const listener of listeners) listener();
}

export function requestProjectShell(projectSlug: string): void {
  pending.add(projectSlug);
  emit();
}

/** Takes the request for this Project, if one is waiting. */
export function consumeProjectShellRequest(projectSlug: string): boolean {
  if (!pending.delete(projectSlug)) return false;
  emit();
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders when any request is made or taken. */
export function useProjectShellRequest(projectSlug: string): boolean {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return pending.has(projectSlug);
}
