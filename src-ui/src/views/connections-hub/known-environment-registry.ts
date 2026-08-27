import { KnownEnvironmentRegistry } from '@kontourai/station-connect/known-environment';

/**
 * ONE registry instance for the whole app.
 *
 * `KnownEnvironmentRegistry` keeps its change listeners per instance while
 * persisting to shared localStorage, so two components each constructing
 * their own (as the section and the add dialog would) write to the same store
 * and notify nobody but themselves: adding a Station from the dialog left the
 * list showing stale contents until the next remount. The registry is a view
 * over one browser-local store, so there is one of it.
 */
let registry: KnownEnvironmentRegistry | null = null;

export function knownEnvironmentRegistry(): KnownEnvironmentRegistry {
  registry ??= new KnownEnvironmentRegistry();
  return registry;
}

/**
 * Drops the instance so the next caller reads the store fresh.
 *
 * The registry caches its parsed list (`useSyncExternalStore` needs a
 * referentially stable snapshot), and nothing outside it writes the store in
 * production — so there is no reload path, and none is wanted. A test that
 * seeds `localStorage` directly IS an outside writer, and a module-level
 * singleton outlives the test that seeded it, so this is the lifecycle seam
 * for that. It is not a cache-invalidation hook: calling it in app code would
 * detach every live subscriber.
 */
export function resetKnownEnvironmentRegistry(): void {
  registry = null;
}
