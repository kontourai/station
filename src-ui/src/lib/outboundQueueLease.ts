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
