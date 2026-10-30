import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { createSessionGoalRoutes } from '../session-goals.js';

function fixture() {
  let enabled = true;
  let current = true;
  let owner = true;
  let person = true;
  const read = vi.fn(async () => ({ state: 'unsupported' as const }));
  const control = vi.fn(async () => ({
    state: 'applied' as const,
    goal: null,
  }));
  const adapter = { goals: { read, control } };
  const app = createSessionGoalRoutes({
    orchestration: {
      liveSessionGoalAdapter: () => adapter,
      canUserReadSession: () => owner,
      canUserMutateSession: () => owner,
    },
    preview: {
      select: (branches) =>
        enabled ? branches.enabled() : branches.disabled(),
    },
    authority: () =>
      sessionReadAuthorityFromRequest('human:test:owner', undefined, undefined),
    current: () => current,
    person: () => person,
  });
  return {
    app,
    read,
    control,
    disable: () => {
      enabled = false;
    },
    revoke: () => {
      current = false;
    },
    disown: () => {
      owner = false;
    },
    asAgent: () => {
      person = false;
    },
  };
}

const post = (app: ReturnType<typeof fixture>['app'], body: unknown) =>
  app.request('/sessions/exact/goal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Session Goal HTTP admission', () => {
  test('disabled direct reads and commands perform no owner work', async () => {
    const f = fixture();
    f.disable();
    for (const response of [
      await f.app.request('/sessions/exact/goal'),
      await post(f.app, { operation: 'pause' }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: 'feature_preview_disabled',
        previewId: 'session-goals',
      });
    }
    expect(f.read).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  test('an unreadable Session never reaches the adapter', async () => {
    const f = fixture();
    f.disown();
    expect((await f.app.request('/sessions/exact/goal')).status).toBe(404);
    expect((await post(f.app, { operation: 'pause' })).status).toBe(404);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.control).not.toHaveBeenCalled();
  });

  test('an agent cannot mutate a Goal even when it can read the Session', async () => {
    const f = fixture();
    f.asAgent();
    expect((await post(f.app, { operation: 'pause' })).status).toBe(404);
    expect(f.control).not.toHaveBeenCalled();
  });

  test('keeps unsupported separate from an empty Goal and forwards the exact target', async () => {
    const f = fixture();
    const response = await f.app.request('/sessions/exact/goal');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      success: true,
      data: { state: 'unsupported' },
    });
    expect(f.read).toHaveBeenCalledWith('exact');
  });

  test('withholds a read when authority or the preview changes during owner I/O', async () => {
    for (const change of ['revoke', 'disable'] as const) {
      const f = fixture();
      f.read.mockImplementationOnce(async () => {
        f[change]();
        return { state: 'unsupported' };
      });
      expect((await f.app.request('/sessions/exact/goal')).status).toBe(404);
    }
  });

  test.each([
    { operation: 'set', objective: ' ', tokenBudget: null },
    { operation: 'set', objective: 'Goal', tokenBudget: -1 },
    { operation: 'set', objective: 'Goal', tokenBudget: 0 },
    { operation: 'set', objective: 'Goal', tokenBudget: 1.5 },
    { operation: 'pause', threadId: 'other' },
    { operation: 'other' },
  ])('refuses malformed commands before invocation: %j', async (command) => {
    const f = fixture();
    expect((await post(f.app, command)).status).toBe(400);
    expect(f.control).not.toHaveBeenCalled();
  });

  test('forwards a paused-objective save once without accepting request identity', async () => {
    const f = fixture();
    const command = {
      operation: 'set',
      objective: 'Keep useful context',
      tokenBudget: 2000,
    };
    expect((await post(f.app, command)).status).toBe(200);
    expect(f.control).toHaveBeenCalledExactlyOnceWith('exact', command);
  });
});
