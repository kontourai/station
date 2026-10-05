/**
 * #2875 slice 1 — version-matched portable execution, receiver-local proof.
 *
 * Real `delegateTask`, the REAL file-backed attempt claim store, and a REAL
 * git checkout read by the real `git-commit` adapter. Only the session and
 * turn effects are typed doubles, so "no effect" is countable. Proves:
 *
 * - a matching HEAD on a clean tracked tree starts one session + one turn,
 *   binds the preparation facts on the claim, and returns the path-free
 *   receipt on the resolution;
 * - a different HEAD, a modified tracked file, an unknown protocol, mode,
 *   scheme, guarantee or resource kind, a protection requirement, worktree
 *   isolation and a missing attempt each refuse with their typed code
 *   BEFORE any session, and the claim tombstone records that code;
 * - a commit landing between the first check and the session start is
 *   caught by the pre-start recheck, still before any effect;
 * - a sender refuses to forward the prepared variant to a receiver that
 *   does not advertise `executionPreparation`, and forwards it intact to
 *   one that does.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  delegationAttemptClaimKey,
  FileDelegationAttemptClaimStore,
  projectDelegationAttemptClaim,
} from '../../services/orchestration/delegation-attempt-claim-store.js';
import { ReceiverExecutionRefusal } from '../../services/projects/project-contribution-service.js';

process.env.STATION_API_BASE = 'http://preparation.test';
process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';

const CURRENT_API = 'http://preparation.test';
const REMOTE_API = 'http://127.0.0.1:45235';
const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PORTABLE_PROJECT_ID = 'prj_shared';
const RESOURCE_ID = 'git.example/acme/repo';
const SUPPORTED = {
  protocol: 'station.execution-preparation/v1',
  mode: 'existing-realization',
  guarantees: ['version-matched-when-checked'],
};

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=preparation@example.test',
      '-c',
      'user.name=Preparation Test',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { PATH: process.env.PATH ?? '', HOME: cwd },
    },
  ).trim();
}

function createCheckout(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '--initial-branch', 'main']);
  writeFileSync(join(path, 'TRACKED.md'), 'tracked\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '-m', 'fixture']);
  return git(path, ['rev-parse', 'HEAD']);
}

function preparedTarget(
  preparation: Record<string, unknown>,
  environment:
    | { kind: 'current' }
    | { kind: 'saved'; id: ReturnType<typeof environmentId> } = {
    kind: 'current',
  },
) {
  return {
    environment,
    agent: agentId('reviewer'),
    workspace: {
      kind: 'project-portable-prepared' as const,
      portableProjectId: PORTABLE_PROJECT_ID,
      resourceId: RESOURCE_ID,
      preparation: preparation as never,
    },
  };
}

function versionRequirement(value: string, overrides = {}) {
  return {
    ...SUPPORTED,
    version: { scheme: 'git-commit', value },
    ...overrides,
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

function admissionStub(
  path: string,
  overrides: Record<string, unknown> = {},
  recheck: () => Promise<void> = async () => {},
) {
  return {
    portableProjectId: PORTABLE_PROJECT_ID,
    resourceId: RESOURCE_ID,
    admittedProject: {
      slug: 'local',
      localProjectId: 'local-project-1',
      resourcePath: path,
      resourceKind: 'git' as const,
      ...overrides,
    },
    recheck,
  };
}

function localService() {
  const startSessionInternal = vi.fn(
    async (command: Record<string, unknown>, _context: unknown) => ({
      status: 'accepted' as const,
      receipt: { commandId: 'start-command-1', status: 'accepted' },
      session: { threadId: command.input },
    }),
  );
  const dispatchWithReceipt = vi.fn(
    async (command: Record<string, unknown>) => ({
      receipt: { commandId: 'command-1', status: 'accepted' },
      result:
        command.type === 'sendTurn'
          ? { turnId: 'provider-turn-local' }
          : command,
    }),
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

const makeTempDir = trackTempDirs();
let dir: string;
let checkout: string;
let head: string;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  installReceiverFetch();
  dir = makeTempDir('delegation-preparation-');
  checkout = join(dir, 'checkout');
  head = createCheckout(checkout);
});

const CLAIM_KEY = delegationAttemptClaimKey('dev-verified-1', 'attempt-1');

function claimInput(preparation: Record<string, unknown>, overrides = {}) {
  return {
    prompt: 'Run at the requested commit',
    target: preparedTarget(preparation),
    receiverAdmission: admissionStub(checkout),
    delegationAttemptId: 'attempt-1',
    delegationAttemptCaller: { deviceId: 'dev-verified-1' },
    delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(dir),
    ...overrides,
  };
}

async function expectRefusedBeforeEffect(
  input: Record<string, unknown>,
  code: string,
) {
  const service = localService();
  const { delegateTask } = await import('../station-control-delegation.js');
  const error = await delegateTask(input as never, service as never).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ReceiverExecutionRefusal);
  expect((error as ReceiverExecutionRefusal).code).toBe(code);
  expect(service.startSessionInternal).not.toHaveBeenCalled();
  expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
  return service;
}

async function expectClaimRefusedWith(code: string) {
  const record = await new FileDelegationAttemptClaimStore(dir).read(CLAIM_KEY);
  expect(record?.state).toBe('refused');
  expect(record?.refusalCode).toBe(code);
  expect(projectDelegationAttemptClaim(record, 'attempt-1')).toMatchObject({
    state: 'refused',
    refusalCode: code,
  });
}

describe('receiver-local version check', () => {
  test('a matching HEAD starts once and returns the path-free receipt', async () => {
    writeFileSync(join(checkout, 'scratch.txt'), 'untracked\n');
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    const handle = await delegateTask(
      claimInput(versionRequirement(head)),
      service as never,
    );
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect(service.dispatchWithReceipt).toHaveBeenCalledTimes(1);
    const receipt = handle.resolution?.preparation;
    expect(receipt).toMatchObject({
      protocol: 'station.execution-preparation/v1',
      mode: 'existing-realization',
      resourceId: RESOURCE_ID,
      requested: { scheme: 'git-commit', value: head },
      observed: { scheme: 'git-commit', value: head },
      guarantee: 'version-matched-when-checked',
      trackedChanges: 'none',
      untrackedFiles: 1,
      setup: 'not-performed',
    });
    // Path-free: neither the checkout nor the untracked file name leaks.
    expect(JSON.stringify(receipt)).not.toContain(checkout);
    expect(JSON.stringify(receipt)).not.toContain('scratch.txt');
    const record = await new FileDelegationAttemptClaimStore(dir).read(
      CLAIM_KEY,
    );
    expect(record?.state).toBe('accepted');
    // The claim keeps the first check; the receipt is the pre-start recheck.
    const { checkedAt: _first, ...bound } = record!.admitted!.preparation!;
    const { checkedAt: _last, ...returned } = receipt!;
    expect(bound).toEqual(returned);
  });

  test('a different HEAD refuses before any session and records the code', async () => {
    const other = 'f'.repeat(40);
    await expectRefusedBeforeEffect(
      claimInput(versionRequirement(other)),
      'execution_preparation_version_mismatch',
    );
    await expectClaimRefusedWith('execution_preparation_version_mismatch');
  });

  test('an abbreviated commit never matches', async () => {
    await expectRefusedBeforeEffect(
      claimInput(versionRequirement(head.slice(0, 12))),
      'execution_preparation_version_mismatch',
    );
  });

  test('a modified tracked file refuses even at the right HEAD', async () => {
    writeFileSync(join(checkout, 'TRACKED.md'), 'changed\n');
    await expectRefusedBeforeEffect(
      claimInput(versionRequirement(head)),
      'execution_preparation_tracked_changes',
    );
    await expectClaimRefusedWith('execution_preparation_tracked_changes');
  });

  test('a staged change to a tracked file refuses too', async () => {
    writeFileSync(join(checkout, 'TRACKED.md'), 'staged\n');
    git(checkout, ['add', 'TRACKED.md']);
    await expectRefusedBeforeEffect(
      claimInput(versionRequirement(head)),
      'execution_preparation_tracked_changes',
    );
  });

  test.each([
    [
      { protocol: 'station.execution-preparation/v2' },
      'execution_preparation_unsupported',
    ],
    [{ mode: 'materialized-copy' }, 'execution_preparation_mode_unsupported'],
    [
      { mode: 'remote-reference' },
      'execution_preparation_remote_reference_unsupported',
    ],
    [
      { guarantees: ['atomic-capture'] },
      'execution_preparation_guarantee_unsupported',
    ],
    [
      {
        guarantees: [
          'version-matched-when-checked',
          'protected-during-execution',
        ],
      },
      'execution_preparation_protection_unavailable',
    ],
  ])(
    'requirement %j refuses with %s before admission',
    async (override, code) => {
      let admissionRead = false;
      const admission = admissionStub(checkout);
      await expectRefusedBeforeEffect(
        claimInput(versionRequirement(head, override), {
          receiverAdmission: undefined,
          authorizeReceiverExecution: async () => {
            admissionRead = true;
            return admission;
          },
        }),
        code,
      );
      // Refused before the operator's offer was consulted.
      expect(admissionRead).toBe(false);
      await expectClaimRefusedWith(code);
    },
  );

  test('an unknown version scheme refuses', async () => {
    await expectRefusedBeforeEffect(
      claimInput({
        ...SUPPORTED,
        version: { scheme: 'document-etag', value: head },
      }),
      'execution_preparation_scheme_unsupported',
    );
  });

  test('a resource kind with no registered adapter refuses', async () => {
    await expectRefusedBeforeEffect(
      claimInput(versionRequirement(head), {
        receiverAdmission: admissionStub(checkout, {
          resourceKind: 'local-only',
        }),
      }),
      'execution_preparation_kind_unsupported',
    );
    await expectClaimRefusedWith('execution_preparation_kind_unsupported');
  });

  test('worktree isolation refuses: the checked checkout is not where work runs', async () => {
    await expectRefusedBeforeEffect(
      claimInput(versionRequirement(head), {
        receiverAdmission: admissionStub(checkout, {
          defaultWorkspaceIsolation: 'worktree',
        }),
      }),
      'execution_preparation_isolation_unsupported',
    );
    await expectClaimRefusedWith('execution_preparation_isolation_unsupported');
  });

  test('a prepared intent without an attempt refuses', async () => {
    await expectRefusedBeforeEffect(
      claimInput(versionRequirement(head), {
        delegationAttemptId: undefined,
        delegationAttemptCaller: undefined,
      }),
      'execution_preparation_attempt_required',
    );
  });

  test('a commit landing before the session start is caught by the pre-start recheck', async () => {
    let rechecks = 0;
    const admission = admissionStub(checkout, {}, async () => {
      rechecks += 1;
      // The admission recheck runs immediately before the start; move HEAD
      // there, after the first version check already passed.
      writeFileSync(join(checkout, 'TRACKED.md'), 'moved\n');
      git(checkout, ['commit', '-am', 'moved']);
    });
    await expectRefusedBeforeEffect(
      claimInput(versionRequirement(head), { receiverAdmission: admission }),
      'execution_preparation_version_mismatch',
    );
    expect(rechecks).toBe(1);
    await expectClaimRefusedWith('execution_preparation_version_mismatch');
    // The first check passed and was bound, but a refused attempt keeps no
    // "version matched" receipt.
    const record = await new FileDelegationAttemptClaimStore(dir).read(
      CLAIM_KEY,
    );
    expect(record?.admitted).toBeDefined();
    expect(record?.admitted?.preparation).toBeUndefined();
  });

  test('the reattach path rechecks the version before its turn', async () => {
    const { delegateTask } = await import('../station-control-delegation.js');
    // Lift the exact server-stamped binding from one normal start, as the
    // #485 reattach test does, so the reattach read passes its binding check.
    const calibrator = localService();
    await delegateTask(
      claimInput(versionRequirement(head), {
        userId: 'reattach-user',
        delegationAttemptId: 'calibrate',
      }),
      calibrator as never,
    );
    const bindingMetadata = (
      calibrator.startSessionInternal.mock.calls[0]![0] as {
        input: { metadata: Record<string, unknown> };
      }
    ).input.metadata;
    const existingSessionId = 'task:22222222-2222-4222-8222-222222222222';
    const service = {
      ...localService(),
      readSession: vi.fn(async () => {
        // HEAD moves after the first check, while the session is read.
        writeFileSync(join(checkout, 'TRACKED.md'), 'reattached\n');
        git(checkout, ['commit', '-am', 'moved during reattach']);
        return {
          session: { threadId: existingSessionId },
          events: [{ method: 'session.configured', metadata: bindingMetadata }],
        };
      }),
    };
    const error = await delegateTask(
      claimInput(versionRequirement(head), {
        userId: 'reattach-user',
        sessionId: existingSessionId,
      }),
      service as never,
    ).catch((caught: unknown) => caught);
    expect((error as ReceiverExecutionRefusal).code).toBe(
      'execution_preparation_version_mismatch',
    );
    expect(service.readSession).toHaveBeenCalled();
    expect(service.dispatchWithReceipt).not.toHaveBeenCalled();
    await expectClaimRefusedWith('execution_preparation_version_mismatch');
  });

  test('control: a plain portable intent carries no preparation receipt', async () => {
    const service = localService();
    const { delegateTask } = await import('../station-control-delegation.js');
    const handle = await delegateTask(
      {
        prompt: 'Run without a version requirement',
        target: {
          environment: { kind: 'current' },
          agent: agentId('reviewer'),
          workspace: {
            kind: 'project-portable',
            portableProjectId: PORTABLE_PROJECT_ID,
            resourceId: RESOURCE_ID,
          },
        },
        receiverAdmission: admissionStub(checkout),
      },
      service as never,
    );
    expect(service.startSessionInternal).toHaveBeenCalledTimes(1);
    expect(handle.resolution?.preparation).toBeUndefined();
  });
});

describe('sender capability gate', () => {
  async function peerForwarder() {
    const { createRemoteStationForwarder } = await import(
      '../../services/remote-stations/remote-station-forwarder.js'
    );
    return createRemoteStationForwarder({
      ssh: {
        list: () => [],
        connect: async () => {
          throw new Error('no SSH profile');
        },
      },
      peers: {
        get: (id: string) =>
          id === 'environment-remote'
            ? {
                environmentId: id,
                apiBase: REMOTE_API,
                scope: 'orchestration:read orchestration:operate',
                credential: 'peer-secret',
                label: 'Station B',
                createdAt: 0,
                updatedAt: 0,
              }
            : null,
      },
    });
  }

  function installPeerFetch(capabilities: Record<string, boolean>) {
    const forwarded: unknown[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `${CURRENT_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-current' });
      }
      if (url === `${REMOTE_API}/.well-known/station/v1`) {
        return json({ environmentId: 'environment-remote', capabilities });
      }
      if (url === `${REMOTE_API}/api/orchestration/delegations`) {
        forwarded.push(JSON.parse(String(init?.body)));
        return json({
          success: true,
          data: { taskId: 'task:remote-1', sessionId: 'task:remote-1' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    return forwarded;
  }

  const savedRemote = {
    kind: 'saved' as const,
    id: environmentId('environment-remote'),
  };

  test('an older receiver is refused before the wire', async () => {
    const forwarded = installPeerFetch({
      portableExecutionOffers: true,
      delegationAttemptClaims: true,
    });
    const { delegateTask } = await import('../station-control-delegation.js');
    const error = await delegateTask(
      {
        prompt: 'Run at the requested commit',
        target: preparedTarget(versionRequirement(head), savedRemote),
        isRequestAuthorityCurrent: () => true,
        delegationAttemptId: 'attempt-1',
      },
      undefined,
      await peerForwarder(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReceiverExecutionRefusal);
    expect((error as ReceiverExecutionRefusal).code).toBe(
      'execution_preparation_unsupported',
    );
    expect(forwarded).toHaveLength(0);
  });

  test('an advertising receiver gets the requirement intact', async () => {
    const forwarded = installPeerFetch({
      portableExecutionOffers: true,
      delegationAttemptClaims: true,
      executionPreparation: true,
    });
    const { delegateTask } = await import('../station-control-delegation.js');
    await delegateTask(
      {
        prompt: 'Run at the requested commit',
        target: preparedTarget(versionRequirement(head), savedRemote),
        isRequestAuthorityCurrent: () => true,
        delegationAttemptId: 'attempt-1',
      },
      undefined,
      await peerForwarder(),
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      attemptId: 'attempt-1',
      target: {
        workspace: {
          kind: 'project-portable-prepared',
          preparation: versionRequirement(head),
        },
      },
    });
  });
});
