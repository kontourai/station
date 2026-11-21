import { useEffect } from 'react';

/**
 * The local Project (`ProjectConfig.id`) this document shows (#5072): set
 * while a Project page is mounted. The focus reporter reads it so the
 * Project's own alerts are not sent to this device while it is on screen.
 */
let current: string | undefined;
const listeners = new Set<() => void>();

export function foregroundProjectId(): string | undefined {
  return current;
}

export function subscribeForegroundProject(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setForegroundProject(projectId: string | undefined) {
  if (current === projectId) return;
  current = projectId;
  for (const listener of [...listeners]) listener();
}

/** Marks `projectId` as on screen for as long as the caller is mounted. */
export function useForegroundProject(projectId: string | undefined): void {
  useEffect(() => {
    if (!projectId) return;
    setForegroundProject(projectId);
    return () => {
      if (current === projectId) setForegroundProject(undefined);
    };
  }, [projectId]);
}
