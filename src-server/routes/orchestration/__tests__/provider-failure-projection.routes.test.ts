import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { ProviderSessionStartingError } from '../../../providers/adapter-shape.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  OrchestrationCommandDispatchError,
  OrchestrationService,
} from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const services: OrchestrationService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  vi.restoreAllMocks();
});

const routes = [
  [
    'handoff',
    '/conversations/conversation%3Afailure/handoff',
    {
      message: 'Continue',
      idempotencyKey: 'handoff-failure-key',
      target: { environment: { kind: 'current' }, agent: 'codex' },
    },
  ],
  [
    'continue',
    '/chat/conversation%3Afailure/continue',
    { message: 'Continue' },
  ],
  [
    'receipt',
    '/commands',
    { type: 'interruptTurn', threadId: 'conversation:failure' },
  ],
] as const;

describe('failure classification HTTP projections', () => {
  it.each(routes)(
    '%s preserves a computed pre-effect refusal',
    async (name, path, body) => {
      const eventBus = new EventBus();
      const service = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
        eventBus,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      services.push(service);
      const receipt = {
        commandId: 'refusal-command',
        threadId: 'conversation:failure',
        commandType: 'sendTurn' as const,
        status: 'rejected' as const,
        createdAt: '2026-10-18T00:00:00.000Z',
      };
      const refusal = new ProviderSessionStartingError();
      const failure = new OrchestrationCommandDispatchError(
        refusal.message,
        receipt,
        undefined,
        'persisted',
        false,
        refusal.code,
        refusal,
      );
      const dispatch = vi
        .spyOn(service, 'dispatchWithReceipt')
        .mockRejectedValue(failure);
      const handoff = vi.fn(async () => {
        throw failure;
      });
      const continuation = vi.fn(async () => {
        throw failure;
      });
      const app = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'failure-owner',
        handoffConversation: handoff,
        continueForegroundMessage: continuation,
      });
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(
        name === 'handoff'
          ? handoff
          : name === 'continue'
            ? continuation
            : dispatch,
      ).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(name === 'handoff' ? 409 : 400);
      const envelope = await response.json();
      expect(envelope).toMatchObject({
        success: false,
        code: 'provider_session_starting',
        kind: 'busy',
        retryable: true,
        failurePhase: 'refused',
      });
      if (name === 'receipt')
        expect(envelope).toMatchObject({ receipt, receiptStatus: 'persisted' });
    },
  );

  it.each(routes)(
    '%s preserves invocation uncertainty as a separate phase',
    async (name, path, body) => {
      const eventBus = new EventBus();
      const service = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
        eventBus,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      services.push(service);
      const knownSession = {
        threadId: 'conversation:failure',
        provider: 'claude' as const,
        status: 'ready' as const,
        createdAt: '2026-10-18T00:00:00.000Z',
        updatedAt: '2026-10-18T00:00:00.000Z',
      };
      const failure = new OrchestrationCommandDispatchError(
        name === 'receipt'
          ? 'Session started; receipt persistence is unavailable.'
          : 'PRIVATE_PROVIDER_DETAIL',
        {
          commandId: 'uncertain-command',
          threadId: 'conversation:failure',
          commandType: 'sendTurn',
          status: 'failed',
          createdAt: '2026-10-18T00:00:00.000Z',
        },
        name === 'receipt' ? knownSession : undefined,
        'persisted',
        name !== 'receipt',
      );
      const dispatch = vi
        .spyOn(service, 'dispatchWithReceipt')
        .mockRejectedValue(failure);
      const handoff = vi.fn(async () => {
        throw failure;
      });
      const continuation = vi.fn(async () => {
        throw failure;
      });
      const app = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => 'failure-owner',
        handoffConversation: handoff,
        continueForegroundMessage: continuation,
      });
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(
        name === 'handoff'
          ? handoff
          : name === 'continue'
            ? continuation
            : dispatch,
      ).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(name === 'receipt' ? 400 : 409);
      const envelope = await response.json();
      expect(envelope).toMatchObject({
        ...(name === 'receipt'
          ? {}
          : { code: 'foreground_message_indeterminate' }),
        outcome: 'indeterminate',
        kind: 'indeterminate',
        retryable: false,
        failurePhase: 'indeterminate',
      });
      expect(JSON.stringify(envelope)).not.toContain('PRIVATE_PROVIDER_DETAIL');
      if (name === 'receipt')
        expect(envelope).toMatchObject({ session: knownSession });
    },
  );
});
