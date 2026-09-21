/**
 * #485 receiver request-claim slice — receiver-local effect proof.
 *
 * Real `delegateTask` + the REAL file-backed `FileDelegationAttemptClaimStore`
 * (temp dir) + typed service doubles + stubbed peer HTTP. No paid model, no
 * mocks of the claim owner. Proves:
 *
 * - same-key concurrent creates: ONE provider effect (one start + one first
 *   turn); the loser names the claim (pending/exists), never a second task;
 * - mismatched validated intent under the same key conflicts with no effect;
 * - lost-ACK lookup after persisted start/turn evidence settles WITHOUT a
 *   re-POST (accepted + the real task handle);
 * - a crash between start invocation and acknowledgement settles
 *   `unresolved`, retains the claim, and a redelivery launches no second
 *   effect;
 * - a crash before the atomic rename commit leaves NO claim (the retry may
 *   proceed — nothing durable exists yet) and no effect;
 * - a clean pre-effect refusal settles `refused` (terminal tombstone; the
 *   key never re-executes) with no effect;
 * - unsupported topology (non-portable + attempt), missing store/caller
 *   composition, and an unadvertised receiver capability all refuse BEFORE
 *   any claim or effect (legacy positive control: no attempt id behaves as
 *   before).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  DelegationAttemptConflictError,
  DelegationAttemptPendingError,
  FileDelegationAttemptClaimStore,
  projectDelegationAttemptClaim,
} from '../../services/orchestration/delegation-attempt-claim-store.js';
import { ReceiverExecutionRefusal } from '../../services/projects/project-contribution-service.js';
import { PeerDelegationAttemptDuplicateError } from '../station-control-delegation.js';

process.env.STATION_API_BASE = 'http://attempt-claims.test';
process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';

const CURRENT_API = 'http://attempt-claims.test';
const REMOTE_API = 'http://127.0.0.1:45234';
const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PORTABLE_WORKSPACE = {
  kind: 'project-portable' as const,
  portableProjectId: 'prj_shared',
  resourceId: 'git.example/acme/repo',
};

function portableTarget() {
  return {
    environment: { kind: 'current' as const },
    agent: agentId('reviewer'),
    workspace: { ...PORTABLE_WORKSPACE },
  };
}

function installReceiverFetch() {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`) {
      return json({ environmentId: 'environment-current' });
    }
    if (url === `${CURRENT_API}/api/agents/reviewer`) {
      return json({
        success: true,
        data: { slug: 'reviewer', name: 'Reviewer', available: true },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

/** Receiver admission stub: resourcePath is absolute so the resolver's cwd
 * and the tool's admitted-coordinate check agree exactly. */
function admissionStub(
  resourcePath: string,
  recheck: () => Promise<void> = async () => {},
) {
  return {
    portableProjectId: PORTABLE_WORKSPACE.portableProjectId,
    resourceId: PORTABLE_WORKSPACE.resourceId,
    admittedProject: {
      slug: 'local',
      localProjectId: 'local-project-1',
      resourcePath,
    },
    recheck,
  };
}

function localService(
  hooks: { onStart?: () => Promise<void>; onTurn?: () => Promise<void> } = {},
) {
  const startSessionInternal = vi.fn(
    async (command: Record<string, unknown>, _context: unknown) => {
      await hooks.onStart?.();
      return {
        status: 'accepted' as const,
        receipt: { commandId: 'start-command-1', status: 'accepted' },
        session: { threadId: command.input },
      };
    },
  );
  const dispatchWithReceipt = vi.fn(
    async (command: Record<string, unknown>) => {
      await hooks.onTurn?.();
      return {
        receipt: { commandId: 'command-1', status: 'accepted' },
        result:
          command.type === 'sendTurn'
            ? { turnId: 'provider-turn-local' }
            : command,
      };
    },
  );
  return {
    readSession: vi.fn(async () => null),
    currentConversationSessionId: vi.fn(
      (conversationId: string) => conversationId,
    ),
    getProviderAdapter: vi.fn(() => ({
      metadata: {
        modelLaunch: {
          defaultAtStart: 'engine-selected',
          omissionAtResume: 'engine-selected',
          omissionPerTurn: 'engine-selected',
          overrideAtStart: true,
          overrideAtResume: true,
          overridePerTurn: true,
        },
      },
    })),
    dispatchWithReceipt,
    startSessionInternal,
  };
}

let dir: string;
let resourcePath: string;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  installReceiverFetch();
  dir = mkdtempSync(join(tmpdir(), 'delegation-attempt-tool-'));
  resourcePath = join(dir, 'checkout');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function claimInput(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'Ship the portable thing',
    target: portableTarget(),
    receiverAdmission: admissionStub(resourcePath),
    delegationAttemptId: 'attempt-1',
    delegationAttemptCaller: { deviceId: 'dev-verified-1' },
    delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(dir),
    ...overrides,
  };
}

describe('receiver-local claim → single effect', () => {
  test('the first create claims, binds admitted facts, and accepts with one start + one turn', async () => {
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    const result = await delegateTask(claimInput(), service as never);
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect(service.dispatchWithReceipt).toHaveBeenCalledTimes(1);
    expect(service.dispatchWithReceipt.mock.calls[0]![0]).toMatchObject({
      type: 'sendTurn',
    });
    // The reserved task id IS the started session id: the claim links to
    // the one real task through existing session evidence.
    const startedInput = service.startSessionInternal.mock.calls[0]![0] as {
      input: { threadId: string };
    };
    expect(result.taskId).toBe(startedInput.input.threadId);
    const store = new FileDelegationAttemptClaimStore(dir);
    const record = await store.read('dev-verified-1:attempt-1');
    expect(record?.state).toBe('accepted');
    expect(record?.taskId).toBe(result.taskId);
    // Server-derived admitted facts bound under the SAME claim, before the
    // provider effect — never part of the initial raw-intent digest.
    expect(record?.admitted).toMatchObject({
      portableProjectId: 'prj_shared',
      resourceId: 'git.example/acme/repo',
      localProjectId: 'local-project-1',
    });
  });

  test('concurrent identical creates: ONE effect; the loser names the claim', async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const service = localService({
      onStart: () => gate,
    });
    const { delegateTask } = await import('../station-control-delegation.js');
    const first = delegateTask(claimInput(), service as never);
    // Wait until the winner has durably RESERVED (not merely started) so
    // the overlap is real: the loser must join, not create.
    const probe = new FileDelegationAttemptClaimStore(dir);
    await vi.waitFor(async () => {
      expect(await probe.read('dev-verified-1:attempt-1')).toBeDefined();
    });
    const second = delegateTask(claimInput(), service as never);
    await expect(second).rejects.toBeInstanceOf(DelegationAttemptPendingError);
    releaseStart();
    const result = await first;
    expect(result.taskId).toMatch(/^task:/);
    // Exactly one session start and one first turn across BOTH requests.
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect(service.dispatchWithReceipt).toHaveBeenCalledTimes(1);
    const record = await probe.read('dev-verified-1:attempt-1');
    expect(record?.state).toBe('accepted');
    expect(record?.taskId).toBe(result.taskId);
  });

  test('mismatched validated intent under the same key conflicts with NO effect', async () => {
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    await delegateTask(claimInput(), service as never);
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    const error = await delegateTask(
      claimInput({ prompt: 'A DIFFERENT validated prompt' }),
      service as never,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DelegationAttemptConflictError);
    // No second session, no second turn.
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect(service.dispatchWithReceipt).toHaveBeenCalledTimes(1);
  });

  test('lost-ACK lookup settles from persisted evidence WITHOUT a re-POST', async () => {
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    const result = await delegateTask(claimInput(), service as never);
    // The acknowledgement is "lost": settle purely from the durable claim,
    // exactly as the authorized lookup does — no second create call.
    const store = new FileDelegationAttemptClaimStore(dir);
    const projection = projectDelegationAttemptClaim(
      await store.read('dev-verified-1:attempt-1'),
      'attempt-1',
    );
    expect(projection).toEqual({
      attemptId: 'attempt-1',
      state: 'accepted',
      taskId: result.taskId,
    });
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
  });
});

describe('crash classification — retained claims, never a second effect', () => {
  test('a post-effect turn failure RETAINS the accepted claim; redelivery names the real task', async () => {
    // The start is durably accepted (session evidence exists) BEFORE the
    // first turn dispatches, so a turn-transport failure cannot unaccept
    // the claim: the one real task genuinely exists and the redelivery
    // names it instead of launching a second session.
    let failTurn = true;
    const service = localService({
      onTurn: async () => {
        if (failTurn) {
          failTurn = false;
          throw new Error('provider transport died after start');
        }
      },
    });
    const { delegateTask } = await import('../station-control-delegation.js');
    await expect(delegateTask(claimInput(), service as never)).rejects.toThrow(
      /provider transport died/,
    );
    const store = new FileDelegationAttemptClaimStore(dir);
    expect((await store.read('dev-verified-1:attempt-1'))?.state).toBe(
      'accepted',
    );
    const { DelegationAttemptExistsError } = await import(
      '../../services/orchestration/delegation-attempt-claim-store.js'
    );
    const error = await delegateTask(claimInput(), service as never).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DelegationAttemptExistsError);
    // Still exactly one session start and one turn attempt — the redelivery
    // executed nothing.
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect(service.dispatchWithReceipt).toHaveBeenCalledTimes(1);
  });

  test('an owner that dies while admitted leaves a pending claim: redelivery launches nothing', async () => {
    // Models the true crash window: reserve + admitted-fact bind committed,
    // then the owner died before invoking the start (its token is lost with
    // it). Driven through the REAL store; only the death itself is modeled
    // by never proceeding.
    const store = new FileDelegationAttemptClaimStore(dir);
    const { delegationAttemptIntentDigest } = await import(
      '../../services/orchestration/delegation-attempt-claim-store.js'
    );
    const created = await store.reserve({
      key: 'dev-verified-1:attempt-1',
      attemptId: 'attempt-1',
      callerDeviceId: 'dev-verified-1',
      intentDigest: delegationAttemptIntentDigest({
        prompt: 'Ship the portable thing',
        target: portableTarget(),
      }),
      taskId: 'task:crashed-owner-minted',
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    await store.bindAdmitted('dev-verified-1:attempt-1', created.ownerToken, {
      portableProjectId: PORTABLE_WORKSPACE.portableProjectId,
      resourceId: PORTABLE_WORKSPACE.resourceId,
      localProjectId: 'local-project-1',
    });
    // …owner dies here; token lost. The redelivery joins the indeterminate
    // claim — pending, never a session start and never a turn — and the
    // lookup stays conservative.
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    await expect(
      delegateTask(claimInput(), service as never),
    ).rejects.toBeInstanceOf(DelegationAttemptPendingError);
    expect(service.startSessionInternal).not.toHaveBeenCalled();
    expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
    expect(
      projectDelegationAttemptClaim(
        await store.read('dev-verified-1:attempt-1'),
        'attempt-1',
      ),
    ).toEqual({ attemptId: 'attempt-1', state: 'preparing' });
  });

  test('a crash BEFORE the rename commit leaves NO claim: the retry may proceed', async () => {
    let failCommit = true;
    const faulting = new FileDelegationAttemptClaimStore(dir, {
      beforeCommit: () => {
        if (failCommit) {
          failCommit = false;
          throw new Error('simulated crash before commit');
        }
      },
    });
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    await expect(
      delegateTask(
        claimInput({ delegationAttemptClaimStore: faulting }),
        service as never,
      ),
    ).rejects.toThrow(/simulated crash/);
    // Nothing durable happened: no claim, no session, no turn.
    expect(await faulting.read('dev-verified-1:attempt-1')).toBeUndefined();
    expect(service.startSessionInternal).not.toHaveBeenCalled();
    // The retry reserves cleanly (nothing was ever committed to conflict
    // with) and executes exactly once.
    const result = await delegateTask(
      claimInput({ delegationAttemptClaimStore: faulting }),
      service as never,
    );
    expect(result.taskId).toMatch(/^task:/);
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect((await faulting.read('dev-verified-1:attempt-1'))?.state).toBe(
      'accepted',
    );
  });

  test('a clean pre-effect refusal settles refused: terminal, no effect, key never re-executes', async () => {
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    const refusing = admissionStub(resourcePath, async () => {
      throw new ReceiverExecutionRefusal(
        'receiver_execution_not_offered',
        'Offer withdrawn before the effect.',
      );
    });
    const error = await delegateTask(
      claimInput({ receiverAdmission: refusing }),
      service as never,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReceiverExecutionRefusal);
    expect(service.startSessionInternal).not.toHaveBeenCalled();
    expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
    const store = new FileDelegationAttemptClaimStore(dir);
    expect((await store.read('dev-verified-1:attempt-1'))?.state).toBe(
      'refused',
    );
    // The refused key can never execute again — the SAME intent pends
    // against the tombstone, and changed intent under the key conflicts
    // (the original claim stands) — and the lookup names the terminal.
    await expect(
      delegateTask(claimInput(), service as never),
    ).rejects.toBeInstanceOf(DelegationAttemptPendingError);
    await expect(
      delegateTask(
        claimInput({ prompt: 'changed intent, same key' }),
        service as never,
      ),
    ).rejects.toBeInstanceOf(DelegationAttemptConflictError);
    expect(service.startSessionInternal).not.toHaveBeenCalled();
    expect(
      projectDelegationAttemptClaim(
        await store.read('dev-verified-1:attempt-1'),
        'attempt-1',
      ),
    ).toEqual({ attemptId: 'attempt-1', state: 'refused' });
  });

  test('a start-path explosion settles unresolved; redelivery launches nothing', async () => {
    // The invocation was reached (attemptStartInvoked) but no durable
    // acceptance exists: the claim goes `unresolved` — retained, never a
    // resend authorization — and the redelivery pends with zero effects.
    const service = localService();
    service.startSessionInternal.mockRejectedValueOnce(
      new Error('session start exploded mid-invocation'),
    );
    const { delegateTask } = await import('../station-control-delegation.js');
    await expect(delegateTask(claimInput(), service as never)).rejects.toThrow(
      /session start exploded/,
    );
    const store = new FileDelegationAttemptClaimStore(dir);
    expect((await store.read('dev-verified-1:attempt-1'))?.state).toBe(
      'unresolved',
    );
    await expect(
      delegateTask(claimInput(), service as never),
    ).rejects.toBeInstanceOf(DelegationAttemptPendingError);
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
    expect(
      projectDelegationAttemptClaim(
        await store.read('dev-verified-1:attempt-1'),
        'attempt-1',
      ),
    ).toEqual({ attemptId: 'attempt-1', state: 'unresolved' });
  });
});

describe('refusals before any claim — unsupported, unwired, legacy', () => {
  test('non-portable + attempt id refuses with NO claim and NO effect', async () => {
    installReceiverFetch();
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    const error = await delegateTask(
      {
        prompt: 'Ship it',
        target: {
          environment: { kind: 'current' as const },
          agent: agentId('reviewer'),
        },
        delegationAttemptId: 'attempt-1',
        delegationAttemptCaller: { deviceId: 'dev-verified-1' },
        delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(dir),
      },
      service as never,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReceiverExecutionRefusal);
    expect((error as ReceiverExecutionRefusal).code).toBe(
      'delegation_attempt_unsupported',
    );
    expect(service.startSessionInternal).not.toHaveBeenCalled();
    const store = new FileDelegationAttemptClaimStore(dir);
    expect(await store.read('dev-verified-1:attempt-1')).toBeUndefined();
  });

  test.each([
    ['missing store', { delegationAttemptClaimStore: undefined }],
    ['missing caller', { delegationAttemptCaller: undefined }],
  ])(
    'portable + attempt id with %s refuses rather than executing unclaimed',
    async (_label, strip) => {
      const service = localService();
      const { delegateTask } = await import('../station-control-delegation.js');
      const error = await delegateTask(
        claimInput({ ...strip }),
        service as never,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ReceiverExecutionRefusal);
      expect((error as ReceiverExecutionRefusal).code).toBe(
        'delegation_attempt_unsupported',
      );
      expect(service.startSessionInternal).not.toHaveBeenCalled();
    },
  );

  test('legacy calls without the field execute exactly as before (positive control)', async () => {
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    const result = await delegateTask(
      {
        prompt: 'Ship the portable thing',
        target: portableTarget(),
        receiverAdmission: admissionStub(resourcePath),
      },
      service as never,
    );
    expect(result.taskId).toMatch(/^task:/);
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    // No claim owner was composed, so no claim file was even created.
    const store = new FileDelegationAttemptClaimStore(dir);
    expect(await store.read('dev-verified-1:attempt-1')).toBeUndefined();
  });
});

describe('controller forwarding — capability gate + duplicate relay', () => {
  function installPeerFetch(
    remoteHandshake: unknown,
    peerPost: () => Response,
  ) {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${CURRENT_API}/api/environments/ssh`) {
        return json({ success: true, data: [] });
      }
      if (
        url ===
        `${CURRENT_API}/api/environments/peers/environment-remote/credential`
      ) {
        return json({
          success: true,
          data: {
            environmentId: 'environment-remote',
            apiBase: REMOTE_API,
            scope: 'orchestration:read orchestration:operate',
            credential: 'peer-secret',
            label: 'Station B',
          },
        });
      }
      if (url === `${REMOTE_API}/.well-known/station/v1`) {
        return json(remoteHandshake);
      }
      if (url === `${REMOTE_API}/api/orchestration/delegations`) {
        return peerPost();
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  function peerTarget() {
    return {
      environment: {
        kind: 'saved' as const,
        id: environmentId('environment-remote'),
      },
      agent: agentId('codex'),
      workspace: { ...PORTABLE_WORKSPACE },
    };
  }

  test('an attempt id is NOT forwarded to a receiver that hides the claim capability', async () => {
    let forwardedBody: unknown;
    installPeerFetch(
      {
        environmentId: 'environment-remote',
        capabilities: { portableExecutionOffers: true },
      },
      () => {
        forwardedBody = undefined;
        return json({ success: true, data: {} });
      },
    );
    // Capture the forward body by wrapping fetch for the delegations URL.
    const seen = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `${REMOTE_API}/api/orchestration/delegations`) {
        forwardedBody = JSON.parse(String(init?.body));
      }
      return seen(input, init);
    });
    const { delegateTask } = await import('../station-control-delegation.js');
    const error = await delegateTask({
      prompt: 'Ship the portable thing',
      target: peerTarget(),
      isRequestAuthorityCurrent: () => true,
      delegationAttemptId: 'attempt-1',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReceiverExecutionRefusal);
    expect((error as ReceiverExecutionRefusal).code).toBe(
      'delegation_attempt_unsupported',
    );
    // Refused BEFORE the forward: the older receiver never saw the field.
    expect(forwardedBody).toBeUndefined();
  });

  test('an advertised receiver gets the correlation; its 409 relays verbatim', async () => {
    let forwardedBody: Record<string, unknown> | undefined;
    installPeerFetch(
      {
        environmentId: 'environment-remote',
        capabilities: {
          portableExecutionOffers: true,
          delegationAttemptClaims: true,
        },
      },
      () =>
        json(
          {
            success: false,
            error:
              'A request with this attempt id was already accepted. The referenced task is the one and only execution.',
            code: 'delegation_attempt_exists',
            attemptId: 'attempt-1',
            taskId: 'task:receiver-real-1',
          },
          409,
        ),
    );
    const seen = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === `${REMOTE_API}/api/orchestration/delegations`) {
        forwardedBody = JSON.parse(String(init?.body));
      }
      return seen(input, init);
    });
    const { delegateTask } = await import('../station-control-delegation.js');
    const error = await delegateTask({
      prompt: 'Ship the portable thing',
      target: peerTarget(),
      isRequestAuthorityCurrent: () => true,
      delegationAttemptId: 'attempt-1',
    }).catch((caught: unknown) => caught);
    // The forward carried the opt-in correlation…
    expect(forwardedBody).toMatchObject({ attemptId: 'attempt-1' });
    // …and the receiver's duplicate came back typed, never laundered.
    expect(error).toBeInstanceOf(PeerDelegationAttemptDuplicateError);
    expect((error as PeerDelegationAttemptDuplicateError).code).toBe(
      'delegation_attempt_exists',
    );
    expect((error as PeerDelegationAttemptDuplicateError).attemptId).toBe(
      'attempt-1',
    );
    expect((error as PeerDelegationAttemptDuplicateError).taskId).toBe(
      'task:receiver-real-1',
    );
  });
});
