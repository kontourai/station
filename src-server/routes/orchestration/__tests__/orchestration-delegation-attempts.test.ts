/**
 * #485 receiver request-claim slice — the HTTP route seam.
 *
 * The route validates the opt-in `attemptId` at its seam, composes the
 * server-derived caller grant (never body identity) into `delegateTask`,
 * maps every typed duplicate outcome to an explicit 409 WITH its attempt
 * reference (never a manufactured handle), and serves the authorized
 * read-only exact-attempt lookup as a bounded closed projection.
 *
 * `delegateTask` itself is stubbed here; the real tool path (claim →
 * resolve → bind → single effect) is proven in
 * `station-control-delegation-attempts.test.ts`.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DelegationAttemptCapacityError,
  DelegationAttemptConflictError,
  DelegationAttemptExistsError,
  DelegationAttemptPendingError,
} from '../../../services/orchestration/delegation-attempt-claim-store.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { ReceiverExecutionRefusal } from '../../../services/projects/project-contribution-service.js';
import { PeerDelegationAttemptDuplicateError } from '../../../tools/station-control-delegation.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    eventBus: new EventBus(),
    logger,
    getUserId: () => 'bound-user',
    ...overrides,
  };
}

const PORTABLE_TARGET = {
  environment: { kind: 'current' as const },
  agent: 'planner',
  workspace: {
    kind: 'project-portable' as const,
    portableProjectId: 'prj_shared',
    resourceId: 'git.example/acme/repo',
  },
};

const NON_PORTABLE_TARGET = {
  environment: { kind: 'current' as const },
  agent: 'planner',
};

function okHandle() {
  return {
    taskId: 'task:1',
    sessionId: 'task:1',
    status: 'dispatched',
    resumable: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /delegations — opt-in attempt seam (#485)', () => {
  test('an attempt id on a non-portable intent refuses explicitly (never silently stripped)', async () => {
    const delegateTask = vi.fn().mockResolvedValue(okHandle());
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({ delegateTask }),
    );
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Ship it',
        target: NON_PORTABLE_TARGET,
        attemptId: 'attempt-1',
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('delegation_attempt_unsupported');
    // The refused request never reached the tool: no claim, no effect.
    expect(delegateTask).not.toHaveBeenCalled();
  });

  test('a portable attempt composes the verified caller grant + store into delegateTask', async () => {
    const delegateTask = vi.fn().mockResolvedValue(okHandle());
    const claimStore = { marker: 'receiver-claim-owner' };
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({
        delegateTask,
        resolveInboundDelegationDevice: () => ({ id: 'dev-verified-1' }),
        delegationAttemptClaimStore: claimStore,
      }),
    );
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Ship it',
        target: PORTABLE_TARGET,
        attemptId: 'attempt-9',
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const input = delegateTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.delegationAttemptId).toBe('attempt-9');
    // Server-derived from the middleware-owned principal — never body.
    expect(input.delegationAttemptCaller).toEqual({
      deviceId: 'dev-verified-1',
    });
    expect(input.delegationAttemptClaimStore).toBe(claimStore);
  });

  test('an operator/personal-device caller forwards the id but can never claim', async () => {
    const delegateTask = vi.fn().mockResolvedValue(okHandle());
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({
        delegateTask,
        // No verified delegation grant behind this request.
        resolveInboundDelegationDevice: () => undefined,
        delegationAttemptClaimStore: { marker: 'receiver-claim-owner' },
      }),
    );
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Ship it',
        target: PORTABLE_TARGET,
        attemptId: 'attempt-9',
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const input = delegateTask.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.delegationAttemptId).toBe('attempt-9');
    // No grant composed: the tool refuses rather than keying a claim by a
    // body label.
    expect(input.delegationAttemptCaller).toBeUndefined();
  });

  test('legacy bodies without the field are byte-unchanged (positive control)', async () => {
    const delegateTask = vi.fn().mockResolvedValue(okHandle());
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({
        delegateTask,
        resolveInboundDelegationDevice: () => ({ id: 'dev-verified-1' }),
        delegationAttemptClaimStore: { marker: 'receiver-claim-owner' },
      }),
    );
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Ship it', target: PORTABLE_TARGET }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const input = delegateTask.mock.calls[0]![0] as Record<string, unknown>;
    expect('delegationAttemptId' in input).toBe(false);
    expect('delegationAttemptCaller' in input).toBe(false);
  });

  test.each([
    [
      'pending',
      new DelegationAttemptPendingError('attempt-9'),
      'delegation_attempt_pending',
      409,
    ],
    [
      'exists',
      new DelegationAttemptExistsError(
        'attempt-9',
        'task:real-1',
        'provider-turn-9',
      ),
      'delegation_attempt_exists',
      409,
    ],
    [
      'conflict',
      new DelegationAttemptConflictError('attempt-9'),
      'delegation_attempt_conflict',
      409,
    ],
    [
      'capacity',
      new DelegationAttemptCapacityError(),
      'delegation_attempt_capacity',
      409,
    ],
  ])(
    'a %s duplicate maps to an explicit 409 with its attempt reference',
    async (_label, error, code, status) => {
      const delegateTask = vi.fn().mockRejectedValue(error);
      const app = createOrchestrationRoutes(
        {} as never,
        baseDeps({
          delegateTask,
          resolveInboundDelegationDevice: () => ({ id: 'dev-verified-1' }),
          delegationAttemptClaimStore: { marker: 'receiver-claim-owner' },
        }),
      );
      const res = await app.request('/delegations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Ship it',
          target: PORTABLE_TARGET,
          attemptId: 'attempt-9',
        }),
      });
      expect(res.status).toBe(status);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe(code);
      // The attempt reference rides along…
      if (code !== 'delegation_attempt_capacity') {
        expect(body.attemptId).toBe('attempt-9');
      }
      // …but a completed handle is NEVER manufactured for a pending
      // duplicate, and no prompt/path/digest leaks into the error.
      if (code === 'delegation_attempt_pending') {
        expect(body.taskId).toBeUndefined();
        expect(body.outcome).toBe('pending');
      }
      if (code === 'delegation_attempt_exists') {
        expect(body.taskId).toBe('task:real-1');
        // The exact initial turn rides along: a lost ACK resolves to that
        // task AND that turn without re-POSTing.
        expect(body.turnId).toBe('provider-turn-9');
      }
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('Ship it');
    },
  );

  test('a controller relays the receiver 409 duplicate verbatim (same code + reference)', async () => {
    const delegateTask = vi
      .fn()
      .mockRejectedValue(
        new PeerDelegationAttemptDuplicateError(
          'delegation_attempt_exists',
          'attempt-9',
          'task:receiver-real-1',
          'provider-turn-remote-1',
        ),
      );
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({
        delegateTask,
        resolveInboundDelegationDevice: () => ({ id: 'dev-verified-1' }),
        delegationAttemptClaimStore: { marker: 'receiver-claim-owner' },
      }),
    );
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Ship it',
        target: PORTABLE_TARGET,
        attemptId: 'attempt-9',
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('delegation_attempt_exists');
    expect(body.attemptId).toBe('attempt-9');
    expect(body.taskId).toBe('task:receiver-real-1');
    expect(body.turnId).toBe('provider-turn-remote-1');
  });

  test('an attempt refusal from the tool keeps its code (not laundered into 500)', async () => {
    const delegateTask = vi
      .fn()
      .mockRejectedValue(
        new ReceiverExecutionRefusal(
          'delegation_attempt_unsupported',
          'Delegation attempt claims are not supported for this request.',
        ),
      );
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({ delegateTask }),
    );
    const res = await app.request('/delegations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Ship it',
        target: PORTABLE_TARGET,
        attemptId: 'attempt-9',
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('delegation_attempt_unsupported');
  });
});

describe('GET /delegations/attempts/:attemptId — authorized exact lookup (#485)', () => {
  function lookupApp(overrides: Record<string, unknown> = {}) {
    return createOrchestrationRoutes(
      {} as never,
      baseDeps({
        resolveInboundDelegationDevice: () => ({ id: 'dev-verified-1' }),
        lookupDelegationAttempt: async (input: {
          attemptId: string;
          callerDeviceId: string;
        }) => ({
          attemptId: input.attemptId,
          state: 'accepted' as const,
          taskId: 'task:real-1',
        }),
        ...overrides,
      }),
    );
  }

  test('the SAME verified grant reads its bounded closed projection', async () => {
    const lookupDelegationAttempt = vi.fn(async () => ({
      attemptId: 'attempt-9',
      state: 'preparing' as const,
    }));
    const app = lookupApp({ lookupDelegationAttempt });
    const res = await app.request('/delegations/attempts/attempt-9');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ attemptId: 'attempt-9', state: 'preparing' });
    // The lookup is keyed by the CURRENT verified grant, not the path.
    expect(lookupDelegationAttempt).toHaveBeenCalledWith({
      attemptId: 'attempt-9',
      callerDeviceId: 'dev-verified-1',
    });
  });

  test('a revoked grant / operator / personal device is refused WITH NO DATA', async () => {
    const lookupDelegationAttempt = vi.fn();
    const app = lookupApp({
      resolveInboundDelegationDevice: () => undefined,
      lookupDelegationAttempt,
    });
    const res = await app.request('/delegations/attempts/attempt-9');
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('delegation_attempt_caller_unsupported');
    expect(lookupDelegationAttempt).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('task:');
  });

  test.each(['..', 'a/b', 'x y', '', 'a'.repeat(200)])(
    'malformed attempt id %j is a 400 before any authority or store read',
    async (attemptId) => {
      const lookupDelegationAttempt = vi.fn();
      const app = lookupApp({ lookupDelegationAttempt });
      const path =
        attemptId === ''
          ? '/delegations/attempts/'
          : `/delegations/attempts/${encodeURIComponent(attemptId)}`;
      const res = await app.request(path);
      expect([400, 404]).toContain(res.status);
      expect(lookupDelegationAttempt).not.toHaveBeenCalled();
    },
  );

  test('an unwired runtime answers 503 (never a fabricated projection)', async () => {
    const app = createOrchestrationRoutes(
      {} as never,
      baseDeps({
        resolveInboundDelegationDevice: () => ({ id: 'dev-verified-1' }),
      }),
    );
    const res = await app.request('/delegations/attempts/attempt-9');
    expect(res.status).toBe(503);
  });

  test('a store fault answers a fixed safe copy: no IO text, no handle', async () => {
    const app = lookupApp({
      lookupDelegationAttempt: vi
        .fn()
        .mockRejectedValue(
          new Error('SQLITE_IOERR: read failed at /secret/station-store.db'),
        ),
    });
    const res = await app.request('/delegations/attempts/attempt-9');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Attempt lookup is temporarily unavailable');
    const text = JSON.stringify(body);
    expect(text).not.toContain('SQLITE');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('station-store');
    expect(body.taskId).toBeUndefined();
    expect(body.turnId).toBeUndefined();
  });

  test('the SAME grant is rechecked after the store read: success resolves it twice', async () => {
    const resolveInboundDelegationDevice = vi.fn(() => ({
      id: 'dev-verified-1',
    }));
    const app = lookupApp({ resolveInboundDelegationDevice });
    const res = await app.request('/delegations/attempts/attempt-9');
    expect(res.status).toBe(200);
    // Once before the store read (to key it), once after (to disclose it).
    expect(resolveInboundDelegationDevice).toHaveBeenCalledTimes(2);
  });

  test('a revocation landing mid-lookup is refused with NO DATA', async () => {
    const lookupDelegationAttempt = vi.fn(async () => ({
      attemptId: 'attempt-9',
      state: 'accepted' as const,
      taskId: 'task:real-1',
      turnId: 'turn:real-1',
    }));
    // Live at request start, gone after the store read: the read result
    // must never reach the revoked caller.
    const resolveInboundDelegationDevice = vi
      .fn()
      .mockReturnValueOnce({ id: 'dev-verified-1' })
      .mockReturnValueOnce(undefined);
    const app = lookupApp({
      lookupDelegationAttempt,
      resolveInboundDelegationDevice,
    });
    const res = await app.request('/delegations/attempts/attempt-9');
    expect(lookupDelegationAttempt).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('delegation_attempt_caller_unsupported');
    const text = JSON.stringify(body);
    expect(text).not.toContain('task:real-1');
    expect(text).not.toContain('turn:real-1');
  });

  test('a grant rotation landing mid-lookup is refused with NO DATA', async () => {
    const lookupDelegationAttempt = vi.fn(async () => ({
      attemptId: 'attempt-9',
      state: 'accepted' as const,
      taskId: 'task:real-1',
      turnId: 'turn:real-1',
    }));
    // A DIFFERENT live grant after the read is still not the grant the
    // claim is keyed by: refused, never the read result.
    const resolveInboundDelegationDevice = vi
      .fn()
      .mockReturnValueOnce({ id: 'dev-verified-1' })
      .mockReturnValueOnce({ id: 'dev-verified-2' });
    const app = lookupApp({
      lookupDelegationAttempt,
      resolveInboundDelegationDevice,
    });
    const res = await app.request('/delegations/attempts/attempt-9');
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('delegation_attempt_caller_unsupported');
    const text = JSON.stringify(body);
    expect(text).not.toContain('task:real-1');
    expect(text).not.toContain('turn:real-1');
  });
});
