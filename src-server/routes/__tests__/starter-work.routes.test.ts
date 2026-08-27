import { describe, expect, it } from 'vitest';
import {
  StarterWorkPrerequisiteError,
  StarterWorkTargetError,
  UnknownStarterWorkError,
} from '../../services/starter-work/starter-registry.js';
import {
  StarterWorkConflictError,
  StarterWorkUnavailableError,
} from '../../services/starter-work/starter-work-module.js';
import { createStarterWorkRoutes } from '../starter-work.js';

function registry() {
  return {
    list: async () => [
      {
        id: 'start-task',
        title: 'Start your first task',
        description: 'x',
        targetKind: 'task',
        prerequisite: 'first-run-completed',
        status: { state: 'unbound' },
      },
    ],
    status: async (id: string) => {
      if (id !== 'start-task') throw new UnknownStarterWorkError();
      return { state: 'unbound' };
    },
    bind: async () => {
      throw new StarterWorkTargetError();
    },
    launchStartTask: async () => ({
      state: 'started',
      task: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      correlation: { state: 'not_verified', reason: 'fenced' },
      dispatch: { state: 'indeterminate', reason: 'fenced', retrySafe: false },
      evidence: { state: 'NOT_VERIFIED', reason: 'fenced' },
    }),
    launchContinueSession: async () => ({
      state: 'continued',
      source: { kind: 'session', id: 'external-session' },
      session: {
        threadId: 'continued-session',
        provider: 'claude',
        controlMode: 'station-owned',
        status: 'idle',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
      correlation: { state: 'not_verified', reason: 'fenced' },
      evidence: { state: 'NOT_VERIFIED', reason: 'fenced' },
    }),
    candidate: async (id: string) => ({
      state: 'current',
      starterId: id,
      reference:
        id === 'inspect-approval'
          ? { kind: 'approval', id: 'notification-1' }
          : {
              kind: 'receipt',
              owner: 'independent-review',
              id: 'receipt-1',
              projectSlug: 'alpha',
            },
    }),
    launchInspection: async (input: {
      starterId: string;
      targetRef: Record<string, unknown>;
    }) => ({
      state: 'opened',
      starterId: input.starterId,
      targetRef: input.targetRef,
      correlation: { state: 'not_verified', reason: 'fixture' },
      href:
        input.starterId === 'inspect-approval'
          ? '/notifications?approval=notification-1'
          : '/review-queue?receipt=receipt-1&project=alpha',
      completion: { state: 'open' },
      evidence: { state: 'NOT_VERIFIED', reason: 'fixture' },
    }),
    launchScheduledCheck: async () => ({
      state: 'started',
      starterId: 'run-scheduled-check',
      receipt: {
        kind: 'receipt',
        owner: 'scheduler-run',
        id: 'schedule:built-in:station-starter-check:run-1',
      },
      correlation: { state: 'not_verified', reason: 'fixture' },
      replayed: false,
      href: '/schedule?run=schedule%3Abuilt-in%3Astation-starter-check%3Arun-1',
      completion: { state: 'completed' },
      evidence: { state: 'NOT_VERIFIED', reason: 'fixture' },
    }),
    clear: async () => ({ state: 'unbound' }),
  };
}

describe('starter work routes', () => {
  it('lists the server catalog and refuses unknown starters and arbitrary target kinds', async () => {
    const app = createStarterWorkRoutes(registry() as never);
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/not-a-starter')).status).toBe(404);
    const arbitraryKind = await app.request('/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        starterId: 'start-task',
        operationId: 'x',
        targetRef: { kind: 'receipt', id: 'receipt-1' },
      }),
    });
    expect(arbitraryKind.status).toBe(400);
  });

  it('returns recoverable readiness without creating a Task', async () => {
    const deferred = {
      ...registry(),
      launchStartTask: async () => ({
        state: 'deferred',
        reason: 'Agent engine is starting.',
        retrySafe: true,
      }),
    };
    const response = await createStarterWorkRoutes(deferred as never).request(
      '/launch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          starterId: 'start-task',
          operationId: 'launch-1',
          task: { projectId: 'project-1', title: 'First task' },
        }),
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { state: 'deferred', retrySafe: true },
    });
  });

  it('selects and launches only exact typed inspection targets', async () => {
    const app = createStarterWorkRoutes(registry() as never);
    const candidate = await app.request('/inspect-approval/candidate');
    expect(candidate.status).toBe(200);
    await expect(candidate.json()).resolves.toMatchObject({
      success: true,
      data: {
        starterId: 'inspect-approval',
        reference: { kind: 'approval', id: 'notification-1' },
      },
    });
    const launched = await app.request('/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        starterId: 'inspect-receipt',
        operationId: 'inspect:receipt-1',
        targetRef: {
          kind: 'receipt',
          owner: 'independent-review',
          id: 'receipt-1',
          projectSlug: 'alpha',
        },
      }),
    });
    expect(launched.status).toBe(201);
    await expect(launched.json()).resolves.toMatchObject({
      success: true,
      data: {
        state: 'opened',
        href: '/review-queue?receipt=receipt-1&project=alpha',
      },
    });
    const mismatch = await app.request('/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        starterId: 'inspect-receipt',
        operationId: 'wrong-kind',
        targetRef: { kind: 'approval', id: 'notification-1' },
      }),
    });
    expect(mismatch.status).toBe(400);
    expect((await app.request('/inspect', { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('launches the scheduled check without caller-authored job configuration', async () => {
    const app = createStarterWorkRoutes(registry() as never);
    const response = await app.request('/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        starterId: 'run-scheduled-check',
        operationId: 'scheduled-check-v1',
      }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        state: 'started',
        receipt: { owner: 'scheduler-run' },
        evidence: { state: 'NOT_VERIFIED' },
      },
    });
    const widened = await app.request('/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        starterId: 'run-scheduled-check',
        operationId: 'scheduled-check-v2',
        prompt: 'caller override',
      }),
    });
    expect(widened.status).toBe(400);
  });

  it('maps a rejected exact target to the stable conflict response', async () => {
    const app = createStarterWorkRoutes(registry() as never);
    const response = await app.request('/bind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        starterId: 'start-task',
        operationId: 'x',
        targetRef: { kind: 'task', id: 'task-1', projectId: 'project-1' },
      }),
    });
    expect(response.status).toBe(409);
  });

  it('names the Session owner when a Session bind is rejected', async () => {
    const rejected = registry();
    rejected.bind = (async () => {
      throw new StarterWorkTargetError('Session');
    }) as never;
    const response = await createStarterWorkRoutes(rejected as never).request(
      '/bind',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          starterId: 'continue-session',
          operationId: 'continue-1',
          targetRef: { kind: 'session', id: 'continued-session' },
        }),
      },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Starter Work must target an existing Station-owned Session.',
    });
  });

  it('returns a total launch result rather than hiding an indeterminate dispatch', async () => {
    const app = createStarterWorkRoutes(registry() as never);
    const response = await app.request('/launch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        starterId: 'start-task',
        operationId: 'launch-1',
        task: { projectId: 'project-1', title: 'First task' },
      }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { dispatch: { state: 'indeterminate', retrySafe: false } },
    });
  });
  it('maps known launch errors and redacts unexpected thrown details', async () => {
    const known = registry();
    known.launchStartTask = async () => {
      throw new StarterWorkTargetError();
    };
    const launch = (source: ReturnType<typeof registry>) =>
      createStarterWorkRoutes(source as never).request('/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          starterId: 'start-task',
          operationId: 'launch-1',
          task: { projectId: 'project-1', title: 'First task' },
        }),
      });
    const knownResponse = await launch(known);
    expect(knownResponse.status).toBe(409);
    await expect(knownResponse.json()).resolves.toEqual({
      success: false,
      code: 'starter_work_target_invalid',
      error: 'Starter Work target is invalid.',
    });

    const unknown = registry();
    unknown.launchStartTask = async () => {
      throw new Error('secret provider body');
    };
    const unknownResponse = await launch(unknown);
    expect(unknownResponse.status).toBe(503);
    await expect(unknownResponse.json()).resolves.toEqual({
      success: false,
      code: 'starter_work_unavailable',
      error: 'Starter Work is unavailable.',
    });
  });

  it('routes the bounded Session continuation intent separately', async () => {
    const response = await createStarterWorkRoutes(registry() as never).request(
      '/launch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          starterId: 'continue-session',
          operationId: 'continue-1',
          sourceSessionId: 'external-session',
        }),
      },
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        state: 'continued',
        session: { threadId: 'continued-session' },
      },
    });
  });

  it.each([
    {
      name: 'an unknown starter',
      thrown: new UnknownStarterWorkError(),
      status: 404,
      code: 'starter_work_not_found',
      error: 'Starter Work not found.',
      raw: 'not available',
    },
    {
      name: 'a sensitive prerequisite error',
      thrown: new StarterWorkPrerequisiteError('token=prerequisite-secret'),
      status: 409,
      code: 'starter_work_prerequisite_required',
      error: 'Starter Work setup is required.',
      raw: 'prerequisite-secret',
    },
    {
      name: 'an invalid target',
      thrown: new StarterWorkTargetError(),
      status: 409,
      code: 'starter_work_target_invalid',
      error: 'Starter Work target is invalid.',
      raw: 'exact Project',
    },
    {
      name: 'a conflicting binding',
      thrown: new StarterWorkConflictError({} as never),
      status: 409,
      code: 'starter_work_conflict',
      error: 'Starter Work binding conflicts with an existing operation.',
    },
    {
      name: 'an unavailable storage error',
      thrown: new StarterWorkUnavailableError('token=unavailable-secret'),
      status: 503,
      code: 'starter_work_unavailable',
      error: 'Starter Work is unavailable.',
      raw: 'unavailable-secret',
    },
    {
      name: 'an unexpected Error',
      thrown: new Error('token=unexpected-secret'),
      status: 503,
      code: 'starter_work_unavailable',
      error: 'Starter Work is unavailable.',
      raw: 'unexpected-secret',
    },
    {
      name: 'an unexpected string',
      thrown: 'token=string-secret',
      status: 503,
      code: 'starter_work_unavailable',
      error: 'Starter Work is unavailable.',
      raw: 'string-secret',
    },
    {
      name: 'an unexpected object',
      thrown: { message: 'token=object-secret' },
      status: 503,
      code: 'starter_work_unavailable',
      error: 'Starter Work is unavailable.',
      raw: 'object-secret',
    },
  ])(
    'maps $name through the closed launch error contract',
    async ({ thrown, status, code, error, raw }) => {
      const failing = registry();
      failing.launchStartTask = async () => {
        throw thrown;
      };
      const response = await createStarterWorkRoutes(failing as never).request(
        '/launch',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            starterId: 'start-task',
            operationId: 'launch-1',
            task: { projectId: 'project-1', title: 'First task' },
          }),
        },
      );
      const body = (await response.json()) as {
        success: boolean;
        code: string;
        error: string;
      };

      expect(response.status).toBe(status);
      expect(Object.keys(body).sort()).toEqual(['code', 'error', 'success']);
      expect(body).toEqual({ success: false, code, error });
      if (raw) expect(JSON.stringify(body)).not.toContain(raw);
    },
  );
});
