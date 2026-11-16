import {
  CLIENT_ORIGIN_HEADER,
  serializeClientReportedOrigin,
} from '@kontourai/station-contracts/client-origin';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { createSenderReopen } from '../../../services/orchestration/conversation-resolution-reopen.js';
import { ConversationWorkStateStore } from '../../../services/orchestration/conversation-work-state-store.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { createOrchestrationRoutes } from '../orchestration.js';

/**
 * Open and Settled inbox: a person's message reopens the conversation they
 * settled, on the host, from any client. Each case drives a real send route
 * (`/chat`, a steer through `/commands`, a queued message through
 * `/conversations/:id/inbox`) with an authenticated-principal fixture into
 * the real store, through the same `createSenderReopen` the runtime composes.
 */

type Principal = Parameters<typeof setRuntimeAuthenticatedRequestPrincipal>[1];

const OWNER = 'personal:owner';
const CAROL = 'human:tailscale-serve:carol';
const operator: Principal = {
  kind: 'credential',
  credential: 'operator',
  authority: 'operator-credential',
  source: 'bearer',
};
const carolPhone: Principal = {
  kind: 'credential',
  credential: 'carol-phone',
  authority: 'device-credential',
  deviceId: 'carol-phone',
  deviceKind: 'device',
  source: 'bearer',
};
const peerStation: Principal = {
  kind: 'credential',
  credential: 'peer',
  authority: 'device-credential',
  deviceId: 'peer-grant',
  deviceKind: 'delegation',
  source: 'bearer',
};
const agent: Principal = {
  kind: 'internal',
  credential: 'internal',
  authority: undefined,
  source: 'bearer',
};

const makeTempDir = trackTempDirs();
let store: ConversationWorkStateStore;

beforeEach(() => {
  store = new ConversationWorkStateStore(makeTempDir('settle-send-'));
  for (const person of [OWNER, CAROL])
    store.set(person, 'conversation-1', true, '2026-11-01T10:00:00.000Z');
});

const settledFor = (person: string) => Object.keys(store.read(person));

function harness(
  principal: Principal,
  kind?: 'device' | 'delegation',
  // Only the queued-message route reads the conversation inbox here; `/chat`
  // without one takes the live path.
  withInbox = false,
) {
  const executeForegroundMessage = vi.fn(async () => ({
    conversationId: 'conversation-1',
    providerTurnId: 'provider-turn-1',
  }));
  const dispatchWithReceipt = vi.fn().mockResolvedValue({
    receipt: { commandId: 'command', status: 'accepted' },
    result: { outcome: 'steered' },
  });
  const submit = vi.fn().mockReturnValue({ outcome: 'queued', entry: {} });
  const submitSteer = vi.fn().mockReturnValue({ outcome: 'queued', entry: {} });
  const service = {
    dispatchWithReceipt,
    hasReadableSession: async () => true,
    canUserReadSession: () => true,
    canUserMutateSession: () => true,
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, principal);
    await next();
  });
  app.route(
    '/',
    createOrchestrationRoutes(service as any, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn(), warn: vi.fn() },
      getUserId: () => 'owner',
      isRequestPrincipalCurrent: () => true,
      resolveInboundDeviceKind: () => kind,
      executeForegroundMessage: executeForegroundMessage as any,
      ...(withInbox
        ? {
            threadInbox: {
              submit,
              submitSteer,
              submitDisplay: vi.fn(),
            } as any,
          }
        : {}),
      reopenSettledConversation: createSenderReopen({
        store,
        // The runtime keys this with `conversationAcknowledgementKey`; here
        // the operator is the owner and Carol's phone is Carol.
        personFor: (c: { req: { raw: Request } }) => {
          const caller = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
          return caller?.credential === 'operator'
            ? OWNER
            : caller?.credential === 'carol-phone'
              ? CAROL
              : undefined;
        },
        conversationIdOf: (id) =>
          id === 'thread-1' ? 'conversation-1' : undefined,
        logger: { warn: vi.fn() },
      }),
    }),
  );
  return { app, executeForegroundMessage, dispatchWithReceipt, submit };
}

const surface = (value: 'web' | 'cli') => ({
  [CLIENT_ORIGIN_HEADER]: serializeClientReportedOrigin({
    version: 1,
    surface: value,
    build: null,
  })!,
});

function chat(
  app: Hono,
  path = '/chat',
  client: 'web' | 'cli' = 'web',
  body: Record<string, unknown> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...surface(client) },
    body: JSON.stringify({
      message: 'One more thing',
      conversationId: 'conversation-1',
      clientTurnId: 'turn-key-1',
      target: { environment: { kind: 'current' }, agent: 'codex' },
      ...body,
    }),
  });
}

describe('a message sent through /chat', () => {
  test.each([
    ['the web composer', 'web' as const],
    ['the CLI', 'cli' as const],
  ])("from %s reopens the sender's record only", async (_label, client) => {
    const { app, executeForegroundMessage } = harness(operator);
    const response = await chat(app, '/chat', client);
    expect(response.status).toBe(200);
    expect(executeForegroundMessage).toHaveBeenCalledOnce();
    expect(settledFor(OWNER)).toEqual([]);
    expect(settledFor(CAROL)).toEqual(['conversation-1']);
  });

  test("another person's send reopens theirs, not the owner's", async () => {
    const { app } = harness(carolPhone);
    expect((await chat(app)).status).toBe(200);
    expect(settledFor(CAROL)).toEqual([]);
    expect(settledFor(OWNER)).toEqual(['conversation-1']);
  });

  test.each([
    ['an automatic background send', operator, undefined, '/chat/background'],
    ['an agent', agent, undefined, '/chat'],
    ['a peer Station', peerStation, 'delegation' as const, '/chat'],
  ])('from %s reopens nothing', async (_label, principal, kind, path) => {
    const { app, executeForegroundMessage } = harness(principal, kind);
    await chat(app, path);
    // Dispatched or refused, the record stays.
    expect(executeForegroundMessage.mock.calls.length).toBeLessThanOrEqual(1);
    expect(settledFor(OWNER)).toEqual(['conversation-1']);
    expect(settledFor(CAROL)).toEqual(['conversation-1']);
  });

  test('a refused send reopens nothing', async () => {
    const { app, executeForegroundMessage } = harness(operator);
    const response = await chat(app, '/chat', 'web', { clientTurnId: '' });
    expect(response.status).toBe(400);
    expect(executeForegroundMessage).not.toHaveBeenCalled();
    expect(settledFor(OWNER)).toEqual(['conversation-1']);
  });
});

test("a person's steer reopens the conversation its thread belongs to", async () => {
  const { app, dispatchWithReceipt } = harness(operator);
  await app.request('/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...surface('cli') },
    body: JSON.stringify({
      type: 'steerTurn',
      threadId: 'thread-1',
      clientInputId: 'steer-key',
      input: 'Also update the docs.',
    }),
  });
  expect(dispatchWithReceipt).toHaveBeenCalledOnce();
  expect(settledFor(OWNER)).toEqual([]);
  expect(settledFor(CAROL)).toEqual(['conversation-1']);
});

test("a person's queued message reopens it; an agent's does not", async () => {
  const queue = (app: Hono) =>
    app.request('/conversations/conversation-1/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...surface('web') },
      body: JSON.stringify({
        key: 'queued-key',
        kind: 'follow-up',
        message: 'Then push it.',
      }),
    });
  const agentRun = harness(agent, undefined, true);
  expect((await queue(agentRun.app)).status).toBe(202);
  expect(settledFor(OWNER)).toEqual(['conversation-1']);

  const personRun = harness(carolPhone, undefined, true);
  expect((await queue(personRun.app)).status).toBe(202);
  expect(personRun.submit).toHaveBeenCalledOnce();
  expect(settledFor(CAROL)).toEqual([]);
  expect(settledFor(OWNER)).toEqual(['conversation-1']);
});
