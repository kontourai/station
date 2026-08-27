import { resolve } from 'node:path';
import {
  encodeTaskGateEvaluationReference,
  encodeTaskToolResultReference,
} from '@kontourai/station-contracts';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test, vi } from 'vitest';
import { expandTilde } from '../../../utils/paths.js';
import type { SessionQueryModule } from '../../orchestration/session-query-module.js';
import {
  createTaskGateEvaluationReferenceReadAdapter,
  createTaskToolResultReferenceReadAdapter,
} from '../task-tool-result-reference-read-adapter.js';

const authority = sessionReadAuthorityFromRequest(
  'owner',
  undefined,
  undefined,
);

function result(sessionId: string, eventId: string) {
  return {
    status: 'found' as const,
    sessionId,
    eventId,
    projectSlug: 'project-a',
    result: {
      resultId: eventId,
      name: 'shell',
      terminalStatus: 'success' as const,
      content: [],
      truncated: false,
      omittedParts: 0,
      omittedTextBytes: 0,
      omittedMetadataBytes: 0,
    },
  };
}

function fixture() {
  let links = [
    {
      id: 'keep-a',
      targetId: encodeTaskToolResultReference('session-a', 'event-a'),
    },
  ];
  let sessionCurrent = true;
  const readToolResult = vi.fn<
    NonNullable<SessionQueryModule['readToolResult']>
  >(async ({ threadId, eventId }) => result(threadId, eventId));
  const adapter = createTaskToolResultReferenceReadAdapter({
    taskGraph: {
      readTaskTurnReferenceScope: () => ({ projectId: 'project-a' }),
      readTaskToolResultReferenceLinks: () => links,
    },
    sessionQueries: { readToolResult },
    canReadSession: (sessionId) => sessionCurrent && sessionId !== 'session-b',
  });
  return {
    adapter,
    readToolResult,
    addDuplicate: () => {
      links = [...links, { ...links[0]!, id: 'keep-b' }];
    },
    addDenied: () => {
      links = [
        ...links,
        {
          id: 'keep-denied',
          targetId: encodeTaskToolResultReference('session-b', 'event-b'),
        },
      ];
    },
    replaceLinks: () => {
      links = [
        {
          id: 'keep-b',
          targetId: encodeTaskToolResultReference('session-b', 'event-b'),
        },
      ];
    },
    revokeSession: () => {
      sessionCurrent = false;
    },
  };
}

describe('Task kept tool-result owner adapter', () => {
  test('reads a Task whose binding is stored with a tilde (station#4292)', async () => {
    // EVERY other fixture in this file stores an already-absolute
    // workingDirectory, so none of them could observe this: the Task's
    // captured binding holds what the user stored (`~/dev/repo`), while
    // `resolveProjectWorkspace` returns `resolve(expandTilde(...))`. The two
    // named the same directory, compared unequal as raw strings, and the
    // owner read was silently refused for every tilde-stored project.
    const expanded = resolve(expandTilde('~/dev/repo'));
    const owner = vi.fn(async () => ({ status: 'not-found' }));
    // The gate-evaluation adapter's own link shape (see the dedup test
    // below): a tool-result reference is skipped before the owner is reached.
    const ref = {
      runId: 'run-a',
      gateId: 'gate-a',
      evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const link = {
      id: 'keep-a',
      targetId: encodeTaskGateEvaluationReference(ref),
    };
    const adapter = createTaskGateEvaluationReferenceReadAdapter({
      taskGraph: {
        readTask: () => ({
          id: 'task-a',
          projectId: 'project-a',
          workspaceBinding: {
            availability: 'available',
            workingDirectory: '~/dev/repo',
          },
        }),
        readTaskGateEvaluationReferenceLinks: () => [link],
      },
      resolveProjectWorkspace: () => expanded,
      isRequestPrincipalCurrent: () => true,
      readFlowGateEvaluation: owner,
    } as never);
    await adapter.read({
      taskId: 'task-a',
      request: new Request('http://station.test'),
    });
    // Assert the OWNER WAS REACHED, not the returned status: a binding
    // mismatch short-circuits to `{ status: 'not-found' }`, which is also
    // what a reached-but-empty owner returns, so the status cannot tell the
    // two apart. Whether the owner ran can.
    expect(owner).toHaveBeenCalledOnce();
  });

  test('uses one exact owner read per tuple while retaining ordered Task keep identities', async () => {
    const f = fixture();
    f.addDuplicate();
    await expect(
      f.adapter.read({ taskId: 'task-a', authority }),
    ).resolves.toEqual({
      status: 'found',
      references: [
        expect.objectContaining({
          referenceId: 'keep-a',
          ref: {
            authority: '@kontourai/thread',
            schemaVersion: '1.2.0',
            kind: 'result',
            threadId: 'session-a',
            resultId: 'event-a',
          },
        }),
        expect.objectContaining({ referenceId: 'keep-b' }),
      ],
    });
    expect(f.readToolResult).toHaveBeenCalledTimes(1);
  });

  test('keeps an authorized sibling while reducing a denied or substituted owner result to one opaque gap', async () => {
    const f = fixture();
    f.addDenied();
    f.readToolResult.mockImplementation(async ({ threadId, eventId }) =>
      threadId === 'session-a'
        ? result(threadId, eventId)
        : { status: 'not-found' },
    );
    const outcome = await f.adapter.read({ taskId: 'task-a', authority });
    expect(outcome).toMatchObject({
      status: 'found',
      references: [expect.objectContaining({ referenceId: 'keep-a' })],
      gaps: [{ state: 'restricted' }],
    });
    expect(JSON.stringify(outcome)).not.toContain('session-b');
  });

  test.each(['link-drift', 'session-revocation'] as const)(
    'withholds all references when %s occurs during owner I/O',
    async (change) => {
      const f = fixture();
      let resolve!: (value: ReturnType<typeof result>) => void;
      f.readToolResult.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = f.adapter.read({ taskId: 'task-a', authority });
      await vi.waitFor(() => expect(f.readToolResult).toHaveBeenCalledOnce());
      if (change === 'link-drift') f.replaceLinks();
      else f.revokeSession();
      resolve(result('session-a', 'event-a'));
      await expect(pending).resolves.toEqual({ status: 'unavailable' });
    },
  );

  test('returns an unavailable gap for an owner outage without leaking the protected tuple', async () => {
    const f = fixture();
    f.readToolResult.mockRejectedValueOnce(new Error('private-owner-canary'));
    const outcome = await f.adapter.read({ taskId: 'task-a', authority });
    expect(outcome).toEqual({
      status: 'found',
      references: [],
      gaps: [{ state: 'unavailable' }],
    });
    expect(JSON.stringify(outcome)).not.toContain('private-owner-canary');
  });
});

test('gate reader deduplicates canonical Flow tuples and withholds publication after membership drift', async () => {
  const ref = {
    runId: 'run-a',
    gateId: 'gate-a',
    evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  let links = [
    { id: 'keep-a', targetId: encodeTaskGateEvaluationReference(ref) },
    { id: 'keep-b', targetId: encodeTaskGateEvaluationReference(ref) },
  ];
  let release!: (value: unknown) => void;
  const owner = vi.fn(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const adapter = createTaskGateEvaluationReferenceReadAdapter({
    taskGraph: {
      readTask: () => ({
        id: 'task-a',
        projectId: 'project-a',
        workspaceBinding: {
          availability: 'available',
          workingDirectory: '/workspace',
        },
      }),
      readTaskGateEvaluationReferenceLinks: () => links,
    },
    resolveProjectWorkspace: () => '/workspace',
    isRequestPrincipalCurrent: () => true,
    readFlowGateEvaluation: owner,
  });
  const pending = adapter.read({
    taskId: 'task-a',
    request: new Request('http://station.test'),
  });
  await vi.waitFor(() => expect(owner).toHaveBeenCalledOnce());
  links = [];
  release({
    status: 'found',
    evaluation: {
      ref,
      evaluatedAt: '2026-08-26T00:00:00.000Z',
      originalVerdict: 'block',
      kind: 'initial',
      trigger: 'ordinary',
      currentStanding: 'current',
      currentRun: { status: 'active', currentStep: null },
      selectedEvidence: [],
      validityAsOf: '2026-08-26T00:00:00.000Z',
      validityScope: 'retained-immutable-bundle',
      externalRevocation: 'not-observed',
    },
  });
  await expect(pending).resolves.toEqual({ status: 'unavailable' });
  expect(owner).toHaveBeenCalledOnce();
});

test('gate reader rejects an old Task workspace before owner I/O', async () => {
  const owner = vi.fn();
  const adapter = createTaskGateEvaluationReferenceReadAdapter({
    taskGraph: {
      readTask: () => ({
        id: 'task-a',
        projectId: 'project-a',
        workspaceBinding: {
          availability: 'available',
          workingDirectory: '/old-workspace',
        },
      }),
      readTaskGateEvaluationReferenceLinks: () => [],
    },
    resolveProjectWorkspace: () => '/current-workspace',
    isRequestPrincipalCurrent: () => true,
    readFlowGateEvaluation: owner,
  });
  await expect(
    adapter.read({
      taskId: 'task-a',
      request: new Request('http://station.test'),
    }),
  ).resolves.toEqual({ status: 'not-found' });
  expect(owner).not.toHaveBeenCalled();
});

test.each(['project', 'binding', 'principal', 'membership'] as const)(
  'gate reader withholds a deferred owner row after %s drift',
  async (changed) => {
    const ref = {
      runId: 'run-a',
      gateId: 'gate-a',
      evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    let projectId = 'project-a';
    let binding = { availability: 'available', workingDirectory: '/workspace' };
    let principal = true;
    let links = [
      { id: 'keep-a', targetId: encodeTaskGateEvaluationReference(ref) },
    ];
    let release!: (value: unknown) => void;
    const owner = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const adapter = createTaskGateEvaluationReferenceReadAdapter({
      taskGraph: {
        readTask: () => ({
          id: 'task-a',
          projectId,
          workspaceBinding: binding,
        }),
        readTaskGateEvaluationReferenceLinks: () => links,
      },
      resolveProjectWorkspace: (id) =>
        id === 'project-a' ? '/workspace' : '/other-workspace',
      isRequestPrincipalCurrent: () => principal,
      readFlowGateEvaluation: owner,
    });
    const pending = adapter.read({
      taskId: 'task-a',
      request: new Request('http://station.test'),
    });
    await vi.waitFor(() => expect(owner).toHaveBeenCalledOnce());
    if (changed === 'project') projectId = 'project-b';
    if (changed === 'binding')
      binding = {
        availability: 'available',
        workingDirectory: '/other-workspace',
      };
    if (changed === 'principal') principal = false;
    if (changed === 'membership') links = [];
    release({ status: 'not-found' });
    await expect(pending).resolves.toEqual({ status: 'unavailable' });
  },
);
