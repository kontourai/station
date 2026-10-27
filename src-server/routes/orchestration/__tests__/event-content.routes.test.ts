import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { createHostedTenantMiddleware } from '../../../runtime/bootstrap/runtime-tenant-context.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../../utils/internal-api-token.js';
import { createOrchestrationRoutes } from '../orchestration.js';

/**
 * docs/design/event-content-spill.md: the route that serves the full value
 * behind an out-of-line content reference.
 */
const REF = `sha256-${'a'.repeat(64)}`;

function app(read: ReturnType<typeof vi.fn>) {
  return createOrchestrationRoutes(
    {
      listProviders: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      readEventContent: read,
      dispatch: vi.fn(),
    } as any,
    {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => 'bound-user',
    },
  );
}

describe('GET /sessions/:threadId/content/:ref', () => {
  test('serves a string body raw, with its kind and size', async () => {
    const body = 'line "one"\nline two\u0001';
    const read = vi.fn().mockReturnValue({ kind: 'string', body, bytes: 22 });
    const response = await app(read).request(
      `/sessions/thread-1/content/${REF}`,
    );
    expect(response.status).toBe(200);
    // Raw: no JSON-in-JSON escaping inflation.
    expect(await response.text()).toBe(body);
    expect(response.headers.get('X-Station-Content-Kind')).toBe('string');
    expect(response.headers.get('X-Station-Content-Bytes')).toBe('22');
    expect(response.headers.get('X-Station-Content-Complete')).toBe('true');
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(read).toHaveBeenCalledWith(
      'thread-1',
      REF,
      expect.objectContaining({ userId: 'bound-user' }),
    );
  });

  test('serves a subtree as JSON', async () => {
    const read = vi
      .fn()
      .mockReturnValue({ kind: 'json', body: '[1,2]', bytes: 5 });
    const response = await app(read).request(
      `/sessions/thread-1/content/${REF}`,
    );
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(await response.json()).toEqual([1, 2]);
  });

  test('serves a marked prefix for a bounded reader', async () => {
    const read = vi
      .fn()
      .mockReturnValue({ kind: 'string', body: 'abcdef😀', bytes: 10 });
    const response = await app(read).request(
      `/sessions/thread-1/content/${REF}?maxChars=7`,
    );
    // Never cuts a surrogate pair.
    expect(await response.text()).toBe('abcdef');
    expect(response.headers.get('X-Station-Content-Complete')).toBe('false');
  });

  test('refuses a malformed reference without reading', async () => {
    const read = vi.fn();
    const response = await app(read).request('/sessions/thread-1/content/nope');
    expect(response.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  test('answers 404 when the session or content is not readable', async () => {
    const read = vi.fn().mockReturnValue(null);
    const response = await app(read).request(
      `/sessions/thread-1/content/${REF}`,
    );
    expect(response.status).toBe(404);
  });

  test('reads under the hosted tenant authority, like the window read', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'tenant-alpha', authority: 'alpha.station.test' }],
    });
    const read = vi
      .fn()
      .mockReturnValue({ kind: 'string', body: 'x', bytes: 1 });
    const routes = createOrchestrationRoutes(
      {
        listProviders: vi.fn(),
        listSessions: vi.fn(),
        readEventContent: read,
        dispatch: vi.fn(),
      } as any,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => 'shared-hosted-user',
        hostedTenantRegistry: registry,
      },
    );
    const hosted = new Hono();
    hosted.use('*', createHostedTenantMiddleware(registry));
    hosted.route('', routes);
    const response = await hosted.fetch(
      new Request(`http://station.test/sessions/thread-1/content/${REF}`, {
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
          [INTERNAL_TENANT_HEADER]: 'tenant-alpha',
        },
      }),
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as any,
    );
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith(
      'thread-1',
      REF,
      expect.objectContaining({
        mode: 'hosted',
        tenantExecutionContext: { tenantId: 'tenant-alpha', source: 'request' },
      }),
    );
  });
});
