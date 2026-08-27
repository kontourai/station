/**
 * The configured Tauri product name is the local package identity. It is
 * distinct from remotely supplied Station branding, which must not rename a
 * Stable/Beta/Nightly/Dev installation's own shell chrome.
 */
export async function configuredNativeProductName(): Promise<string | null> {
  try {
    const { getName } = await import('@tauri-apps/api/app');
    const name = await getName();
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}
