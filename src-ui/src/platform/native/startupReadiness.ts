import type {
  BundledServerStatus,
  NativePlatformAdapter,
  NativeStartupReadinessTicket,
} from './types';

function ticketFrom(
  status: BundledServerStatus,
): NativeStartupReadinessTicket | null {
  if (
    status.phase !== 'running' ||
    typeof status.generation !== 'number' ||
    !Number.isInteger(status.generation) ||
    !status.instanceId ||
    !status.bootId ||
    !status.apiBase
  )
    return null;
  return {
    generation: status.generation,
    instanceId: status.instanceId,
    bootId: status.bootId,
    apiBase: status.apiBase,
  };
}

function waitForStartupReadinessRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(finish, 100);
    const abort = () => {
      globalThis.clearTimeout(timeout);
      finish();
    };
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Asks the native host to prove and commit its current bundled sidecar ticket.
 * The host owns the exact channel home, saved profile, and credential; this
 * startup boundary must not depend on the renderer's ambient profile choice.
 */
export async function proveAndCommitStartupReadiness(
  adapter: NativePlatformAdapter,
  signal?: AbortSignal,
): Promise<boolean> {
  if (adapter.platform !== 'tauri') return true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (signal?.aborted) return false;
    const observed = await adapter.getBundledServerStatus();
    if (signal?.aborted) return false;
    if (observed.status !== 'ok') {
      await waitForStartupReadinessRetry(signal);
      if (signal?.aborted) return false;
      continue;
    }
    const ticket = ticketFrom(observed.value);
    if (!ticket) {
      if (observed.value.ownership !== 'sidecar') {
        const recovery = await adapter.commitStartupRecoveryUi();
        if (signal?.aborted) return false;
        return recovery.status === 'ok';
      }
      await waitForStartupReadinessRetry(signal);
      if (signal?.aborted) return false;
      continue;
    }
    const committed = await adapter.commitStartupReadiness(ticket);
    if (signal?.aborted) return false;
    if (committed.status === 'ok') return true;
    /* a sidecar rotation or native identity refusal is bounded and retryable */
    await waitForStartupReadinessRetry(signal);
  }
  return false;
}

/**
 * Starts the mounted desktop proof and owns the native retry subscription.
 * Keeping this orchestration in the lazy readiness chunk avoids charging web
 * and mobile first paint for desktop-only lifecycle wiring.
 */
export function startStartupReadinessProof(
  adapter: NativePlatformAdapter,
  parentSignal?: AbortSignal,
): {
  dispose(): void;
} {
  let disposed = false;
  let ready = false;
  let rerunRequested = false;
  let proofInFlight: Promise<void> | undefined;
  const controller = new AbortController();
  let subscription: { dispose(): void } | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    parentSignal?.removeEventListener('abort', dispose);
    subscription?.dispose();
  };
  const prove = () => {
    if (disposed || ready) return;
    if (proofInFlight) {
      rerunRequested = true;
      return;
    }
    proofInFlight = (async () => {
      do {
        rerunRequested = false;
        if (await proveAndCommitStartupReadiness(adapter, controller.signal)) {
          ready = true;
          return;
        }
      } while (!disposed && rerunRequested);
    })()
      .catch(() => {})
      .finally(() => {
        proofInFlight = undefined;
        if (!disposed && !ready && rerunRequested) prove();
      });
  };
  subscription = adapter.subscribeToStartupReadinessRetry(prove);
  if (!parentSignal?.aborted)
    parentSignal?.addEventListener('abort', dispose, { once: true });
  if (parentSignal?.aborted) dispose();
  else prove();
  return {
    dispose,
  };
}
