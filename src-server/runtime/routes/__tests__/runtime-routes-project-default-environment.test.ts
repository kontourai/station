/**
 * #480/#1964 placement: the production `projectDefaultEnvironment`
 * composition must preserve a saved Project default verbatim — a paired-peer
 * id AND a dangling id — and never substitute `current`. The old SSH-only
 * existence check silently turned both into local execution for callers
 * using this callback. The canonical target resolver downstream validates
 * the saved ref (or raises a named unavailable outcome); it never executes
 * locally for a saved intent.
 *
 * Proof structure (review: helper tests are diagnostics, not caller proof):
 * - unit: `resolveProjectDefaultEnvironmentRef` directly (diagnostic);
 * - composition: POST /chat through the REAL production callback built by
 *   `createProjectDefaultEnvironmentCallback` (the exact factory the route
 *   wiring uses) — a saved peer/dangling default must reach the executor
 *   unchanged, never as `current`;
 * - canonical resolver: the REAL `executeExecutionTargetMessage` with a
 *   dangling saved default rejects with the named unavailable outcome and
 *   the local provider surface sees ZERO invocations.
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { executeExecutionTargetMessage } from '../../../tools/station-control-delegation.js';
import {
  createProjectDefaultEnvironmentCallback,
  resolveProjectDefaultEnvironmentRef,
} from '../runtime-routes.js';

const ROUTE_TEST_USER_ID = 'placement-default-route-test-user';
const CONTROL_API_BASE = 'http://placement-default.test';

function stubProjectService(defaultEnvironment?: EnvironmentRef) {
  return {
    getProject: (slug: string) => {
      expect(slug).toBe('station');
      return { slug, defaultEnvironment };
    },
  };
}

describe('resolveProjectDefaultEnvironmentRef', () => {
  test('preserves a paired-peer saved default instead of substituting current', () => {
    const saved = { kind: 'saved', id: 'env-peer-b' } as EnvironmentRef;
    expect(
      resolveProjectDefaultEnvironmentRef(stubProjectService(saved), 'station'),
    ).toEqual(saved);
  });

  test('preserves a dangling saved default instead of substituting current', () => {
    const saved = { kind: 'saved', id: 'env-deleted' } as EnvironmentRef;
    expect(
      resolveProjectDefaultEnvironmentRef(stubProjectService(saved), 'station'),
    ).toEqual(saved);
  });

  test('maps a missing or non-saved default to current', () => {
    expect(
      resolveProjectDefaultEnvironmentRef(stubProjectService(), 'station'),
    ).toEqual({ kind: 'current' });
    expect(
      resolveProjectDefaultEnvironmentRef(
        stubProjectService({ kind: 'current' }),
        'station',
      ),
    ).toEqual({ kind: 'current' });
  });
});

describe('POST /chat with the production default-environment callback', () => {
  test('a saved peer default reaches the executor unchanged, never as current', async () => {
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:placement-peer-default',
      sessionId: 'session:placement-peer-default',
      providerTurnId: 'provider-turn-placement-peer-default',
      target: { kind: 'agent', id: 'codex' },
    });
    const projectService = stubProjectService({
      kind: 'saved',
      id: 'env-peer-b',
    } as EnvironmentRef);
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      executeForegroundMessage,
      // The REAL production callback via the factory the route wiring uses —
      // not a hand-written arrow. Reintroducing `current` substitution in
      // runtime-routes fails this composition.
      projectDefaultEnvironment:
        createProjectDefaultEnvironmentCallback(projectService),
    });

    const response = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Use the saved peer default',
        target: {
          agent: 'codex',
          workspace: { kind: 'project', projectSlug: 'station' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(executeForegroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          environment: { kind: 'saved', id: 'env-peer-b' },
        }),
      }),
    );
  });

  test('a dangling saved default reaches the executor unchanged, never as current', async () => {
    const executeForegroundMessage = vi.fn().mockResolvedValue({
      conversationId: 'conversation:placement-dangling-default',
      sessionId: 'session:placement-dangling-default',
      providerTurnId: 'provider-turn-placement-dangling-default',
      target: { kind: 'agent', id: 'codex' },
    });
    const projectService = stubProjectService({
      kind: 'saved',
      id: 'env-deleted',
    } as EnvironmentRef);
    const app = createOrchestrationRoutes({} as any, {
      getUserId: () => ROUTE_TEST_USER_ID,
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      executeForegroundMessage,
      projectDefaultEnvironment:
        createProjectDefaultEnvironmentCallback(projectService),
    });

    const response = await app.request('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Keep the dangling default visible',
        target: {
          agent: 'codex',
          workspace: { kind: 'project', projectSlug: 'station' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(executeForegroundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          environment: { kind: 'saved', id: 'env-deleted' },
        }),
      }),
    );
  });
});

describe('canonical target resolver with a dangling saved default', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const ambientApiBase = process.env.STATION_API_BASE;
  const touchedProviders: string[] = [];

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  beforeEach(() => {
    process.env.STATION_API_BASE = CONTROL_API_BASE;
    touchedProviders.splice(0);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${CONTROL_API_BASE}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CONTROL_API_BASE}/api/environments/ssh`) {
        return json({ success: true, data: [] });
      }
      if (
        url ===
        `${CONTROL_API_BASE}/api/environments/peers/env-deleted/credential`
      ) {
        return json({ success: false, error: 'not found' }, 404);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    if (ambientApiBase === undefined) delete process.env.STATION_API_BASE;
    else process.env.STATION_API_BASE = ambientApiBase;
  });

  test('rejects the named unavailable outcome with zero local provider effect', async () => {
    // Any local execution path must go through this surface; the rejection
    // below must happen before it is touched at all.
    const localProviderSurface = new Proxy(
      {},
      {
        get: (_target, property) => {
          touchedProviders.push(String(property));
          return () => {
            throw new Error(
              `local provider surface must not be reached for a dangling default (touched ${String(property)})`,
            );
          };
        },
      },
    );
    await expect(
      executeExecutionTargetMessage(
        {
          message: 'Run on the deleted default',
          target: {
            environment: {
              kind: 'saved',
              id: environmentId('env-deleted'),
            },
            agent: agentId('codex'),
            workspace: { kind: 'project', projectSlug: 'station' },
          },
          userId: ROUTE_TEST_USER_ID,
        },
        localProviderSurface as never,
      ),
    ).rejects.toThrow('not a saved, verified SSH environment');
    expect(touchedProviders).toEqual([]);
  });
});
