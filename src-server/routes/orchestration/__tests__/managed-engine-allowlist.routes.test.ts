/**
 * #4520: an engine `limits.engines.allowed` leaves out starts no thread and
 * runs no turn. The refusals come from the real orchestration service (real
 * event store; the adapter records whether it was ever asked), and the same
 * refusal is answered 403 by every route a thread or turn arrives through.
 */
import { join } from 'node:path';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { MANAGED_POLICY_ENGINE_REFUSED_CODE } from '@kontourai/station-contracts/managed-policy-engines';
import type { ProviderSessionStartInput } from '@kontourai/station-contracts/provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { ProviderSendTurnInput } from '../../../providers/adapter-shape.js';
import { installManagedEngineLimits } from '../../../security/managed-engine-limits.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import {
  OrchestrationCommandDispatchError,
  OrchestrationService,
} from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const USER = 'managed-engine-route-user';
const makeTempDir = trackTempDirs();
const services: OrchestrationService[] = [];
const stores: EventStore[] = [];

afterEach(async () => {
  installManagedEngineLimits(null);
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  for (const store of stores.splice(0)) store.close();
});

function allowOnly(allowed: string[]) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    supportUrl: 'https://help.example.com/station',
    limits: { engines: { allowed } },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

class RecordingAdapter extends GateTestAdapter {
  readonly started = vi.fn();
  readonly turns = vi.fn();
  private loaded = false;
  async startSession(input: ProviderSessionStartInput) {
    this.started(input.threadId);
    const session = await super.startSession(input);
    this.loaded = true;
    return session;
  }
  async sendTurn(input: ProviderSendTurnInput) {
    this.turns(input.threadId);
    return super.sendTurn(input);
  }
  async hasSession() {
    return this.loaded;
  }
}

function fixture() {
  const directory = makeTempDir('managed-engine-routes-');
  const eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
  stores.push(eventStore);
  const eventBus = new EventBus();
  const adapter = new RecordingAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus,
    eventStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  services.push(service);
  return { adapter, service, eventBus, eventStore, directory };
}

const DENIAL =
  "Acme's policy manages which engines run on this computer: claude is not allowed. For help, visit https://help.example.com/station";

async function refusalOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OrchestrationCommandDispatchError);
  return error as OrchestrationCommandDispatchError;
}

describe('#4520: the engine allow list in the orchestration service', () => {
  test('refuses to start a thread on a disallowed engine', async () => {
    allowOnly(['codex']);
    const { adapter, service, directory } = fixture();

    const error = await refusalOf(
      service.dispatchWithReceipt(
        {
          type: 'startSession',
          input: { provider: 'claude', threadId: 'refused', cwd: directory },
        },
        { userId: USER },
      ),
    );

    expect(error).toMatchObject({
      message: DENIAL,
      code: MANAGED_POLICY_ENGINE_REFUSED_CODE,
      kind: 'permission_denied',
      retryable: false,
    });
    expect(error.receipt.status).toBe('rejected');
    expect(adapter.started).not.toHaveBeenCalled();
  });

  test('keeps an existing thread but refuses its next turn', async () => {
    const { adapter, service, eventStore, directory } = fixture();
    const threadId = 'kept-thread';
    await service.dispatch(
      {
        type: 'startSession',
        input: { provider: 'claude', threadId, cwd: directory },
      },
      { userId: USER },
    );
    expect(adapter.started).toHaveBeenCalledTimes(1);
    allowOnly(['codex']);

    const error = await refusalOf(
      // Internal dispatch: the route's caller-ownership check is not
      // what this test is about.
      service.dispatchWithReceipt({
        type: 'sendTurn',
        input: { threadId, input: 'continue' },
      }),
    );

    expect(error).toMatchObject({
      message: DENIAL,
      code: MANAGED_POLICY_ENGINE_REFUSED_CODE,
    });
    expect(error.receipt.status).toBe('rejected');
    expect(adapter.turns).not.toHaveBeenCalled();
    // The thread itself is kept.
    expect(eventStore.readSessionByThread(threadId)).toBeTruthy();
  });

  test('an engine the allow list names starts and runs as usual', async () => {
    allowOnly(['claude']);
    const { adapter, service, directory } = fixture();
    await service.dispatch(
      {
        type: 'startSession',
        input: { provider: 'claude', threadId: 'allowed', cwd: directory },
      },
      { userId: USER },
    );
    await service.dispatch({
      type: 'sendTurn',
      input: { threadId: 'allowed', input: 'hello' },
    });
    expect(adapter.turns).toHaveBeenCalledTimes(1);
  });
});

describe('#4520: every thread and turn route answers the refusal with 403', () => {
  const routes = [
    [
      'foreground',
      '/chat',
      {
        clientTurnId: 'managed-key',
        conversationId: 'conversation:managed',
        message: 'Continue',
        target: { environment: { kind: 'current' }, agent: 'claude' },
      },
    ],
    [
      'handoff',
      '/conversations/conversation%3Amanaged/handoff',
      {
        message: 'Continue',
        idempotencyKey: 'managed-handoff-key',
        target: { environment: { kind: 'current' }, agent: 'claude' },
      },
    ],
    [
      'continue',
      '/chat/conversation%3Amanaged/continue',
      { message: 'Continue', clientTurnId: 'managed-key' },
    ],
  ] as const;

  test.each(routes)('%s', async (_name, path, body) => {
    // The refusal the service itself produced, not a hand-built one.
    allowOnly(['codex']);
    const { service, eventBus, directory } = fixture();
    const refusal = await refusalOf(
      service.dispatchWithReceipt(
        {
          type: 'startSession',
          input: { provider: 'claude', threadId: 'r', cwd: directory },
        },
        { userId: USER },
      ),
    );
    const fail = vi.fn(async () => {
      throw refusal;
    });
    const app = createOrchestrationRoutes(service, {
      eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => USER,
      executeForegroundMessage: fail,
      handoffConversation: fail,
      continueForegroundMessage: fail,
    });

    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(fail).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      code: MANAGED_POLICY_ENGINE_REFUSED_CODE,
      // Routes redact URLs in outward error text.
      error: expect.stringContaining(
        "Acme's policy manages which engines run on this computer: claude is not allowed.",
      ),
      kind: 'permission_denied',
      retryable: false,
    });
  });
});
