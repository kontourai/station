/** The reviewed lazy Tauri command and event boundary shared by native code. */
export async function invokeTauri<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** Listen for a Tauri event; resolves to its unlisten function. */
export async function listenTauri<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(event, (message) => handler(message.payload));
}

/**
 * Listen for a mobile plugin's own event (`Plugin.trigger` in Swift/Kotlin);
 * resolves to its unregister function. Needs the plugin's
 * `allow-register-listener` permission.
 */
export async function listenTauriPlugin(
  plugin: string,
  event: string,
  handler: () => void,
): Promise<() => void> {
  const { addPluginListener } = await import('@tauri-apps/api/core');
  const listener = await addPluginListener(plugin, event, () => handler());
  return () => {
    void listener.unregister().catch(() => {});
  };
}
