import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ProjectTaskRoomAppendOutcome,
  ProjectTaskRoomAuthority,
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
} from '@kontourai/station-contracts/project-task-room';
import { isProjectTaskRoomAppendReceipt } from '@kontourai/station-contracts/project-task-room';
import { describe, expect, test } from 'vitest';
import {
  type LiveWorkAuthorization,
  type LiveWorkIdentity,
  type LiveWorkRecoveryAuthorization,
  LiveWorkSession,
} from '../../../domain/live-work-session.js';
import {
  ProjectTaskLiveWorkHistoryAdapter,
  type ProjectTaskRoomServerGrantIssuer,
} from '../project-task-live-work-history-adapter.js';
import { createProjectTaskRoomHistoryForTest } from '../project-task-room-history.js';

const scope = {
  projectId: 'project',
  taskId: 'task',
  surfaceId: 'surface',
  sessionId: 'session',
  channelId: 'channel',
} as const;
const actorGrant = (actorId = 'agent-a'): LiveWorkAuthorization => ({
  actorId,
  scope,
  capabilities: new Set([
    'join',
    'read',
    'write',
    'watch',
    'follow',
    'announce',
    'history-read',
  ]),
});
const recoveryGrant: LiveWorkRecoveryAuthorization = {
  kind: 'system',
  recoveryId: 'recovery',
  scope,
};
const identity = (actorId: string): LiveWorkIdentity => ({
  actor: { actorId, kind: 'agent', label: 'Server agent' },
  occurrenceId: `occurrence-${actorId}`,
  sessionId: 'session',
  runId: 'run-a',
  workName: 'Implement bridge',
  workState: 'working',
  startedAt: 0,
  ttlClosureRequestId: `ttl-${actorId}`,
});
const dependencies = {
  identityAuthority: {
    resolve: ({ actorId }: { actorId: string }) => ({
      state: 'AVAILABLE' as const,
      identity: identity(actorId),
    }),
  },
  recoveryAuthority: { authorize: () => true },
};
const grant = <K extends ProjectTaskRoomGrantKind>(capability: K) =>
  Object.freeze({
    schemaVersion: 'station.project-task-room-grant/v1' as const,
    capability,
    opaqueToken: `grant-${capability}`,
  }) as ProjectTaskRoomGrant<K>;
const receipt = (proposalId: string) => ({
  schemaVersion: 'station.project-task-room-append-receipt/v1' as const,
  proposalId,
  proposalDigest: 'a'.repeat(64),
  envelopeDigest: 'b'.repeat(64),
  coordinate: { channelId: 'room-channel', epoch: 0, seq: 1 },
  checkpoint: {
    channelId: 'room-channel',
    epoch: 0,
    throughSeq: 1,
    checkpointDigest: 'c'.repeat(64),
    retainedAnchorSeq: 0,
    retainedAnchorDigest: 'd'.repeat(64),
  },
  committedAt: '2026-01-01T00:00:00.000Z',
  assurance: 'L0' as const,
});

function room(
  append: (
    input: Parameters<ProjectTaskRoomAuthority['append']>[0],
  ) => Promise<ProjectTaskRoomAppendOutcome>,
): ProjectTaskRoomAuthority {
  return {
    open: async () => ({
      kind: 'opened',
      scope: { projectId: 'project', projectSlug: 'project', taskId: 'task' },
      channelId: 'room-channel',
      assurance: 'L0',
    }),
    append,
    read: async () => ({ kind: 'unavailable' }),
    close: async () => ({ kind: 'closed' }),
  };
}
function issuer(
  result: 'granted' | 'denied' | 'revoked' | 'unavailable' = 'granted',
): ProjectTaskRoomServerGrantIssuer {
  return {
    async issue({ capability }) {
      return result === 'granted'
        ? { kind: 'granted', grant: grant(capability) }
        : { kind: result };
    },
  };
}
function session(
  adapter: ProjectTaskLiveWorkHistoryAdapter,
  overrides: Record<string, unknown> = {},
) {
  return new LiveWorkSession(
    scope,
    {},
    { history: adapter, revision: adapter },
    { ...dependencies, ...overrides },
  );
}
async function joined(room: LiveWorkSession) {
  expect(
    room.join({ actorId: 'agent-a', requestId: 'join' }, actorGrant(), 0),
  ).toEqual({ outcome: 'joined' });
}

describe('ProjectTaskLiveWorkHistoryAdapter', () => {
  test('requires SHA-256 digest vocabulary in room receipts', () => {
    const valid = receipt('proposal');
    expect(isProjectTaskRoomAppendReceipt(valid)).toBe(true);
    for (const field of [
      'proposalDigest',
      'envelopeDigest',
      'checkpointDigest',
      'retainedAnchorDigest',
    ] as const) {
      const candidate = structuredClone(valid);
      if (field === 'checkpointDigest')
        candidate.checkpoint.checkpointDigest = 'x';
      else if (field === 'retainedAnchorDigest')
        candidate.checkpoint.retainedAnchorDigest = 'A'.repeat(64);
      else candidate[field] = 'q'.repeat(63);
      expect(isProjectTaskRoomAppendReceipt(candidate)).toBe(false);
    }
  });

  test('single-flights concurrent reconciliation of one indeterminate intent', async () => {
    const calls: Parameters<ProjectTaskRoomAuthority['append']>[0][] = [];
    const adapter = new ProjectTaskLiveWorkHistoryAdapter(
      room(async (input) => {
        calls.push(input);
        return calls.length === 1
          ? { kind: 'unavailable' }
          : { kind: 'committed', receipt: receipt(input.intent.proposalId) };
      }),
      issuer(),
    );
    const live = session(adapter);
    await joined(live);
    const pending = await live.announceAsync(
      { actorId: 'agent-a', requestId: 'announce' },
      actorGrant(),
      1,
    );
    expect(pending).toMatchObject({
      outcome: 'degraded',
      state: 'indeterminate',
    });
    if (pending.outcome !== 'degraded')
      throw new Error('expected pending intent');
    const settled = await Promise.all([
      live.reconcileAsync(pending.intentId, actorGrant(), 2),
      live.reconcileAsync(pending.intentId, actorGrant(), 2),
    ]);
    expect(settled).toEqual([settled[0], settled[0]]);
    expect(settled[0]).toMatchObject({ outcome: 'updated' });
    expect(calls).toHaveLength(2);
    const replay = live.replay(actorGrant(), 3);
    expect(replay).toMatchObject({
      outcome: 'available',
      events: [{ intentId: pending.intentId }],
    });
  });

  test('uses real room agent-publish authority for live material and fails closed after revocation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-live-room-'));
    let revoked = false;
    const room = createProjectTaskRoomHistoryForTest({
      databasePath: join(directory, 'room.sqlite'),
      capabilities: {
        async resolve({ grant: presented, required }) {
          if (presented.capability !== required) return { kind: 'denied' };
          return {
            kind: 'granted',
            receipt: {
              receiptId: `receipt-${required}`,
              capability: required,
              scope: {
                projectId: 'project',
                projectSlug: 'project',
                taskId: 'task',
              },
              principal: {
                kind: 'agent',
                agentId: 'agent-a',
                ownerOperatorId: 'owner',
                deviceId: 'device',
                authorizationReceiptId: 'authorization',
              },
              policyRevision: 'policy',
            },
          };
        },
      },
      agents: {
        async revalidate(receipt) {
          return revoked
            ? { kind: 'revoked' }
            : { kind: 'authorized', principal: receipt.principal as any };
        },
      },
      links: {
        async resolve({ kind }) {
          return {
            kind: 'resolved',
            link: {
              schemaVersion: 'station.project-task-room-resolved-link/v1',
              kind,
              stableId: `resolved-${kind}`,
              digest: `digest-${kind}`,
              authorityReceiptId: 'link-receipt',
            },
          };
        },
      },
    });
    const adapter = new ProjectTaskLiveWorkHistoryAdapter(room, issuer());
    const revisionId = `revision-evidence-v1:${'a'.repeat(64)}` as const;
    const live = session(adapter, {
      revisionAuthority: {
        resolveEvidence: () => ({
          state: 'AVAILABLE',
          revision: {
            revisionId,
            scope: {
              projectId: 'project',
              taskId: 'task',
              documentId: 'document',
            },
            correlation: {
              projectId: 'project',
              taskId: 'task',
              agentSessionId: 'session',
              runId: 'run-a',
            },
          },
        }),
      },
    });
    try {
      await expect(
        room.open({ grant: grant('discover') }),
      ).resolves.toMatchObject({
        kind: 'opened',
      });
      await joined(live);
      const announced = await live.announceAsync(
        { actorId: 'agent-a', requestId: 'announce' },
        actorGrant(),
        1,
      );
      expect(announced).toMatchObject({ outcome: 'updated' });
      await expect(
        live.referenceRevisionAsync(
          {
            actorId: 'agent-a',
            requestId: 'revision',
            reference: { revisionId, verification: 'verified' },
          },
          actorGrant(),
          2,
        ),
      ).resolves.toMatchObject({ outcome: 'updated' });
      await expect(
        live.finishAsync(
          { actorId: 'agent-a', requestId: 'finish', outcome: 'completed' },
          actorGrant(),
          3,
        ),
      ).resolves.toMatchObject({ outcome: 'updated' });
      await expect(
        live.departAsync(
          { actorId: 'agent-a', requestId: 'depart' },
          actorGrant(),
          4,
        ),
      ).resolves.toMatchObject({ outcome: 'updated' });
      revoked = true;
      const second = session(adapter);
      await joined(second);
      await expect(
        second.announceAsync(
          { actorId: 'agent-a', requestId: 'revoked' },
          actorGrant(),
          5,
        ),
      ).resolves.toMatchObject({ outcome: 'degraded', state: 'refused' });
    } finally {
      await room.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('freezes agent intent before grant await and rejects malformed room receipts', async () => {
    let release: (() => void) | undefined;
    const granted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const issued: ProjectTaskRoomGrantKind[] = [];
    const appended: Parameters<ProjectTaskRoomAuthority['append']>[0][] = [];
    const authority = room(async (input) => {
      appended.push(input);
      return { kind: 'committed', receipt: receipt(input.intent.proposalId) };
    });
    const adapter = new ProjectTaskLiveWorkHistoryAdapter(authority, {
      async issue({ capability }) {
        issued.push(capability);
        await granted;
        return { kind: 'granted', grant: grant(capability) };
      },
    });
    const intent = {
      kind: 'announce' as const,
      intentId: `live-work-v6:${'a'.repeat(64)}`,
      requestId: 'request',
      occurrenceId: 'occurrence',
      ordinal: 1,
      scope: { ...scope },
      actor: {
        actorId: 'agent-a',
        kind: 'agent' as const,
        label: 'Server agent',
      },
      work: {
        sessionId: 'session',
        runId: 'run-a',
        workName: 'Work',
        workState: 'working' as const,
        startedAt: 0,
      },
      occurredAt: 1,
    };
    const settling = adapter.commit(intent);
    (intent.scope as any).projectId = 'mutated';
    intent.actor.label = 'mutated';
    intent.work.sessionId = 'mutated';
    release!();
    await expect(settling).resolves.toMatchObject({ state: 'committed' });
    expect(issued).toEqual(['agent-publish']);
    expect(appended[0]!.intent).toMatchObject({ correlationId: 'session' });

    const malformed = new ProjectTaskLiveWorkHistoryAdapter(
      room(async () => ({ kind: 'committed', receipt: {} as never })),
      issuer(),
    );
    await expect(malformed.commit(intent)).resolves.toEqual({
      state: 'indeterminate',
    });
  });

  test('settles committed and duplicate room receipts exactly, without caller-issued grants', async () => {
    const calls: Parameters<ProjectTaskRoomAuthority['append']>[0][] = [];
    let first = true;
    const adapter = new ProjectTaskLiveWorkHistoryAdapter(
      room(async (input) => {
        calls.push(input);
        const kind = first ? 'committed' : 'duplicate';
        first = false;
        return { kind, receipt: receipt(input.intent.proposalId) };
      }),
      issuer(),
    );
    const live = session(adapter);
    await joined(live);
    expect(
      await live.announceAsync(
        { actorId: 'agent-a', requestId: 'announce' },
        actorGrant(),
        1,
      ),
    ).toMatchObject({
      outcome: 'updated',
      receipt: {
        kind: 'station.project-task-live-work-room-receipt/v1',
        disposition: 'committed',
      },
    });
    const replay = live.replay(actorGrant(), 2);
    expect(replay.outcome).toBe('available');
    const intentId =
      replay.outcome === 'available' ? replay.events[0]!.intentId : '';
    const duplicate = await adapter.commit(
      (replay as Extract<typeof replay, { outcome: 'available' }>).events[0]!,
    );
    expect(duplicate).toMatchObject({
      state: 'committed',
      receipt: { disposition: 'duplicate', proposalId: intentId },
    });
    expect(await live.reconcileAsync(intentId, actorGrant(), 3)).toMatchObject({
      outcome: 'updated',
      receipt: { disposition: 'committed', proposalId: intentId },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.intent.body).toMatchObject({
      kind: 'live-work-started',
      sessionId: 'session',
      runReference: 'run-a',
    });
    expect(calls[0]!.intent).toMatchObject({
      proposalId: intentId,
      correlationId: 'session',
      causationId: 'announce',
    });
  });

  test('maps denied, rejected, unavailable, throws, and malformed authority outcomes honestly', async () => {
    for (const [name, grants, response, expected] of [
      ['denied', issuer('denied'), undefined, 'refused'],
      [
        'rejected',
        issuer(),
        { kind: 'rejected', reason: 'capacity' } as const,
        'refused',
      ],
      [
        'unavailable',
        issuer(),
        { kind: 'unavailable' } as const,
        'indeterminate',
      ],
      ['throw', issuer(), new Error('network'), 'indeterminate'],
      ['malformed', issuer(), { kind: 'bogus' } as never, 'indeterminate'],
    ] as const) {
      const adapter = new ProjectTaskLiveWorkHistoryAdapter(
        room(async (input) => {
          if (response instanceof Error) throw response;
          return (
            response ?? {
              kind: 'committed',
              receipt: receipt(input.intent.proposalId),
            }
          );
        }),
        grants,
      );
      const live = session(adapter);
      await joined(live);
      await expect(
        live.announceAsync(
          { actorId: 'agent-a', requestId: `announce-${name}` },
          actorGrant(),
          1,
        ),
      ).resolves.toMatchObject(
        expected === 'refused'
          ? { outcome: 'degraded', state: 'refused' }
          : { outcome: 'degraded', state: 'indeterminate' },
      );
    }
  });

  test('keeps presence endings distinct from deliberate finished work and routes revisions through room links', async () => {
    const calls: Parameters<ProjectTaskRoomAuthority['append']>[0][] = [];
    const adapter = new ProjectTaskLiveWorkHistoryAdapter(
      room(async (input) => {
        calls.push(input);
        return { kind: 'committed', receipt: receipt(input.intent.proposalId) };
      }),
      issuer(),
    );
    const revisionId = `revision-evidence-v1:${'a'.repeat(64)}` as const;
    const live = session(adapter, {
      revisionAuthority: {
        resolveEvidence: () => ({
          state: 'AVAILABLE',
          revision: {
            revisionId,
            scope: {
              projectId: 'project',
              taskId: 'task',
              documentId: 'document',
            },
            correlation: {
              projectId: 'project',
              taskId: 'task',
              agentSessionId: 'session',
              runId: 'run-a',
            },
          },
        }),
      },
    });
    await joined(live);
    await live.announceAsync(
      { actorId: 'agent-a', requestId: 'announce' },
      actorGrant(),
      1,
    );
    await live.referenceRevisionAsync(
      {
        actorId: 'agent-a',
        requestId: 'revision',
        reference: { revisionId, verification: 'verified' },
      },
      actorGrant(),
      2,
    );
    await live.finishAsync(
      {
        actorId: 'agent-a',
        requestId: 'finish',
        outcome: 'completed',
        reference: { revisionId, verification: 'verified' },
      },
      actorGrant(),
      3,
    );
    await live.departAsync(
      { actorId: 'agent-a', requestId: 'depart' },
      actorGrant(),
      4,
    );
    expect(calls.map((call) => call.intent.body.kind)).toEqual([
      'live-work-started',
      'outcome-link',
      'live-work-finished',
      'live-work-presence-ended',
    ]);
    expect(calls[1]!.intent.body).toMatchObject({
      linkKind: 'revision',
      reference: revisionId,
    });
    expect(calls[2]!.intent.body).toMatchObject({
      outcome: 'completed',
      revisionReference: revisionId,
    });
    expect(calls[3]!.intent.body).toMatchObject({ reason: 'departed' });
  });

  test('retries a lost response after restart with the same proposal and receives duplicate without a second record', async () => {
    const records = new Map<string, ProjectTaskRoomAppendOutcome>();
    const attempts: string[] = [];
    let loseResponse = true;
    const authority = room(async (input) => {
      attempts.push(input.intent.proposalId);
      const existing = records.get(input.intent.proposalId);
      if (existing)
        return { kind: 'duplicate', receipt: receipt(input.intent.proposalId) };
      records.set(input.intent.proposalId, {
        kind: 'committed',
        receipt: receipt(input.intent.proposalId),
      });
      if (loseResponse) {
        loseResponse = false;
        throw new Error('lost response');
      }
      return records.get(input.intent.proposalId)!;
    });
    const first = session(
      new ProjectTaskLiveWorkHistoryAdapter(authority, issuer()),
    );
    await joined(first);
    const pending = await first.announceAsync(
      { actorId: 'agent-a', requestId: 'announce' },
      actorGrant(),
      1,
    );
    expect(pending).toMatchObject({
      outcome: 'degraded',
      state: 'indeterminate',
    });
    const exported = first.exportRecovery(recoveryGrant, 2);
    expect(exported.outcome).toBe('available');
    const state = exported.outcome === 'available' ? exported.state : undefined;
    const restored = LiveWorkSession.restore(
      scope,
      state,
      recoveryGrant,
      3,
      {},
      {
        history: new ProjectTaskLiveWorkHistoryAdapter(authority, issuer()),
        revision: new ProjectTaskLiveWorkHistoryAdapter(authority, issuer()),
      },
      dependencies,
    );
    expect(restored.outcome).toBe('available');
    const recovery =
      restored.outcome === 'available'
        ? await restored.session.recoverAsync(
            (pending as any).intentId,
            recoveryGrant,
            4,
          )
        : undefined;
    // Export reserves the required presence-ending closure, so settling the
    // duplicated announcement may correctly expose that separate pending fact.
    expect(recovery).toMatchObject({
      outcome: 'degraded',
      state: 'indeterminate',
    });
    expect(records).toHaveLength(1);
    expect(attempts).toEqual([
      (pending as any).intentId,
      (pending as any).intentId,
    ]);
  });

  test('close fences an in-flight authority completion and future writes', async () => {
    let settle: ((value: ProjectTaskRoomAppendOutcome) => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredAppend = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const adapter = new ProjectTaskLiveWorkHistoryAdapter(
      room(
        async () =>
          new Promise<ProjectTaskRoomAppendOutcome>((resolve) => {
            settle = resolve;
            entered!();
          }),
      ),
      issuer(),
    );
    const live = session(adapter);
    await joined(live);
    const inFlight = live.announceAsync(
      { actorId: 'agent-a', requestId: 'announce' },
      actorGrant(),
      1,
    );
    await enteredAppend;
    const closing = live.close();
    expect(live.close()).toBe(closing);
    settle!({ kind: 'committed', receipt: receipt('proposal') });
    await expect(closing).resolves.toEqual({ outcome: 'closed' });
    await expect(inFlight).resolves.toMatchObject({
      outcome: 'degraded',
      state: 'indeterminate',
    });
    expect(
      live.join({ actorId: 'agent-a', requestId: 'again' }, actorGrant(), 2),
    ).toEqual({ outcome: 'unavailable' });
  });
});
