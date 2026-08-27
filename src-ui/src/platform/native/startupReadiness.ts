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

/** Proves the current native sidecar identity through the bearer-owning transport. */
export async function proveAndCommitStartupReadiness(
  adapter: NativePlatformAdapter,
): Promise<boolean> {
  if (adapter.platform !== 'tauri') return true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const observed = await adapter.getBundledServerStatus();
    if (observed.status !== 'ok') {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      continue;
    }
    const ticket = ticketFrom(observed.value);
    if (!ticket) {
      if (observed.value.ownership !== 'sidecar')
        return (await adapter.commitStartupRecoveryUi()).status === 'ok';
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      continue;
    }
    try {
      const response = await nativeAuthenticatedTransport(
        `${ticket.apiBase}/api/system/identity`,
      );
      if (response.status !== 200) continue;
      const identity: unknown = await response.json();
      if (
        typeof identity !== 'object' ||
        identity === null ||
        (identity as Record<string, unknown>).instanceId !==
          ticket.instanceId ||
        (identity as Record<string, unknown>).bootId !== ticket.bootId
      )
        continue;
      if ((await adapter.commitStartupReadiness(ticket)).status === 'ok')
        return true;
    } catch {
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
export function startStartupReadinessProof(adapter: NativePlatformAdapter): {
  dispose(): void;
} {
  let disposed = false;
  const prove = () => {
    if (!disposed) void proveAndCommitStartupReadiness(adapter);
  };
  const subscription = adapter.subscribeToStartupReadinessRetry(prove);
  prove();
  return {
    dispose() {
      disposed = true;
      subscription.dispose();
    },
  };
}
