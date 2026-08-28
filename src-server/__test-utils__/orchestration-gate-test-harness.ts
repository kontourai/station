/**
 * Shared real-service test harness for orchestration ownership-gate
 * regression suites (archive#1164, archive#1197, archive#1203, archive#1205). Extracted from
 * `routes/orchestration/__tests__/orchestration.routes.test.ts` so that
 * every SSE route sharing the same `EventBus` — the gated
 * `/api/orchestration/events` route AND the sibling broadcast `/events`
 * route (`routes/orchestration/events.ts`) — can stand up an identical
 * real `OrchestrationService` (real `EventStore`, real `EventBus`, a
 * minimal-but-real provider adapter) instead of each maintaining its own
 * copy or falling back to a mocked `canUserReadSession` that never proves
 * the real gate.
 */

import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../providers/sessions/async-event-queue.js';

/**
 * archive#1164: a minimal real `ProviderAdapterShape`. Events are injected
 * directly onto `events` (an `AsyncEventQueue`, exactly like the adapter's
 * own transport) and flow through the REAL `OrchestrationService` pipeline
 * (`consumeAdapterEvents` -> `projectAndPublishEvent`, which persists to a
 * real `EventStore` and only then emits on the real `EventBus`) — this is
 * what lets `canUserReadSession` resolve ownership from durable storage
 * instead of a mock.
 */
export class GateTestAdapter implements ProviderAdapterShape {
  readonly provider = 'claude' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Test adapter for real-service ownership-gate suites',
    capabilities: ['agent-runtime'],
  };
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    return { threadId: input.threadId, turnId: 'turn-1' };
  }
  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async listSessions(): Promise<ProviderSession[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return false;
  }
  async stopAll(): Promise<void> {}
  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }
}

export function createGateTestRegistry(
  adapter: ProviderAdapterShape,
): IProviderAdapterRegistry {
  return {
    register() {},
    get(provider) {
      return provider === adapter.provider ? adapter : undefined;
    },
    list() {
      return [adapter];
    },
  };
}
