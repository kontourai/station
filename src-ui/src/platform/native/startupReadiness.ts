import { nativeAuthenticatedTransport } from './authenticatedTransport';
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

/** Proves the current native sidecar identity through the bearer-owning transport. */
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
    try {
      const response = await nativeAuthenticatedTransport(
        `${ticket.apiBase}/api/system/identity`,
        { signal },
      );
      if (signal?.aborted) return false;
      if (response.status !== 200) continue;
      const identity: unknown = await response.json();
      if (signal?.aborted) return false;
      if (
        typeof identity !== 'object' ||
        identity === null ||
        (identity as Record<string, unknown>).instanceId !==
          ticket.instanceId ||
        (identity as Record<string, unknown>).bootId !== ticket.bootId
      )
        continue;
      const committed = await adapter.commitStartupReadiness(ticket);
      if (signal?.aborted) return false;
      if (committed.status === 'ok') return true;
    } catch {
      if (signal?.aborted) return false;
      /* a sidecar rotation is retryable within this bounded proof */
    }
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
    if (!disposed)
      void proveAndCommitStartupReadiness(adapter, controller.signal).catch(
        () => {},
      );
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
