const listeners = new Set<(profileName: string) => void>();

export function subscribeNativeRelaySetupState(
  listener: (profileName: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Refresh hint only: consumers must re-read and validate current host state. */
export function publishNativeRelaySetupChange(profileName: string): void {
  for (const listener of listeners) listener(profileName);
}
