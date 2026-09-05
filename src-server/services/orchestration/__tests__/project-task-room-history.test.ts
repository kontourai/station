import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelProposalDigestInput } from '@kontourai/station-contracts/channel-log';
import type {
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
} from '@kontourai/station-contracts/project-task-room';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
} from '../../../../scripts/lib/owned-process.mjs';
import { EventStore } from '../event-store.js';
import {
  createProjectTaskRoomHistoryForTest,
  PROJECT_TASK_ROOM_LIMITS,
  type ProjectTaskRoomCapabilityAuthority,
} from '../project-task-room-history.js';
import { createProjectTaskRoomWorkingState } from '../project-task-room-working-state.js';

const TEST_RETENTION = 16;
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson((value as Record<string, unknown>)[key])]),
    );
  return value;
}
const canonical = (value: unknown): string => JSON.stringify(sortJson(value));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      get(...args: unknown[]): unknown;
    };
    close(): void;
  };
};
const directories: string[] = [];
const scope = {
  projectId: '7188ca57-2ddc-4b70-9792-bb7f9a5f76a1',
  projectSlug: 'canonical-project',
  taskId: 'task-a',
};
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'station-room-v2-'));
  directories.push(directory);
  return join(directory, 'orchestration.sqlite');
}
function grant<K extends ProjectTaskRoomGrantKind>(
  capability: K,
  token = 'valid',
): ProjectTaskRoomGrant<K> {
  return Object.freeze({
    schemaVersion: 'station.project-task-room-grant/v1',
    capability,
    opaqueToken: token,
  }) as ProjectTaskRoomGrant<K>;
}
const capabilities: ProjectTaskRoomCapabilityAuthority = {
  async resolve({ grant: presented, required }) {
    if (presented.opaqueToken === 'missing') return { kind: 'not-found' };
    if (presented.opaqueToken !== 'valid' || presented.capability !== required)
      return { kind: 'denied' };
    return {
      kind: 'granted',
      receipt: {
        receiptId: `receipt-${required}`,
        capability: required,
        scope,
        principal: {
          kind: 'operator',
          operatorId: 'operator',
          deviceId: 'device',
        },
        policyRevision: 'policy-1',
      },
    };
  },
};
function history(
  path = databasePath(),
  options: Partial<
    Parameters<typeof createProjectTaskRoomHistoryForTest>[0]
  > = {},
) {
  return createProjectTaskRoomHistoryForTest({
    databasePath: path,
    capabilities,
    limits: {
      retentionRecords: TEST_RETENTION,
      retentionBytes: 1024 * 1024,
      maxIdentities: 4_096,
    },
    ...options,
  });
}
const message = (proposalId: string, text = proposalId) => ({
  grant: grant('message-write'),
  intent: {
    proposalId,
    occurredAt: '2026-08-16T00:00:00.000Z',
    correlationId: 'corr',
    body: { kind: 'human-message' as const, text },
  },
});
function rewriteCommittedRecord(
  path: string,
  proposalId: string,
  mutate: (record: any) => void,
) {
  const db = new DatabaseSync(path);
  const row = db
    .prepare(
      'SELECT channel_id,record_json FROM project_task_room_records WHERE proposal_id=?',
    )
    .get(proposalId) as { channel_id: string; record_json: string };
  const identity = db
    .prepare(
      'SELECT receipt_json FROM project_task_room_identities WHERE proposal_id=?',
    )
    .get(proposalId) as { receipt_json: string };
  const record = JSON.parse(row.record_json);
  mutate(record);
  record.envelope.proposalDigest = sha(
    channelProposalDigestInput(record.envelope.proposal),
  );
  const payload = record.envelope.proposal.body;
  const semantic = {
    schemaVersion: 'station.project-task-room-proposal-semantics/v1',
    scope: payload.scope,
    channelId: row.channel_id,
    epoch: record.envelope.epoch,
    proposalId,
    occurredAt: record.envelope.proposal.happenedAt,
    principal: payload.principal,
    ...(payload.correlationId ? { correlationId: payload.correlationId } : {}),
    ...(payload.causationId ? { causationId: payload.causationId } : {}),
    body: payload.body,
    grantReceipt: payload.grantReceipt,
  };
  const proposalDigest = sha(canonical(semantic));
  const envelopeDigest = sha(canonical(record.envelope));
  const genesis = sha(`room-genesis:${row.channel_id}`);
  const checkpointDigest = sha(`${genesis}\u0000${envelopeDigest}`);
  record.checkpointDigest = checkpointDigest;
  const recordJson = canonical(record);
  const receipt = JSON.parse(identity.receipt_json);
  receipt.proposalDigest = proposalDigest;
  receipt.envelopeDigest = envelopeDigest;
  receipt.checkpoint.checkpointDigest = checkpointDigest;
  const receiptJson = canonical(receipt);
  db.prepare(
    `UPDATE project_task_room_records
     SET proposal_digest=?,envelope_digest=?,checkpoint_digest=?,record_json=?,record_bytes=?
     WHERE proposal_id=?`,
  ).run(
    proposalDigest,
    envelopeDigest,
    checkpointDigest,
    recordJson,
    Buffer.byteLength(recordJson),
    proposalId,
  );
  db.prepare(
    `UPDATE project_task_room_heads
     SET head_envelope_digest=?,head_checkpoint_digest=?`,
  ).run(envelopeDigest, checkpointDigest);
  db.prepare(
    `UPDATE project_task_room_identities
     SET proposal_digest=?,envelope_digest=?,checkpoint_digest=?,receipt_json=?,receipt_bytes=?,receipt_digest=?
     WHERE proposal_id=?`,
  ).run(
    proposalDigest,
    envelopeDigest,
    checkpointDigest,
    receiptJson,
    Buffer.byteLength(receiptJson),
    sha(receiptJson),
    proposalId,
  );
  db.close();
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('ProjectTaskRoomHistory v2', () => {
  it('keeps the production async-history horizon distinct from test retention', () => {
    expect(PROJECT_TASK_ROOM_LIMITS.retentionRecords).toBe(10_000);
    expect(PROJECT_TASK_ROOM_LIMITS.retentionBytes).toBe(64 * 1024 * 1024);
    expect(PROJECT_TASK_ROOM_LIMITS.maxIdentities).toBeGreaterThan(
      PROJECT_TASK_ROOM_LIMITS.retentionRecords,
    );
  });

  it('applies the independent retained-byte horizon in the test adapter', async () => {
    const room = history(databasePath(), {
      limits: {
        retentionRecords: TEST_RETENTION,
        retentionBytes: 48 * 1024,
        maxIdentities: 4_096,
      },
    });
    await room.open({ grant: grant('discover') });
    for (let index = 0; index < 8; index += 1)
      await room.append(message(`bytes-${index}`, 'x'.repeat(8_000)));
    await expect(
      room.read({ grant: grant('history-read') }),
    ).resolves.toMatchObject({ kind: 'gap' });
    await room.close();
  });

  it('returns 100 tiny records without exhausting the schema-derived item budget', async () => {
    const room = history(databasePath(), {
      limits: {
        retentionRecords: 200,
        retentionBytes: 64 * 1024 * 1024,
        maxIdentities: 1_000,
      },
    });
    await room.open({ grant: grant('discover') });
    for (let index = 0; index < 100; index += 1)
      await room.append(message(`t${index}`, 'x'));
    const page = await room.read({ grant: grant('history-read'), limit: 100 });
    expect(page).toMatchObject({ kind: 'available', hasMore: false });
    if (page.kind === 'available') expect(page.records).toHaveLength(100);
    await room.close();
  });

  it('pages worst-case agent outcome links at the byte ceiling without item-budget failure', async () => {
    const large = 'x'.repeat(240);
    const authority: ProjectTaskRoomCapabilityAuthority = {
      async resolve({ required }) {
        return {
          kind: 'granted',
          receipt: {
            receiptId: `${required}-${large}`,
            capability: required,
            scope,
            principal: {
              kind: 'agent',
              agentId: `agent-${large}`,
              ownerOperatorId: `owner-${large}`,
              deviceId: `device-${large}`,
              authorizationReceiptId: `auth-${large}`,
            },
            policyRevision: `policy-${large}`,
          },
        };
      },
    };
    const room = history(databasePath(), {
      capabilities: authority,
      agents: {
        async revalidate(receipt) {
          return {
            kind: 'authorized',
            principal: receipt.principal as Extract<
              typeof receipt.principal,
              { kind: 'agent' }
            >,
          };
        },
      },
      links: {
        async resolve({ kind }) {
          return {
            kind: 'resolved',
            link: {
              schemaVersion: 'station.project-task-room-resolved-link/v1',
              kind,
              stableId: `stable-${large}`,
              digest: `digest-${large}`,
              authorityReceiptId: `receipt-${large}`,
            },
          };
        },
      },
      limits: {
        retentionRecords: 200,
        retentionBytes: 64 * 1024 * 1024,
        maxIdentities: 1_000,
      },
    });
    await room.open({ grant: grant('discover') });
    for (let index = 0; index < 100; index += 1)
      await room.append({
        grant: grant('agent-publish'),
        intent: {
          proposalId: `worst-${index}`,
          occurredAt: '2026-08-16T00:00:00.000Z',
          correlationId: `corr-${large}`,
          causationId: `cause-${large}`,
          body: {
            kind: 'outcome-link',
            linkKind: 'receipt',
            reference: `ref-${large}`,
          },
        },
      });
    const first = await room.read({ grant: grant('history-read'), limit: 100 });
    expect(first).toMatchObject({ kind: 'available', hasMore: true });
    if (first.kind !== 'available' || !first.nextCursor)
      throw new Error('expected byte-bounded continuation');
    expect(first.records.length).toBeGreaterThan(0);
    expect(first.records.length).toBeLessThan(100);
    await expect(
      room.read({ grant: grant('history-read'), cursor: first.nextCursor }),
    ).resolves.toMatchObject({ kind: 'available' });
    await room.close();
  });
  it('implements revalidated, exact-capability grants and hides missing/foreign authority', async () => {
    const room = history();
    await expect(
      room.open({ grant: grant('discover') }),
    ).resolves.toMatchObject({ kind: 'opened', scope, assurance: 'L0' });
    await expect(
      room.open({ grant: grant('discover', 'missing') }),
    ).resolves.toEqual({ kind: 'not-found' });
    await expect(
      room.append({
        grant: grant('lifecycle-append') as any,
        intent: message('wrong').intent,
      }),
    ).resolves.toEqual({ kind: 'denied' });
    const forged = Object.freeze({
      schemaVersion: 'station.project-task-room-grant/v1',
      capability: 'message-write',
      opaqueToken: 'forged',
    }) as ProjectTaskRoomGrant<'message-write'>;
    await expect(
      room.append({ grant: forged, intent: message('forged').intent }),
    ).resolves.toEqual({ kind: 'denied' });
    await room.close();
  });

  it('returns a byte-stable receipt for an exact duplicate and conflicts on any semantic change', async () => {
    const path = databasePath();
    const room = history(path);
    await room.open({ grant: grant('discover') });
    const first = await room.append(message('same', 'hello'));
    const duplicate = await room.append(message('same', 'hello'));
    expect(first.kind).toBe('committed');
    expect(duplicate.kind).toBe('duplicate');
    if (first.kind === 'committed' && duplicate.kind === 'duplicate')
      expect(duplicate.receipt).toEqual(first.receipt);
    await expect(room.append(message('same', 'changed'))).resolves.toEqual({
      kind: 'rejected',
      reason: 'idempotency-conflict',
    });
    await room.close();
    const restarted = history(path);
    const afterRestart = await restarted.append(message('same', 'hello'));
    expect(afterRestart.kind).toBe('duplicate');
    if (duplicate.kind === 'duplicate' && afterRestart.kind === 'duplicate')
      expect(afterRestart.receipt).toEqual(duplicate.receipt);
    await restarted.close();
  });

  it('returns committed after an injected post-commit fault by exact identity readback', async () => {
    const room = history(databasePath(), { faultAfterCommitOnce: true });
    await room.open({ grant: grant('discover') });
    await expect(room.append(message('postcommit'))).resolves.toMatchObject({
      kind: 'committed',
      receipt: { proposalId: 'postcommit' },
    });
    await room.close();
  });

  it('keeps a first-page snapshot valid across an unrelated later append', async () => {
    const room = history();
    await room.open({ grant: grant('discover') });
    await room.append(message('one'));
    await room.append(message('two'));
    const first = await room.read({ grant: grant('history-read'), limit: 1 });
    expect(first.kind).toBe('available');
    await room.append(message('later'));
    if (first.kind === 'available' && first.nextCursor) {
      const next = await room.read({
        grant: grant('history-read'),
        cursor: first.nextCursor,
        limit: 1,
      });
      expect(next).toMatchObject({ kind: 'available', hasMore: false });
      if (next.kind === 'available')
        expect(next.records[0]?.envelope.proposal.proposalId).toBe('two');
    }
    await room.close();
  });

  it('reports a real retention gap and preserves pruned identity receipts after restart', async () => {
    const path = databasePath();
    const room = history(path);
    await room.open({ grant: grant('discover') });
    let first: Awaited<ReturnType<typeof room.append>> | undefined;
    let latest: Awaited<ReturnType<typeof room.append>> | undefined;
    for (let index = 0; index <= TEST_RETENTION; index += 1) {
      const value = await room.append(message(`p-${index}`));
      if (index === 0) first = value;
      latest = value;
    }
    const gap = await room.read({
      grant: grant('history-read'),
      cursor: {
        schemaVersion: 'station.project-task-room-cursor/v1',
        channelId:
          latest!.kind === 'committed'
            ? latest!.receipt.coordinate.channelId
            : '',
        epoch: 0,
        throughSeq: TEST_RETENTION + 1,
        checkpointDigest:
          latest!.kind === 'committed'
            ? latest!.receipt.checkpoint.checkpointDigest
            : '',
        retainedAnchorSeq:
          latest!.kind === 'committed'
            ? latest!.receipt.checkpoint.retainedAnchorSeq
            : 0,
        retainedAnchorDigest:
          latest!.kind === 'committed'
            ? latest!.receipt.checkpoint.retainedAnchorDigest
            : '',
        afterSeq: 0,
        afterEnvelopeDigest: null,
        afterCheckpointDigest:
          first!.kind === 'committed'
            ? first!.receipt.checkpoint.retainedAnchorDigest
            : '',
      },
    });
    expect(gap).toMatchObject({ kind: 'gap', missingThroughSeq: 1 });
    await expect(
      room.read({ grant: grant('history-read') }),
    ).resolves.toMatchObject({ kind: 'gap', missingThroughSeq: 1 });
    if (gap.kind === 'gap')
      await expect(
        room.read({
          grant: grant('history-read'),
          cursor: gap.resumeCursor,
        }),
      ).resolves.toMatchObject({ kind: 'available' });
    await room.close();
    const reopened = history(path);
    const duplicate = await reopened.append(message('p-0'));
    expect(duplicate.kind).toBe('duplicate');
    if (first?.kind === 'committed' && duplicate.kind === 'duplicate')
      expect(duplicate.receipt).toEqual(first.receipt);
    await reopened.close();
  });

  it('keeps consumed-pruned cursors valid but gaps required-pruned rows and late joins', async () => {
    const room = history();
    await room.open({ grant: grant('discover') });
    for (let index = 0; index < TEST_RETENTION; index += 1)
      await room.append(message(`snapshot-${index}`));
    const consumed = await room.read({
      grant: grant('history-read'),
      limit: TEST_RETENTION - 1,
    });
    const required = await room.read({
      grant: grant('history-read'),
      limit: 1,
    });
    expect(consumed.kind).toBe('available');
    expect(required.kind).toBe('available');
    await room.append(message('moves-floor-1'));
    await room.append(message('moves-floor-2'));
    if (consumed.kind === 'available' && consumed.nextCursor)
      await expect(
        room.read({
          grant: grant('history-read'),
          cursor: consumed.nextCursor,
        }),
      ).resolves.toMatchObject({ kind: 'available', hasMore: false });
    if (required.kind === 'available' && required.nextCursor) {
      const requiredGap = await room.read({
        grant: grant('history-read'),
        cursor: required.nextCursor,
      });
      expect(requiredGap).toMatchObject({
        kind: 'gap',
        missingThroughSeq: 2,
      });
      if (requiredGap.kind === 'gap')
        await expect(
          room.read({
            grant: grant('history-read'),
            cursor: requiredGap.resumeCursor,
          }),
        ).resolves.toMatchObject({ kind: 'available' });
    }
    await expect(
      room.read({ grant: grant('history-read') }),
    ).resolves.toMatchObject({ kind: 'gap', missingThroughSeq: 2 });
    await room.close();
  });

  it('clamps a resume cursor when concurrent pruning overtakes its snapshot', async () => {
    const room = history(databasePath(), {
      limits: {
        retentionRecords: 2,
        retentionBytes: 1024 * 1024,
        maxIdentities: 100,
      },
    });
    await room.open({ grant: grant('discover') });
    await room.append(message('one'));
    await room.append(message('two'));
    await room.append(message('three'));
    const initialGap = await room.read({ grant: grant('history-read') });
    expect(initialGap).toMatchObject({
      kind: 'gap',
      missingThroughSeq: 1,
      checkpoint: { throughSeq: 3, retainedAnchorSeq: 1 },
    });
    if (initialGap.kind !== 'gap') throw new Error('expected initial gap');
    const oldResume = initialGap.resumeCursor;
    for (const id of ['four', 'five', 'six', 'seven'])
      await room.append(message(id));
    const overtaken = await room.read({
      grant: grant('history-read'),
      cursor: oldResume,
    });
    expect(overtaken).toMatchObject({
      kind: 'gap',
      missingThroughSeq: 3,
      checkpoint: { throughSeq: 3, retainedAnchorSeq: 3 },
      resumeCursor: {
        throughSeq: 3,
        retainedAnchorSeq: 3,
        afterSeq: 3,
      },
    });
    if (overtaken.kind !== 'gap') throw new Error('expected overtaken gap');
    expect(overtaken.resumeCursor.retainedAnchorSeq).toBeLessThanOrEqual(
      overtaken.resumeCursor.throughSeq,
    );
    await expect(
      room.read({
        grant: grant('history-read'),
        cursor: overtaken.resumeCursor,
      }),
    ).resolves.toMatchObject({
      kind: 'available',
      records: [],
      checkpoint: { throughSeq: 3, retainedAnchorSeq: 3 },
      hasMore: false,
    });
    await room.close();
  });

  it('treats identity-only and middle-record corruption as unavailable', async () => {
    for (const corruption of ['identity', 'middle'] as const) {
      const path = databasePath();
      const room = history(path);
      await room.open({ grant: grant('discover') });
      await room.append(message('a'));
      await room.append(message('b'));
      await room.append(message('c'));
      const db = new DatabaseSync(path);
      if (corruption === 'identity')
        db.prepare(
          'UPDATE project_task_room_identities SET proposal_digest=? WHERE proposal_id=?',
        ).run('bad', 'b');
      else
        db.prepare(
          'DELETE FROM project_task_room_records WHERE proposal_id=?',
        ).run('b');
      db.close();
      await expect(
        room.read({ grant: grant('history-read') }),
      ).resolves.toEqual({ kind: 'unavailable' });
      room.dispose();
    }
  });

  it('fails closed for JSON, digest, byte, head, sequence, and policy corruption', async () => {
    const mutations = [
      "UPDATE project_task_room_records SET record_json='{' WHERE proposal_id='b'",
      "UPDATE project_task_room_records SET record_bytes=record_bytes+1 WHERE proposal_id='b'",
      "UPDATE project_task_room_records SET envelope_digest='bad' WHERE proposal_id='b'",
      "UPDATE project_task_room_identities SET receipt_digest='bad' WHERE proposal_id='b'",
      "UPDATE project_task_room_identities SET receipt_bytes=receipt_bytes+1 WHERE proposal_id='b'",
      "UPDATE project_task_room_records SET record_json=json_set(record_json,'$.correlationId','evil') WHERE proposal_id='b'",
      'UPDATE project_task_room_heads SET head_seq=head_seq+1',
      "UPDATE project_task_room_records SET seq=9 WHERE proposal_id='b'",
      "UPDATE project_task_room_heads SET policy_revision='tampered'",
    ];
    for (const mutation of mutations) {
      const path = databasePath();
      const room = history(path);
      await room.open({ grant: grant('discover') });
      await room.append(message('a'));
      await room.append(message('b'));
      const db = new DatabaseSync(path);
      db.exec(mutation);
      db.close();
      await expect(
        room.read({ grant: grant('history-read') }),
      ).resolves.toEqual({ kind: 'unavailable' });
      room.dispose();
    }
  });

  it('validates exact genesis head and anchor checkpoints before empty replay', async () => {
    const path = databasePath();
    const room = history(path);
    await room.open({ grant: grant('discover') });
    const db = new DatabaseSync(path);
    db.exec(
      "UPDATE project_task_room_heads SET head_checkpoint_digest='bad', retained_anchor_checkpoint_digest='bad'",
    );
    db.close();
    await expect(room.read({ grant: grant('history-read') })).resolves.toEqual({
      kind: 'unavailable',
    });
    room.dispose();
  });

  it('rejects a forged embedded author even when every storage digest is recomputed', async () => {
    const path = databasePath();
    const room = history(path);
    await room.open({ grant: grant('discover') });
    await room.append(message('author-forgery'));
    rewriteCommittedRecord(path, 'author-forgery', (record) => {
      record.envelope.proposal.author.memberId = 'attacker';
    });
    await expect(room.read({ grant: grant('history-read') })).resolves.toEqual({
      kind: 'unavailable',
    });
    room.dispose();
  });

  it('rejects a capability-forged grant receipt after all digests are recomputed', async () => {
    const path = databasePath();
    const room = history(path);
    await room.open({ grant: grant('discover') });
    await room.append(message('capability-forgery'));
    rewriteCommittedRecord(path, 'capability-forgery', (record) => {
      record.envelope.proposal.body.grantReceipt.capability =
        'lifecycle-append';
    });
    await expect(room.read({ grant: grant('history-read') })).resolves.toEqual({
      kind: 'unavailable',
    });
    room.dispose();
  });

  it('rejects proxies, cycles, inherited fields, and oversized identifiers before adapters', async () => {
    const authority = {
      resolve: vi.fn(capabilities.resolve.bind(capabilities)),
    };
    const room = history(databasePath(), { capabilities: authority });
    const cycle: any = { kind: 'human-message', text: 'x' };
    cycle.self = cycle;
    for (const intent of [
      Object.create({ proposalId: 'inherited' }),
      {
        proposalId: 'x'.repeat(300),
        occurredAt: 'now',
        body: { kind: 'human-message', text: 'x' },
      },
      { proposalId: 'cycle', occurredAt: 'now', body: cycle },
      new Proxy(
        {
          proposalId: 'proxy',
          occurredAt: 'now',
          body: { kind: 'human-message', text: 'x' },
        },
        {
          ownKeys() {
            throw new Error('trap');
          },
        },
      ),
    ])
      await expect(
        room.append({ grant: grant('message-write'), intent: intent as any }),
      ).resolves.toEqual({ kind: 'rejected', reason: 'malformed' });
    expect(authority.resolve).not.toHaveBeenCalled();
    await room.close();
  });

  it('freezes intent and cursor before authority awaits can observe caller mutation', async () => {
    let release!: () => void;
    let entered!: () => void;
    let gate = Promise.resolve();
    let blockNext = false;
    const authority: ProjectTaskRoomCapabilityAuthority = {
      async resolve(input) {
        if (blockNext) {
          blockNext = false;
          entered();
          await gate;
        }
        return capabilities.resolve(input);
      },
    };
    const room = history(databasePath(), { capabilities: authority });
    await room.open({ grant: grant('discover') });
    let proxyReads = 0;
    const mutableIntent = {
      proposalId: 'frozen-intent',
      occurredAt: '2026-08-16T00:00:00.000Z',
      body: { kind: 'human-message' as const, text: 'original' },
    };
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorityEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    blockNext = true;
    const append = room.append({
      grant: grant('message-write'),
      intent: mutableIntent,
    });
    await authorityEntered;
    mutableIntent.body = new Proxy(
      { kind: 'human-message' as const, text: 'mutated' },
      {
        get(target, key, receiver) {
          proxyReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    release();
    await expect(append).resolves.toMatchObject({ kind: 'committed' });
    expect(proxyReads).toBe(0);

    await room.append(message('cursor-second'));
    const first = await room.read({ grant: grant('history-read'), limit: 1 });
    expect(first.kind).toBe('available');
    if (first.kind !== 'available' || !first.nextCursor)
      throw new Error('expected continuation cursor');
    const mutableCursor = structuredClone(first.nextCursor);
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readAuthorityEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    blockNext = true;
    const continuation = room.read({
      grant: grant('history-read'),
      cursor: mutableCursor,
    });
    await readAuthorityEntered;
    mutableCursor.afterSeq = 9_999;
    mutableCursor.checkpointDigest = 'mutated';
    release();
    await expect(continuation).resolves.toMatchObject({
      kind: 'available',
      records: [{ body: { kind: 'human-message', text: 'cursor-second' } }],
    });
    await room.close();
  });

  it('totalizes throwing and malformed capability/link authorities', async () => {
    const throwing = history(databasePath(), {
      capabilities: {
        async resolve() {
          throw new Error('no');
        },
      },
    });
    await expect(throwing.open({ grant: grant('discover') })).resolves.toEqual({
      kind: 'unavailable',
    });
    await throwing.close();
    const malformed = history(databasePath(), {
      capabilities: {
        async resolve() {
          return { kind: 'granted' } as any;
        },
      },
    });
    await expect(malformed.open({ grant: grant('discover') })).resolves.toEqual(
      { kind: 'unavailable' },
    );
    await malformed.close();
    const links = history(databasePath(), {
      links: {
        async resolve() {
          throw new Error('link backend unavailable');
        },
      },
    });
    await links.open({ grant: grant('discover') });
    await expect(
      links.append({
        grant: grant('revision-link'),
        intent: {
          proposalId: 'link',
          occurredAt: '2026-08-16T00:00:00.000Z',
          body: {
            kind: 'outcome-link',
            linkKind: 'revision',
            reference: 'revision-ref',
          },
        },
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
    await links.close();
  });

  it('persists only authority-resolved links and revalidates committed agent attribution', async () => {
    let agentChecks = 0;
    let revokeAt = Number.POSITIVE_INFINITY;
    const agentCapabilities: ProjectTaskRoomCapabilityAuthority = {
      async resolve({ grant: presented, required }) {
        if (presented.capability !== required) return { kind: 'denied' };
        return {
          kind: 'granted',
          receipt: {
            receiptId: 'agent-grant-receipt',
            capability: required,
            scope,
            principal: {
              kind: 'agent',
              agentId: 'codex',
              ownerOperatorId: 'operator',
              deviceId: 'device',
              authorizationReceiptId: 'committed-agent-authorization',
            },
            policyRevision: 'policy-1',
          },
        };
      },
    };
    const room = history(databasePath(), {
      capabilities: agentCapabilities,
      agents: {
        async revalidate(receipt) {
          agentChecks += 1;
          if (agentChecks >= revokeAt) return { kind: 'revoked' };
          return {
            kind: 'authorized',
            principal: receipt.principal as Extract<
              typeof receipt.principal,
              { kind: 'agent' }
            >,
          };
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
              authorityReceiptId: 'link-authority-receipt',
            },
          };
        },
      },
    });
    await expect(
      room.open({ grant: grant('discover') }),
    ).resolves.toMatchObject({ kind: 'opened' });
    await expect(
      room.append({
        grant: grant('agent-publish'),
        intent: {
          proposalId: 'agent-lifecycle',
          occurredAt: '2026-08-16T00:00:00.000Z',
          body: {
            kind: 'live-work-started',
            sessionId: 'session-a',
            runReference: 'caller-reference',
          },
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      room.append({
        grant: grant('agent-publish'),
        intent: {
          proposalId: 'agent-presence-ended',
          occurredAt: '2026-08-16T00:00:00.500Z',
          body: {
            kind: 'live-work-presence-ended',
            sessionId: 'session-a',
            reason: 'expired',
            runReference: 'caller-reference',
          },
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      room.append({
        grant: grant('agent-publish'),
        intent: {
          proposalId: 'agent-work-finished',
          occurredAt: '2026-08-16T00:00:00.750Z',
          body: {
            kind: 'live-work-finished',
            sessionId: 'session-a',
            outcome: 'completed',
            runReference: 'caller-reference',
            revisionReference: 'caller-revision-reference',
            outcomeReference: 'caller-receipt-reference',
          },
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    await expect(
      room.append({
        grant: grant('agent-publish'),
        intent: {
          proposalId: 'agent-receipt-link',
          occurredAt: '2026-08-16T00:00:01.000Z',
          body: {
            kind: 'outcome-link',
            linkKind: 'receipt',
            reference: 'caller-receipt-reference',
          },
        },
      }),
    ).resolves.toMatchObject({ kind: 'committed' });
    const replay = await room.read({ grant: grant('history-read') });
    expect(replay).toMatchObject({
      kind: 'available',
      records: [
        {
          principal: { kind: 'agent', agentId: 'codex' },
          body: {
            kind: 'live-work-started',
            run: {
              stableId: 'resolved-run',
              authorityReceiptId: 'link-authority-receipt',
            },
          },
        },
        {
          body: {
            kind: 'live-work-presence-ended',
            reason: 'expired',
            run: { stableId: 'resolved-run' },
          },
        },
        {
          body: {
            kind: 'live-work-finished',
            outcome: 'completed',
            revision: { kind: 'revision', stableId: 'resolved-revision' },
            outcomeLink: { kind: 'receipt', stableId: 'resolved-receipt' },
          },
        },
        {
          body: {
            kind: 'outcome-link',
            link: {
              kind: 'receipt',
              stableId: 'resolved-receipt',
              authorityReceiptId: 'link-authority-receipt',
            },
          },
        },
      ],
    });
    expect(agentChecks).toBeGreaterThanOrEqual(10);
    revokeAt = agentChecks + 2;
    await expect(room.read({ grant: grant('history-read') })).resolves.toEqual({
      kind: 'denied',
    });
    await room.close();
  });

  it('turns malformed storage outcomes into unavailable', async () => {
    const room = history(databasePath(), {
      storage: {
        async request(value) {
          const request = value as { type?: string };
          if (request.type === 'append')
            return {
              kind: 'committed',
              receipt: { proposalDigest: 'forged' },
            };
          if (request.type === 'read')
            return {
              kind: 'available',
              records: [{}],
              checkpoint: {},
              hasMore: false,
              integrity: 'L0',
            };
          return { kind: 'opened', injected: true };
        },
        async close() {
          return { kind: 'closed' } as const;
        },
      },
    });
    await expect(room.open({ grant: grant('discover') })).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(room.append(message('malformed-worker'))).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(room.read({ grant: grant('history-read') })).resolves.toEqual({
      kind: 'unavailable',
    });
    await room.close();
  });

  it('rejects a well-shaped empty page that masks expected snapshot records', async () => {
    const room = history(databasePath(), {
      storage: {
        async request(value) {
          const request = value as { type?: string; channelId?: string };
          if (request.type !== 'read') return { kind: 'unavailable' };
          return {
            kind: 'available',
            records: [],
            checkpoint: {
              channelId: request.channelId,
              epoch: 0,
              throughSeq: 1,
              checkpointDigest: 'snapshot-digest',
              retainedAnchorSeq: 0,
              retainedAnchorDigest: 'genesis-digest',
            },
            hasMore: false,
            integrity: 'L0',
          };
        },
        async close() {
          return { kind: 'closed' } as const;
        },
      },
    });
    await expect(room.read({ grant: grant('history-read') })).resolves.toEqual({
      kind: 'unavailable',
    });
    await room.close();
  });

  it('makes startup failure, worker crash, and malformed output terminal or unavailable without latency', async () => {
    const sources = [
      new URL(`file://${join(tmpdir(), 'missing-station-room-worker.mjs')}`),
      new URL('data:text/javascript,process.exit(1)'),
      new URL(
        `data:text/javascript,${encodeURIComponent("import { parentPort } from 'node:worker_threads'; parentPort.on('message', ({id}) => parentPort.postMessage({id,result:{}}));")}`,
      ),
    ];
    for (const workerSourceUrl of sources) {
      const room = history(databasePath(), { workerSourceUrl });
      await expect(room.open({ grant: grant('discover') })).resolves.toEqual({
        kind: 'unavailable',
      });
      const started = performance.now();
      await expect(room.open({ grant: grant('discover') })).resolves.toEqual({
        kind: 'unavailable',
      });
      expect(performance.now() - started).toBeLessThan(100);
      await expect(room.close()).resolves.toMatchObject({
        kind: 'unavailable',
      });
    }
  });

  it('keeps the server event loop responsive while an external writer holds SQLite', async () => {
    const path = databasePath();
    const room = history(path);
    await room.open({ grant: grant('discover') });
    const blocker = new DatabaseSync(path, { timeout: 100 });
    blocker.exec('BEGIN IMMEDIATE');
    let timer = false;
    const operation = room.append(message('blocked'));
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        timer = true;
        resolve();
      }, 0),
    );
    expect(timer).toBe(true);
    await expect(operation).resolves.toEqual({ kind: 'unavailable' });
    blocker.exec('ROLLBACK');
    blocker.close();
    await room.close();
  });

  it('revalidates after SQLite contention and commits nothing after midflight revocation', async () => {
    let revoked = false;
    const authority: ProjectTaskRoomCapabilityAuthority = {
      async resolve({ required }) {
        if (revoked) return { kind: 'revoked' };
        return {
          kind: 'granted',
          receipt: {
            receiptId: `stable-${required}`,
            capability: required,
            scope,
            principal: {
              kind: 'operator',
              operatorId: 'operator',
              deviceId: 'device',
            },
            policyRevision: 'policy-1',
          },
        };
      },
    };
    const path = databasePath();
    const room = history(path, { capabilities: authority });
    await room.open({ grant: grant('discover') });
    const blocker = new DatabaseSync(path, { timeout: 100 });
    blocker.exec('BEGIN IMMEDIATE');
    const operation = room.append(message('revoked-during-lock'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    revoked = true;
    blocker.exec('ROLLBACK');
    blocker.close();
    await expect(operation).resolves.toEqual({ kind: 'denied' });
    revoked = false;
    await expect(
      room.read({ grant: grant('history-read') }),
    ).resolves.toMatchObject({ kind: 'available', records: [] });
    await room.close();
  });

  it('keeps EventStore synchronous shutdown nonblocking and exposes async worker settlement', async () => {
    const path = databasePath();
    const store = new EventStore(path);
    const room = store.createProjectTaskRoomHistory({ capabilities });
    await room.open({ grant: grant('discover') });
    const blocker = new DatabaseSync(path, { timeout: 100 });
    blocker.exec('BEGIN IMMEDIATE');
    const append = room.append(message('shutdown-race'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const started = performance.now();
    store.close();
    expect(performance.now() - started).toBeLessThan(100);
    let timerFired = false;
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0),
    );
    expect(timerFired).toBe(true);
    blocker.exec('ROLLBACK');
    blocker.close();
    await expect(append).resolves.toEqual({ kind: 'unavailable' });
    await expect(room.close()).resolves.toEqual({ kind: 'closed' });
  });

  it('fences an in-flight read before disclosure once close starts', async () => {
    let blockDelivery = false;
    let historyChecks = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deliveryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const authority: ProjectTaskRoomCapabilityAuthority = {
      async resolve(input) {
        if (input.required === 'history-read') {
          historyChecks += 1;
          if (blockDelivery && historyChecks === 2) {
            entered();
            await gate;
          }
        }
        return capabilities.resolve(input);
      },
    };
    const room = history(databasePath(), { capabilities: authority });
    await room.open({ grant: grant('discover') });
    await room.append(message('secret-before-close'));
    blockDelivery = true;
    const read = room.read({ grant: grant('history-read') });
    await deliveryEntered;
    const close = room.close();
    release();
    await expect(read).resolves.toEqual({ kind: 'unavailable' });
    await expect(close).resolves.toEqual({ kind: 'closed' });
  });

  it('totalizes rejecting and malformed close without fire-and-forget rejection', async () => {
    for (const closeBehavior of ['reject', 'malformed'] as const) {
      const room = history(databasePath(), {
        storage: {
          async request() {
            return { kind: 'unavailable' };
          },
          async close() {
            if (closeBehavior === 'reject') throw new Error('close failed');
            return { kind: 'not-a-close-outcome' } as never;
          },
        },
      });
      let unhandled = 0;
      const listener = () => {
        unhandled += 1;
      };
      process.on('unhandledRejection', listener);
      try {
        room.dispose();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await expect(room.close()).resolves.toEqual({ kind: 'unavailable' });
        expect(unhandled).toBe(0);
      } finally {
        process.off('unhandledRejection', listener);
      }
    }
  });

  it('uses EventStore composition for cross-process duplicate and equivocation', async () => {
    const path = databasePath();
    const initial = history(path);
    await initial.open({ grant: grant('discover') });
    await initial.close();
    const eventStorePath = new URL('../event-store.ts', import.meta.url)
      .pathname;
    const source = `import { EventStore } from ${JSON.stringify(eventStorePath)};
      const scope={projectId:'7188ca57-2ddc-4b70-9792-bb7f9a5f76a1',projectSlug:'canonical-project',taskId:'task-a'};
      const capability=Object.freeze({schemaVersion:'station.project-task-room-grant/v1',capability:'message-write',opaqueToken:'valid'});
      const store=new EventStore(process.argv[1]);
      const room=store.createProjectTaskRoomHistory({capabilities:{async resolve({required}){return {kind:'granted',receipt:{receiptId:'child-receipt',capability:required,scope,principal:{kind:'operator',operatorId:'operator',deviceId:'child'},policyRevision:'policy-1'}}}}});
      process.stdout.write('ready\\n');await new Promise((resolve)=>process.stdin.once('data',resolve));
      const result=await room.append({grant:capability,intent:{proposalId:'shared-proposal',occurredAt:'2026-08-16T00:00:00.000Z',body:{kind:'human-message',text:process.argv[2]}}});
      const closed=await room.close();store.close();process.stdout.write(JSON.stringify({result,closed}),()=>process.exit(0));`;
    const run = (text: string) => {
      const execution = executeOwnedProcess(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', source, path, text],
        undefined,
        `project task room ${text}`,
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let readyOutput = '';
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          void execution.terminate();
          reject(new Error(`owned room child did not become ready: ${text}`));
        }, 10_000);
        const onData = (chunk: Buffer) => {
          readyOutput += chunk.toString('utf8');
          if (readyOutput.includes('ready\n')) {
            execution.child.stdout?.off('data', onData);
            clearTimeout(timeout);
            resolve();
          }
        };
        execution.child.stdout?.on('data', onData);
      });
      return {
        execution,
        capture: captureOwnedProcessOutput(execution),
        ready,
        release: () => execution.child.stdin?.write('go'),
      };
    };
    const firstExecution = run('same-content');
    await firstExecution.ready;
    const secondExecution = run('same-content');
    await secondExecution.ready;
    const executions = [firstExecution, secondExecution];
    for (const execution of executions) execution.release();
    const completions = await Promise.all(
      executions.map(async ({ execution }) => {
        const timeout = setTimeout(() => void execution.terminate(), 10_000);
        try {
          return await execution.promise;
        } finally {
          clearTimeout(timeout);
          if (execution.isAlive()) await execution.forceTerminate();
        }
      }),
    );
    const outputs = executions.map(({ capture }) => capture.finish());
    for (const [index, completion] of completions.entries())
      expect(completion, outputs[index]?.stderr.text).toMatchObject({
        status: 0,
        signal: null,
      });
    for (const output of outputs) {
      expect(output.truncated).toBe(false);
      expect(output.invalidUtf8).toBe(false);
      expect(
        JSON.parse(output.stdout.text.trim().split('\n').at(-1)!),
      ).toMatchObject({
        closed: { kind: 'closed' },
      });
      expect(output.stderr.text).toBe('');
    }
    expect(
      outputs
        .map(
          (output) =>
            JSON.parse(output.stdout.text.trim().split('\n').at(-1)!).result
              .kind,
        )
        .sort(),
    ).toEqual(['committed', 'duplicate']);
    for (const { execution } of executions)
      expect(execution.isAlive()).toBe(false);
    const equivocation = run('different-content');
    await equivocation.ready;
    equivocation.release();
    const equivocationTimeout = setTimeout(
      () => void equivocation.execution.terminate(),
      10_000,
    );
    let equivocationResult:
      | { status: number | null; signal: string | null; error?: unknown }
      | undefined;
    try {
      equivocationResult = await equivocation.execution.promise;
    } finally {
      clearTimeout(equivocationTimeout);
      if (equivocation.execution.isAlive())
        await equivocation.execution.forceTerminate();
    }
    const equivocationOutput = equivocation.capture.finish();
    expect(equivocationResult).toMatchObject({ status: 0, signal: null });
    expect(
      JSON.parse(equivocationOutput.stdout.text.trim().split('\n').at(-1)!)
        .result,
    ).toEqual({
      kind: 'rejected',
      reason: 'idempotency-conflict',
    });
    expect(equivocation.execution.isAlive()).toBe(false);
    const reopened = history(path);
    const replay = await reopened.read({ grant: grant('history-read') });
    expect(replay.kind).toBe('available');
    if (replay.kind === 'available')
      expect(replay.records.map((record) => record.envelope.seq)).toEqual([1]);
    await reopened.close();
  }, 45_000);

  it('composes from the current EventStore without changing populated old tables', async () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE old_state(value TEXT); INSERT INTO old_state VALUES ('preserved')",
    );
    db.close();
    const store = new EventStore(path);
    const room = store.createProjectTaskRoomHistory({ capabilities });
    await expect(
      room.open({ grant: grant('discover') }),
    ).resolves.toMatchObject({ kind: 'opened' });
    store.close();
    const restartedStore = new EventStore(path);
    const restartedRoom = restartedStore.createProjectTaskRoomHistory({
      capabilities,
    });
    await expect(
      restartedRoom.open({ grant: grant('discover') }),
    ).resolves.toMatchObject({ kind: 'existing' });
    const check = new DatabaseSync(path);
    expect(check.prepare('SELECT value FROM old_state').get()).toEqual({
      value: 'preserved',
    });
    check.close();
    restartedStore.close();
  });
});

const sealIntent = {
  operationId: 'transfer-fixture',
  sourceHomeRef: 'source-home',
  targetHomeRef: 'target-home',
};

it('source seal fences already-running history and document workers and survives restart', async () => {
  const path = databasePath();
  const source = history(path);
  const peer = history(path);
  const working = createProjectTaskRoomWorkingState(path);
  const documentScope = {
    projectId: scope.projectId,
    taskId: scope.taskId,
    documentId: 'document',
  };
  const edit = (id: string) => ({
    scope: documentScope,
    intentId: id,
    intentDigest: sha(id),
    actorId: 'operator',
    epoch: 1,
    suppressRevisionPublicationForDiagnostic: true as const,
    operations: [
      {
        schemaVersion: 1 as const,
        operationId: id,
        documentId: 'document',
        replicaId: id,
        actor: { actorId: 'operator', kind: 'human' as const },
        parents: [],
        authorizationEpoch: 1,
        kind: 'insert' as const,
        after: null,
        text: id,
      },
    ],
  });
  try {
    await source.open({ grant: grant('discover') });
    await peer.open({ grant: grant('discover') });
    expect((await source.append(message('before-seal'))).kind).toBe(
      'committed',
    );
    expect((await working.settle(edit('first-edit'))).kind).toBe('committed');
    const before = await working.read({ scope: documentScope });
    const sealed = await source.sealSource({
      grant: grant('home-transfer'),
      ...sealIntent,
    });
    expect(sealed).toMatchObject({
      kind: 'sealed',
      seal: { ...sealIntent, checkpoint: { throughSeq: 1 } },
    });
    expect(await peer.append(message('after-seal'))).toEqual({
      kind: 'denied',
    });
    expect(await working.settle(edit('second-edit'))).toMatchObject({
      kind: 'unavailable',
    });
    expect(await working.read({ scope: documentScope })).toEqual(before);
    expect(
      await peer.sealSource({ grant: grant('home-transfer'), ...sealIntent }),
    ).toEqual(sealed);
    expect(
      await peer.sealSource({
        grant: grant('home-transfer'),
        ...sealIntent,
        targetHomeRef: 'wrong-home',
      }),
    ).toEqual({ kind: 'conflict' });
    await source.close();
    const restarted = history(path);
    try {
      await restarted.open({ grant: grant('discover') });
      expect(await restarted.append(message('after-restart'))).toEqual({
        kind: 'denied',
      });
      expect(
        await restarted.sealSource({
          grant: grant('home-transfer'),
          ...sealIntent,
        }),
      ).toEqual(sealed);
      expect(
        await restarted.read({ grant: grant('history-read') }),
      ).toMatchObject({
        kind: 'available',
        records: [{ body: { text: 'before-seal' } }],
      });
    } finally {
      await restarted.close();
    }
  } finally {
    await source.close();
    await peer.close();
    await working.close();
  }
});

it('source seal requires a dedicated grant and rechecks it at the commit boundary', async () => {
  let checks = 0;
  const source = history(undefined, {
    capabilities: {
      resolve: async (input) => {
        if (input.required === 'home-transfer' && ++checks >= 2)
          return { kind: 'revoked' };
        return capabilities.resolve(input);
      },
    },
  });
  try {
    await source.open({ grant: grant('discover') });
    expect(
      await source.sealSource({
        grant: grant('home-transfer', 'denied'),
        ...sealIntent,
      }),
    ).toEqual({ kind: 'denied' });
    checks = 0;
    expect(
      await source.sealSource({ grant: grant('home-transfer'), ...sealIntent }),
    ).toEqual({ kind: 'denied' });
    expect(checks).toBeGreaterThanOrEqual(2);
    expect((await source.append(message('not-sealed'))).kind).toBe('committed');
  } finally {
    await source.close();
  }
});

it('source seal refuses an unpublished committed document instead of hiding it behind a closing checkpoint', async () => {
  const path = databasePath();
  const source = history(path);
  const working = createProjectTaskRoomWorkingState(path);
  try {
    await source.open({ grant: grant('discover') });
    const documentScope = {
      projectId: scope.projectId,
      taskId: scope.taskId,
      documentId: 'document',
    };
    expect(
      (
        await working.settle({
          scope: documentScope,
          intentId: 'pending-edit',
          intentDigest: sha('pending-edit'),
          actorId: 'operator',
          epoch: 1,
          publicationPrincipal: {
            operatorId: 'operator',
            deviceId: 'device',
            policyRevision: 'policy-1',
          },
          operations: [
            {
              schemaVersion: 1,
              operationId: 'pending-op',
              documentId: 'document',
              replicaId: 'replica',
              actor: { actorId: 'operator', kind: 'human' },
              parents: [],
              authorizationEpoch: 1,
              kind: 'insert',
              after: null,
              text: 'not yet published',
            },
          ],
        })
      ).kind,
    ).toBe('committed');
    expect(
      await source.sealSource({ grant: grant('home-transfer'), ...sealIntent }),
    ).toEqual({ kind: 'publication-pending' });
    expect((await source.append(message('still-open'))).kind).toBe('committed');
  } finally {
    await source.close();
    await working.close();
  }
});

it('source seal serializes behind an admitted transaction and closes at its committed checkpoint', async () => {
  const path = databasePath();
  let entered!: () => void;
  let release!: () => void;
  const atCommit = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checks = 0;
  const source = history(path, {
    capabilities: {
      resolve: async (input) => {
        if (input.required === 'message-write' && ++checks === 3) {
          entered();
          await proceed;
        }
        return capabilities.resolve(input);
      },
    },
  });
  const sealer = history(path);
  try {
    await source.open({ grant: grant('discover') });
    await sealer.open({ grant: grant('discover') });
    const append = source.append(message('in-flight-at-closure'));
    await atCommit;
    const sealing = sealer.sealSource({
      grant: grant('home-transfer'),
      ...sealIntent,
    });
    release();
    const committed = await append;
    expect(committed.kind).toBe('committed');
    if (committed.kind !== 'committed') throw new Error('Expected real commit');
    expect(await sealing).toMatchObject({
      kind: 'sealed',
      seal: {
        checkpoint: committed.receipt.checkpoint,
      },
    });
    expect(await source.append(message('after-race'))).toEqual({
      kind: 'denied',
    });
  } finally {
    release();
    await source.close();
    await sealer.close();
  }
});
