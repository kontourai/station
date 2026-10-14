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
    return (snapshot.held ?? []).some(
      (lock) => lock.name === `${RENDERER_LOCK_PREFIX}${bootId}`,
    );
  } catch {
    return undefined;
  }
}
