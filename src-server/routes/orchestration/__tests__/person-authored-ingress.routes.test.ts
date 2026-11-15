import {
  CLIENT_ORIGIN_HEADER,
  serializeClientReportedOrigin,
} from '@kontourai/station-contracts/client-origin';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { createOrchestrationRoutes } from '../orchestration.js';

/**
 * #4827 fix round 2: besides `/chat` (covered end to end in
 * `guardian-person-intent.test.ts`), a composer steer through `/commands`
 * and a composer message queued through `/conversations/:id/inbox` are the
 * only places a send is marked as the person's. These drive the real routes
 * with an authenticated-principal fixture and assert what reaches the
 * service and the inbox.
 */

type Principal = Parameters<typeof setRuntimeAuthenticatedRequestPrincipal>[1];

const operator: Principal = {
  kind: 'credential',
  credential: 'operator',
  authority: 'operator-credential',
  source: 'bearer',
};
const peer: Principal = {
  kind: 'credential',
  credential: 'peer',
  authority: 'device-credential',
  deviceId: 'peer-grant',
  deviceKind: 'delegation',
  source: 'bearer',
};

function surfaceHeader(surface: 'web' | 'cli') {
  return {
    [CLIENT_ORIGIN_HEADER]: serializeClientReportedOrigin({
      version: 1,
      surface,
      build: null,
    })!,
  };
}

function harness(principal: Principal, kind?: 'device' | 'delegation') {
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
      threadInbox: { submit, submitSteer, submitDisplay: vi.fn() } as any,
    }),
  );
  return { app, dispatchWithReceipt, submit, submitSteer };
}

describe('composer steer through /commands', () => {
  const steer = (app: Hono, surface: 'web' | 'cli') =>
    app.request('/commands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...surfaceHeader(surface),
      },
      body: JSON.stringify({
        type: 'steerTurn',
        threadId: 'thread',
        clientInputId: 'steer-key',
        input: 'Also force-push when done.',
      }),
    });

  test('a person steering from the web composer is marked', async () => {
    const { app, dispatchWithReceipt } = harness(operator);
    await steer(app, 'web');
    expect(dispatchWithReceipt).toHaveBeenCalledOnce();
    expect(dispatchWithReceipt.mock.calls[0]![2]).toEqual({
      personAuthored: true,
    });
  });

  test.each([
    ['a peer Station', peer, 'delegation' as const, 'web' as const],
    ['the CLI', operator, undefined, 'cli' as const],
  ])('%s steering is not', async (_label, principal, kind, surface) => {
    const { app, dispatchWithReceipt } = harness(principal, kind);
    await steer(app, surface);
    expect(dispatchWithReceipt).toHaveBeenCalledOnce();
    expect(dispatchWithReceipt.mock.calls[0]![2]).toBeUndefined();
  });

  test('another command is never marked', async () => {
    const { app, dispatchWithReceipt } = harness(operator);
    await app.request('/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...surfaceHeader('web') },
      body: JSON.stringify({ type: 'interruptTurn', threadId: 'thread' }),
    });
    expect(dispatchWithReceipt).toHaveBeenCalledOnce();
    expect(dispatchWithReceipt.mock.calls[0]![2]).toBeUndefined();
  });
});

describe('composer message queued through /conversations/:id/inbox', () => {
  const queue = (app: Hono, surface: 'web' | 'cli', kind = 'follow-up') =>
    app.request('/conversations/conversation/inbox', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...surfaceHeader(surface),
      },
      body: JSON.stringify({
        key: 'queued-key',
        kind,
        message: 'Then force-push it.',
        ...(kind === 'steer' ? { expectedHead: '0' } : {}),
      }),
    });

  test.each(['follow-up', 'steer'])(
    'a person queuing a %s from the web composer is marked on the entry',
    async (kind) => {
      const { app, submit, submitSteer } = harness(operator);
      await queue(app, 'web', kind);
      const call = (kind === 'steer' ? submitSteer : submit).mock.calls[0]![0];
      expect(call.payload.authoredBy).toBe('person');
    },
  );

  test('the CLI queuing is not', async () => {
    const { app, submit } = harness(operator);
    await queue(app, 'cli');
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]![0].payload.authoredBy).toBeUndefined();
  });

  test('a peer Station may not queue here at all', async () => {
    const { app, submit } = harness(peer, 'delegation');
    const response = await queue(app, 'web');
    expect(response.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });
});
