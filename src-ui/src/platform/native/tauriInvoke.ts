/** The reviewed lazy Tauri command and event boundary shared by native code. */
export async function invokeTauri<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** Listen for a Tauri event; resolves to its unlisten function. */
export async function listenTauri(
  event: string,
  handler: () => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen(event, () => handler());
}
