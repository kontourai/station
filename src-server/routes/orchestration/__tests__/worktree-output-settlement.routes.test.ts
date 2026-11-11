import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { WorktreeOutputSettlement } from '@kontourai/station-contracts/workspace-isolation';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import type { WorktreeOutputSettlementService } from '../../../services/projects/worktree-output-settlement-service.js';
import { createWorktreeOutputSettlementRoutes } from '../worktree-output-settlement.js';

const PRINCIPAL = 'human:test:owner';
// The shape Station's own worktree provisioning writes on `session.started`;
// the path and branch are bound to the Session id `exact`.
const SEGMENT = 'exact-fa79d4746c21cd960a17b92db8976dde';

function fixture(
  options: { worktreeOwner?: { kind: 'task'; taskId: string } } = {},
) {
  let person = true;
  let owner = true;
  const recorded: WorktreeOutputSettlement = {
    sessionId: 'exact',
    state: 'settled',
    outcome: 'kept',
    actor: { kind: 'person', id: PRINCIPAL },
    requestKey: 'kept-1',
    repoPath: '/repo',
    worktreePath: `/repo-worktrees/${SEGMENT}`,
    branch: `station/session/${SEGMENT}`,
    baseRef: 'HEAD',
    evidence: { containingCommit: 'a'.repeat(40) },
    requestedAt: '2026-11-11T00:00:00.000Z',
    settledAt: '2026-11-11T00:00:00.000Z',
  };
  const settle = vi.fn(async (_input: { stillAuthorized: () => boolean }) => ({
    kind: 'recorded' as const,
    settlement: recorded,
  }));
  const read = vi.fn(() => undefined as WorktreeOutputSettlement | undefined);
  const settlements = {
    settle,
    read,
  } as unknown as WorktreeOutputSettlementService;
  const routes = createWorktreeOutputSettlementRoutes({
    orchestration: {
      canUserReadSession: () => owner,
      canUserMutateSession: () => owner,
      readSession: async () =>
        ({
          events: [
            {
              method: 'session.started',
              sessionId: 'exact',
              metadata: {
                worktree: {
                  mode: 'worktree',
                  repoPath: '/repo',
                  path: `/repo-worktrees/${SEGMENT}`,
                  branch: `station/session/${SEGMENT}`,
                  baseRef: 'HEAD',
                  cleanupPolicy: 'preserve',
                  preserveOnFailure: true,
                  createdAt: '2026-11-11T00:00:00.000Z',
                  ...(options.worktreeOwner
                    ? { owner: options.worktreeOwner }
                    : {}),
                },
              },
            },
          ],
        }) as never,
    },
    settlements: () => settlements,
    authority: () =>
      sessionReadAuthorityFromRequest(PRINCIPAL, undefined, undefined),
    current: () => true,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: person ? 'credential' : 'internal',
      credential: 'settlement-test-device',
      authority: 'device-credential',
      deviceId: 'settlement-test-device',
      deviceKind: 'device',
      source: 'bearer',
    });
    await next();
  });
  app.route('/', routes);
  return {
    app,
    settle,
    read,
    recorded,
    asAgent: () => {
      person = false;
    },
    disown: () => {
      owner = false;
    },
  };
}

const post = (app: Hono, body: unknown) =>
  app.request('/sessions/exact/worktree-settlement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('worktree output settlement route (#4771)', () => {
  test('records the settlement as the authenticated person, never a named actor', async () => {
    const f = fixture();
    const response = await post(f.app, {
      requestKey: 'kept-1',
      outcome: 'kept',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { status: 'recorded', settlement: f.recorded },
    });
    expect(f.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'exact',
        actor: { kind: 'person', id: PRINCIPAL },
        request: { requestKey: 'kept-1', outcome: 'kept' },
        metadata: expect.objectContaining({
          branch: `station/session/${SEGMENT}`,
        }),
      }),
    );
    // The service asks again before any effect; losing access answers no.
    const { stillAuthorized } = f.settle.mock.calls[0][0];
    expect(stillAuthorized()).toBe(true);
    f.disown();
    expect(stillAuthorized()).toBe(false);
  });

  test('refuses a caller-asserted actor and settles nothing', async () => {
    const f = fixture();
    for (const actor of [
      { kind: 'person', id: 'human:test:someone-else' },
      { kind: 'station', id: 'worktree-cleanup-policy' },
      'human:test:someone-else',
    ]) {
      const response = await post(f.app, {
        requestKey: 'discard-1',
        outcome: 'discarded',
        actor,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        success: false,
        error: expect.stringMatching(/cannot name an actor/),
      });
    }
    expect(f.settle).not.toHaveBeenCalled();
  });

  test('validates the request before any settlement', async () => {
    const f = fixture();
    for (const body of [
      'not json',
      {},
      { outcome: 'kept' },
      { requestKey: 'k', outcome: 'merged' },
      { requestKey: 'has space', outcome: 'kept' },
      { requestKey: 'x'.repeat(129), outcome: 'kept' },
      { requestKey: 'k', outcome: 'kept', acceptUncommittedLoss: true },
      { requestKey: 'k', outcome: 'released' },
      {
        requestKey: 'k',
        outcome: 'released',
        pullRequest: {
          provider: 'github',
          host: 'github.com',
          repository: { owner: 'acme', name: 'repo' },
          ref: 'not-a-number',
        },
      },
      { requestKey: 'k', outcome: 'discarded', acceptUncommittedLoss: 'yes' },
      {
        requestKey: 'k',
        outcome: 'cleaned-up-without-decision',
      },
    ]) {
      const response = await post(f.app, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(f.settle).not.toHaveBeenCalled();
  });

  test('refuses agents and callers without Session mutation authority', async () => {
    const agent = fixture();
    agent.asAgent();
    expect(
      (await post(agent.app, { requestKey: 'k', outcome: 'kept' })).status,
    ).toBe(404);
    const stranger = fixture();
    stranger.disown();
    expect(
      (await post(stranger.app, { requestKey: 'k', outcome: 'kept' })).status,
    ).toBe(404);
    expect(
      (await stranger.app.request('/sessions/exact/worktree-settlement'))
        .status,
    ).toBe(404);
    expect(agent.settle).not.toHaveBeenCalled();
    expect(stranger.settle).not.toHaveBeenCalled();
  });

  test('a Task-owned worktree is settled with its Task, not here', async () => {
    const f = fixture({ worktreeOwner: { kind: 'task', taskId: 'task-1' } });
    const response = await post(f.app, { requestKey: 'k', outcome: 'kept' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'task-owned-worktree',
    });
    expect(f.settle).not.toHaveBeenCalled();
  });

  test('a refusal names its reason and the record in the way', async () => {
    const f = fixture();
    f.settle.mockResolvedValueOnce({
      kind: 'refused',
      reason: 'already-settled',
      detail: 'already recorded',
      settlement: f.recorded,
    } as never);
    const response = await post(f.app, {
      requestKey: 'discard-1',
      outcome: 'discarded',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'already-settled',
      data: { settlement: f.recorded },
    });
  });

  test('reads the record, or null', async () => {
    const f = fixture();
    let response = await f.app.request('/sessions/exact/worktree-settlement');
    expect(await response.json()).toEqual({
      success: true,
      data: { settlement: null },
    });
    f.read.mockReturnValue(f.recorded);
    response = await f.app.request('/sessions/exact/worktree-settlement');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      success: true,
      data: { settlement: f.recorded },
    });
  });
});
