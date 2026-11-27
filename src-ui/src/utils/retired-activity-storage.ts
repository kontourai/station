// Private to this one-way migration; callers cannot supply storage keys.
const LEGACY_PREFIX = 'station:activity-review:v1:';

export function purgeRetiredActivityStorage(): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(LEGACY_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable; the retired pane is never mounted.
  }
}
