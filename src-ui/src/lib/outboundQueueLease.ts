/** Loaded only by durable-queue work, keeping lock support out of the initial UI bundle. */
function createRendererBootId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint32Array(2);
  if (typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
    return `renderer-${Date.now().toString(36)}-${bytes[0]!.toString(36)}${bytes[1]!.toString(36)}`;
  }
  // The boot id only distinguishes live renderer claims; it is not a secret.
  return `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const rendererBootId = createRendererBootId();

export async function withOutboundQueueLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return operation();
  return locks.request(
    'station-outbound-queue',
    { mode: 'exclusive' },
    operation,
  );
}

/**
 * Renderer liveness for durable `invoking` rows. Each renderer that writes
 * one holds a Web Lock named after its boot id for as long as it lives; the
 * browser releases it when the tab, window or app process goes away. Another
 * renderer reads the held set to tell an abandoned send from one still in
 * flight. Platforms without Web Locks report `undefined` (unknown).
 */
const RENDERER_LOCK_PREFIX = 'station-outbound-renderer:';
let rendererLockHeld: Promise<void> | undefined;

/**
 * Boot ids of renderers whose lock request failed. Such a renderer still
 * sends (and writes its boot id on its claims), but holds no lock, so the
 * held set cannot tell it from one that is gone: other windows read it as
 * unknown, never as gone. Shared through localStorage, newest last, bounded.
 */
const UNLOCKED_RENDERERS_KEY = 'station-outbound-unlocked-renderers';
const UNLOCKED_RENDERERS_MAX = 32;

function unlockedRenderers(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(UNLOCKED_RENDERERS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

function recordUnlockedRenderer(bootId: string): void {
  try {
    const ids = unlockedRenderers().filter((id) => id !== bootId);
    ids.push(bootId);
    globalThis.localStorage?.setItem(
      UNLOCKED_RENDERERS_KEY,
      JSON.stringify(ids.slice(-UNLOCKED_RENDERERS_MAX)),
    );
  } catch {
    // Unrecorded: other windows read this renderer as gone (its lock is not
    // held), as they did before this record existed.
  }
}

export function ensureRendererLiveness(): Promise<void> {
  if (rendererLockHeld) return rendererLockHeld;
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return Promise.resolve();
  rendererLockHeld = new Promise<void>((granted) => {
    void locks
      .request(`${RENDERER_LOCK_PREFIX}${rendererBootId}`, () => {
        granted();
        // Held until this renderer is gone.
        return new Promise<never>(() => {});
      })
      .catch(() => {
        // Recorded before any claim of this renderer's is written (callers
        // wait for this promise first).
        recordUnlockedRenderer(rendererBootId);
        rendererLockHeld = undefined;
        granted();
      });
  });
  return rendererLockHeld;
}

export async function rendererLiveness(
  bootId: string | undefined,
): Promise<boolean | undefined> {
  if (!bootId) return undefined;
  if (bootId === rendererBootId) return true;
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.query) return undefined;
  try {
    const snapshot = await locks.query();
    if (
      (snapshot.held ?? []).some(
        (lock) => lock.name === `${RENDERER_LOCK_PREFIX}${bootId}`,
      )
    )
      return true;
    // No lock held: gone, unless it never could hold one.
    return unlockedRenderers().includes(bootId) ? undefined : false;
  } catch {
    return undefined;
  }
}
