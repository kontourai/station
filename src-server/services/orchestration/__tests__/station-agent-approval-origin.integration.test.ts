/**
 * #2344: a Station-engine approval answered through orchestration
 * `respondToRequest` records the approving device on `approval.resolved`, as
 * the old `/tool-approval` path did.
 *
 * Composes the REAL `StationAgentAdapter`, `ApprovalRegistry` and
 * `OrchestrationService` over a real event store; only the adapter's inner
 * `/chat` stream is a fixture. The origin is supplied the way the HTTP route
 * supplies it (`dispatch` context), so the test covers the whole hand-off:
 * service → adapter → registry → emitted event.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const THREAD_ID = 'station-agent-origin';

const mobileOrigin: ClientOrigin = {
  version: 1,
  actor: { kind: 'device', deviceId: 'pixel-10' },
  reported: { version: 1, surface: 'mobile', build: '1' },
};

describe('#2344 Station-engine approval attribution', () => {
  let tmp: string;
  let eventStore: EventStore;
  let eventBus: EventBus;
  let approvalRegistry: ApprovalRegistry;
  let adapter: StationAgentAdapter;
  let service: OrchestrationService;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let resolvedEvents: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'station-agent-origin-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    eventBus = new EventBus();
    resolvedEvents = [];
    eventBus.subscribe((event) => {
      if (event.event === SERVER_EVENTS.APPROVAL_RESOLVED)
        resolvedEvents.push(event.data as Record<string, unknown>);
    });
    approvalRegistry = new ApprovalRegistry(
      { info: vi.fn(), warn: vi.fn() },
      { eventBus },
    );
    adapter = new StationAgentAdapter({
      apiBase: 'http://127.0.0.1:3141',
      hasAgent: () => true,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
      approvalRegistry,
      eventBus,
    });
    service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'station-agent' ? adapter : undefined),
        list: () => [adapter],
      },
      eventBus,
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
  });

  afterEach(async () => {
    await adapter.stopSession(THREAD_ID).catch(() => undefined);
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function openApproval(approvalId: string) {
    const events = adapter.streamEvents()[Symbol.asyncIterator]();
    // The session and turn are set up on the adapter directly: the hand-off
    // under test starts at the service's `respondToRequest`, which finds this
    // adapter by the live session it holds.
    await adapter.startSession({
      threadId: THREAD_ID,
      provider: 'station-agent',
      metadata: { agentId: 'reviewer' },
    });
    await adapter.sendTurn({
      threadId: THREAD_ID,
      input: 'Use the repository tool',
    });
    const decision = approvalRegistry.register(approvalId, {
      metadata: {
        source: 'runtime',
        title: 'repo_write',
        conversationId: THREAD_ID,
      },
    });
    streamController.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({
          type: 'tool-approval-request',
          approvalId,
          toolName: 'repo_write',
        })}\n\n`,
      ),
    );
    // The adapter owns the open request once it publishes `request.opened`.
    for (;;) {
      const next = await Promise.race([
        events.next(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('request.opened never arrived')),
            5000,
          ),
        ),
      ]);
      if (next.done) throw new Error('adapter event stream ended');
      if (
        next.value.method === 'request.opened' &&
        next.value.requestId === approvalId
      )
        break;
    }
    // Wrapped: returning the bare promise from this async helper would make
    // the caller wait for the decision it has not made yet.
    return { decision };
  }

  test('approval.resolved names the device that answered', async () => {
    const { decision } = await openApproval('approval-origin');

    await service.dispatch(
      {
        type: 'respondToRequest',
        threadId: THREAD_ID,
        requestId: 'approval-origin',
        decision: 'accept',
      },
      { clientOrigin: mobileOrigin },
    );

    await expect(decision).resolves.toBe(true);
    expect(resolvedEvents).toEqual([
      expect.objectContaining({
        approvalId: 'approval-origin',
        status: 'approved',
        clientOrigin: mobileOrigin,
      }),
    ]);
  });

  test('an answer with no known origin records none', async () => {
    const { decision } = await openApproval('approval-no-origin');

    await service.dispatch({
      type: 'respondToRequest',
      threadId: THREAD_ID,
      requestId: 'approval-no-origin',
      decision: 'decline',
    });

    await expect(decision).resolves.toBe(false);
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).not.toHaveProperty('clientOrigin');
  });
});
