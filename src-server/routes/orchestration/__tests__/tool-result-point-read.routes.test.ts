import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import type { OrchestrationService } from '../../../services/orchestration/orchestration-service';
import type { SessionToolResultQueryOutcome } from '../../../services/orchestration/session-query-module';
import { projectToolCompletedEvent } from '../../../services/orchestration/thread-tool-result-adapter';
import { createOrchestrationRoutes } from '../orchestration';

function found(): Extract<SessionToolResultQueryOutcome, { status: 'found' }> {
  const projection = projectToolCompletedEvent({
    eventId: 'event-a',
    threadId: 'session-a',
    turnId: 'turn-a',
    toolCallId: 'reused-call',
    toolName: 'fixture-tool',
    status: 'success',
    output: '<img src=x onerror=alert(1)> inert fixture',
  });
  if (projection?.state !== 'available') throw new Error('Invalid fixture');
  return {
    status: 'found',
    sessionId: 'session-a',
    eventId: 'event-a',
    projectSlug: 'private-project-canary',
    result: projection.result,
  };
}

function fixture(options: { hosted?: boolean; omitGuard?: boolean } = {}) {
  let current = true;
  let sessionReadable = true;
  const read = vi.fn<() => Promise<SessionToolResultQueryOutcome>>(async () =>
    found(),
  );
  const principalCurrent = vi.fn(() => current);
  const canReadSession = vi.fn(() => sessionReadable);
  const service = {
    sessionQueries: { readToolResult: read },
    canUserReadSession: canReadSession,
  } as unknown as OrchestrationService;
  const app = createOrchestrationRoutes(service, {
    eventBus: { subscribe: () => () => {} },
    logger: { debug: vi.fn() },
    getUserId: () => 'fixture-user',
    ...(!options.omitGuard
      ? { isRequestPrincipalCurrent: principalCurrent }
      : {}),
    ...(options.hosted
      ? {
          hostedTenantRegistry: parseHostedTenantRegistry({
            schemaVersion: 1,
            tenants: [{ id: 'alpha', authority: 'alpha.test' }],
          }),
        }
      : {}),
  });
  return {
    app,
    read,
    principalCurrent,
    canReadSession,
    revokeCaller: () => {
      current = false;
    },
    revokeSession: () => {
      sessionReadable = false;
    },
    request: (sessionId = 'session-a', eventId = 'event-a') =>
      app.request(
        `/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(eventId)}`,
      ),
  };
}

async function unavailable(response: Response, status = 404) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({
    success: false,
    error: 'Tool result unavailable',
  });
}

describe('exact tool-result point-read publication', () => {
  test('reads once and publishes only the exact safe result, not owner project metadata', async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        sessionId: 'session-a',
        eventId: 'event-a',
        result: { resultId: 'event-a' },
      },
    });
    expect(JSON.stringify(body)).not.toContain('private-project-canary');
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.read).toHaveBeenCalledWith(
      { type: 'tool-result', threadId: 'session-a', eventId: 'event-a' },
      expect.objectContaining({ userId: 'fixture-user', mode: 'personal' }),
    );
  });

  test.each(['caller', 'session'] as const)(
    'withholds %s revocation during owner I/O',
    async (kind) => {
      const f = fixture();
      let resolve!: (value: SessionToolResultQueryOutcome) => void;
      f.read.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const request = f.request();
      await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
      if (kind === 'caller') f.revokeCaller();
      else f.revokeSession();
      resolve(found());
      await unavailable(await request);
      expect(f.read).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['caller', 'session'] as const)(
    'denies a revoked %s before reading protected content',
    async (kind) => {
      const f = fixture();
      if (kind === 'caller') f.revokeCaller();
      else f.revokeSession();
      await unavailable(await f.request());
      expect(f.read).not.toHaveBeenCalled();
    },
  );

  test('has no permissive fallback when the current-principal guard is absent', async () => {
    const f = fixture({ omitGuard: true });
    await unavailable(await f.request());
    expect(f.read).not.toHaveBeenCalled();
  });

  test('hosted mode never touches a personal owner', async () => {
    const f = fixture({ hosted: true });
    await unavailable(await f.request());
    expect(f.read).not.toHaveBeenCalled();
  });

  test.each(['not-found', 'unavailable'] as const)(
    'maps owner %s without existence or payload leaks',
    async (status) => {
      const f = fixture();
      f.read.mockResolvedValueOnce({ status });
      await unavailable(
        await f.request(),
        status === 'unavailable' ? 503 : 404,
      );
    },
  );

  test('owner exceptions produce a generic no-store outage', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error('private-owner-path-canary'));
    await unavailable(await f.request(), 503);
  });

  test('publication guard exceptions also withhold the successful owner result', async () => {
    const f = fixture();
    f.read.mockImplementationOnce(async () => {
      f.principalCurrent.mockImplementation(() => {
        throw new Error('private-credential-canary');
      });
      return found();
    });
    await unavailable(await f.request(), 503);
  });

  test.each(['sessionId', 'eventId', 'resultId'] as const)(
    'rejects an owner %s substitution',
    async (field) => {
      const f = fixture();
      const value = found();
      if (field === 'resultId')
        value.result = { ...value.result, resultId: 'other-event' };
      else value[field] = 'other-identity';
      f.read.mockResolvedValueOnce(value);
      await unavailable(await f.request());
    },
  );

  test.each([
    ['x'.repeat(1025), 'event-a'],
    ['session-a', 'x'.repeat(1025)],
  ])(
    'rejects oversize tuple components before protected owner access',
    async (sessionId, eventId) => {
      const f = fixture();
      await unavailable(await f.request(sessionId, eventId));
      expect(f.read).not.toHaveBeenCalled();
    },
  );

  test('does not turn unsupported methods into reads', async () => {
    const f = fixture();
    expect(
      (
        await f.app.request('/sessions/session-a/tool-results/event-a', {
          method: 'POST',
        })
      ).status,
    ).toBe(404);
    expect(f.read).not.toHaveBeenCalled();
  });
});
