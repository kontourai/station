/**
 * #480/#1964 placement: the production `projectDefaultEnvironment`
 * composition must preserve a saved Project default verbatim — a paired-peer
 * id AND a dangling id — and never substitute `current`. The old SSH-only
 * existence check silently turned both into local execution for callers
 * using this callback. The canonical target resolver downstream validates
 * the saved ref (or raises a named unavailable outcome); it never executes
 * locally for a saved intent.
 *
 * Both halves exercise the ACTUAL production function
 * (`resolveProjectDefaultEnvironmentRef` from runtime-routes.ts, the exact
 * function the route wires as its `projectDefaultEnvironment` dep): the
 * unit half with a stub project store, and the composition half by
 * injecting it into the real `/chat` route and observing what reaches the
 * foreground executor — a saved peer default must arrive unchanged, with no
 * local provider effect.
 */
import type { EnvironmentRef } from '@kontourai/station-contracts/execution-target';
import { describe, expect, test, vi } from 'vitest';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { resolveProjectDefaultEnvironmentRef } from '../runtime-routes.js';

const ROUTE_TEST_USER_ID = 'placement-default-route-test-user';

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

describe('POST /chat with the production default-environment composition', () => {
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
      projectDefaultEnvironment: (projectSlug: string) =>
        resolveProjectDefaultEnvironmentRef(projectService, projectSlug),
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
      projectDefaultEnvironment: (projectSlug: string) =>
        resolveProjectDefaultEnvironmentRef(projectService, projectSlug),
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
