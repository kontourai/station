import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  uiCommandOps: { add: vi.fn() },
}));

const { createUICommandRoutes } = await import('../ui-commands.js');
const { EventBus } = await import(
  '../../../services/orchestration/event-bus.js'
);

const pluginCommandExecution = {
  authorize: vi.fn(() => ({
    kind: 'authorized' as const,
    receipt: { receiptId: 'plugin-command-receipt' },
  })),
};

describe('UI Command Routes', () => {
  test('POST /plugin-command-receipts returns only the host authority receipt', async () => {
    pluginCommandExecution.authorize.mockReturnValueOnce({
      kind: 'authorized',
      receipt: { receiptId: 'plugin-command-receipt' },
    });
    const app = createUICommandRoutes(new EventBus(), {
      isHostedDeployment: () => false,
      pluginCommandExecution: pluginCommandExecution as never,
    });
    const request = { schemaVersion: 'station.plugin-command-execution/v1' };
    const response = await app.request('/plugin-command-receipts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toEqual({
      success: true,
      receipt: { receiptId: 'plugin-command-receipt' },
    });
    expect(pluginCommandExecution.authorize).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ actor: { kind: 'unknown' } }),
    );
  });

  test('plugin command receipts fail closed where audit has no tenant binding', async () => {
    pluginCommandExecution.authorize.mockClear();
    const app = createUICommandRoutes(new EventBus(), {
      isHostedDeployment: () => true,
      pluginCommandExecution: pluginCommandExecution as never,
    });
    const response = await app.request('/plugin-command-receipts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect(pluginCommandExecution.authorize).not.toHaveBeenCalled();
  });

  test('POST / navigate emits event', async () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    const app = createUICommandRoutes(bus, {
      isHostedDeployment: () => false,
      pluginCommandExecution: pluginCommandExecution as never,
    });
    const body = await json(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'navigate',
          payload: { path: '/settings' },
        }),
      }),
    );
    expect(body.success).toBe(true);
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ui:navigate' }),
    );
  });

  test('POST / navigate rejects invalid paths', async () => {
    const app = createUICommandRoutes(new EventBus(), {
      isHostedDeployment: () => false,
      pluginCommandExecution: pluginCommandExecution as never,
    });
    const cases = [
      'http://evil.com',
      'javascript:alert(1)',
      '//evil.com',
      'relative',
    ];
    for (const path of cases) {
      const res = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'navigate', payload: { path } }),
      });
      expect(res.status).toBe(400);
    }
  });

  test('POST / unknown command returns 400', async () => {
    const app = createUICommandRoutes(new EventBus(), {
      isHostedDeployment: () => false,
      pluginCommandExecution: pluginCommandExecution as never,
    });
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'unknown', payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  // archive#3567 fix round FIX 1: `UI_NAVIGATE` is denied at `/events` in
  // hosted multi-tenant mode (no destination identity in the payload to
  // route it to one tenant's connections) — this route must not report
  // success for a command that will never be delivered.
  test('POST / navigate refuses (not emits) in hosted deployment mode', async () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    const app = createUICommandRoutes(bus, {
      isHostedDeployment: () => true,
      pluginCommandExecution: pluginCommandExecution as never,
    });
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'navigate',
        payload: { path: '/settings' },
      }),
    });
    const body = await json(res);
    // archive#3567 second fix round FIX 3: 403 (configuration refuses the
    // operation outright), not 409 (a resolvable state conflict).
    expect(res.status).toBe(403);
    expect(body.success).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  test('POST / navigate still emits when isHostedDeployment reports personal mode', async () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.subscribe(fn);
    const app = createUICommandRoutes(bus, {
      isHostedDeployment: () => false,
      pluginCommandExecution: pluginCommandExecution as never,
    });
    const body = await json(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'navigate',
          payload: { path: '/settings' },
        }),
      }),
    );
    expect(body.success).toBe(true);
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ui:navigate' }),
    );
  });
});
