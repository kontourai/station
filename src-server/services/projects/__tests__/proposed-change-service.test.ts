import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  reviewDecisions: { add: vi.fn() },
  reviewProposals: { add: vi.fn() },
  reviewQueueDepthSamples: { add: vi.fn() },
  reviewTimeToDecision: { record: vi.fn() },
}));

const {
  ProposedChangeConflictError,
  ProposedChangeNotFoundError,
  ProposedChangeService,
  ProposedChangeTransitionError,
  ProposedChangeValidationError,
} = await import('../proposed-change-service.js');

function createInput(id?: string) {
  return {
    ...(id ? { id } : {}),
    sessionId: 'session-1',
    projectId: 'project-a',
    path: `${id ?? 'change'}.ts`,
    changeType: 'modify' as const,
    contentKind: 'code' as const,
    baseSnapshot: { content: 'old' },
    proposedSnapshot: { content: 'new' },
    sourceRuntime: 'codex',
  };
}

describe('ProposedChangeService', () => {
  let dir: string;
  let service: InstanceType<typeof ProposedChangeService>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proposed-change-test-'));
    service = new ProposedChangeService(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates and filters pending proposed changes', async () => {
    const change = await service.create({
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'README.md',
      changeType: 'modify',
      contentKind: 'markdown',
      baseSnapshot: { content: '# Old' },
      proposedSnapshot: { content: '# New' },
      sourceRuntime: 'claude',
    });

    expect(change.status).toBe('pending');
    expect(service.list({ projectId: 'project-a' })).toHaveLength(1);
    expect(service.list({ sessionId: 'session-1' })).toHaveLength(1);
    expect(service.list({ status: ['approved'] })).toHaveLength(0);
  });

  test('approves and rejects only pending changes', async () => {
    const change = await service.create({
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'src/index.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'old' },
      proposedSnapshot: { content: 'new' },
      sourceRuntime: 'codex',
    });

    const approved = await service.approve(change.id, {
      actorId: 'user-1',
      reason: 'Looks correct',
    });

    expect(approved.status).toBe('approved');
    expect(approved.decisions[0]).toMatchObject({
      actorId: 'user-1',
      actorType: 'human',
      decision: 'approved',
      reason: 'Looks correct',
    });
    await expect(service.reject(change.id)).rejects.toThrow(
      ProposedChangeTransitionError,
    );
  });

  test('bulk reject records a shared bulk decision id', async () => {
    const first = await service.create({
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'a.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'a' },
      proposedSnapshot: { content: 'b' },
      sourceRuntime: 'codex',
    });
    const second = await service.create({
      sessionId: 'session-1',
      projectId: 'project-a',
      path: 'b.ts',
      changeType: 'modify',
      contentKind: 'code',
      baseSnapshot: { content: 'a' },
      proposedSnapshot: { content: 'b' },
      sourceRuntime: 'codex',
    });

    const rejected = await service.bulkReject({
      ids: [first.id, second.id],
      reason: 'Wrong direction',
    });

    expect(rejected).toHaveLength(2);
    expect(rejected.map((change) => change.id)).toEqual([first.id, second.id]);
    expect(rejected.every((change) => change.status === 'rejected')).toBe(true);
    expect(rejected[0].decisions[0].bulkDecisionId).toBeTruthy();
    expect(rejected[0].decisions[0].bulkDecisionId).toBe(
      rejected[1].decisions[0].bulkDecisionId,
    );
    expect(
      new Set(rejected.map((change) => change.decisions[0].decidedAt)).size,
    ).toBe(1);
    expect(
      rejected.every(
        (change) =>
          change.decisions[0].actorType === 'human' &&
          change.decisions[0].reason === 'Wrong direction',
      ),
    ).toBe(true);
  });

  test('rejects invalid create input before persistence', async () => {
    await expect(
      service.create({
        sessionId: '',
        projectId: 'project-a',
        path: '',
        changeType: 'modify',
        contentKind: 'code',
        sourceRuntime: '',
      }),
    ).rejects.toThrow(ProposedChangeValidationError);
    expect(service.list()).toEqual([]);
  });

  test.each([
    ['padded identity', { sessionId: ' session-1 ' }],
    ['padded path', { path: ' change.ts ' }],
    ['padded runtime', { sourceRuntime: ' codex ' }],
    ['date-only timestamp', { createdAt: '2026-01-01' }],
  ])('rejects %s new input before persistence', async (_label, override) => {
    await expect(
      service.create({ ...createInput(), ...override }),
    ).rejects.toThrow(ProposedChangeValidationError);
    expect(service.list()).toEqual([]);
  });

  test('refuses a duplicate caller id and preserves an existing decision', async () => {
    const change = await service.create(createInput('change-duplicate'));
    await service.approve(change.id);
    const file = join(dir, 'proposed-changes.json');
    const before = readFileSync(file, 'utf8');

    await expect(service.create(createInput(change.id))).rejects.toThrow(
      ProposedChangeConflictError,
    );
    expect(service.get(change.id)?.status).toBe('approved');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('re-reads under the mutation lock so stale creation preserves a concurrent decision', async () => {
    const existing = await service.create(createInput('change-existing'));
    let lockCalls = 0;
    const stale = new ProposedChangeService(dir, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        // The concurrent decision completes fully (through the real
        // cross-process lock, uncontended) before `stale`'s own mutation
        // proceeds — still proves the fresh-read-under-lock ordering.
        if (lockCalls === 1) await service.approve(existing.id);
        return () => {};
      },
    });

    await stale.create(createInput('change-new'));

    const reopened = new ProposedChangeService(dir);
    expect(reopened.get(existing.id)?.status).toBe('approved');
    expect(reopened.get('change-new')?.status).toBe('pending');
  });

  test('serializes conflicting concurrent decisions so only the first transition commits', async () => {
    const change = await service.create(createInput('change-race'));
    let lockCalls = 0;
    const first = new ProposedChangeService(dir, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 1) await service.reject(change.id);
        return () => {};
      },
    });

    await expect(first.approve(change.id)).rejects.toThrow(
      ProposedChangeTransitionError,
    );

    const persisted = new ProposedChangeService(dir).get(change.id)!;
    expect(persisted.status).toBe('rejected');
    expect(persisted.decisions).toHaveLength(1);
  });

  test('publishes a bulk decision under one lock without losing a concurrent creation', async () => {
    const first = await service.create(createInput('change-first'));
    const second = await service.create(createInput('change-second'));
    let lockCalls = 0;
    const bulk = new ProposedChangeService(dir, {
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 1) {
          await service.create(createInput('change-concurrent'));
        }
        return () => {};
      },
    });

    await bulk.bulkApprove({ ids: [first.id, second.id] });

    const reopened = new ProposedChangeService(dir);
    expect(lockCalls).toBe(1);
    expect(reopened.get(first.id)?.status).toBe('approved');
    expect(reopened.get(second.id)?.status).toBe('approved');
    expect(reopened.get('change-concurrent')?.status).toBe('pending');
  });

  test('validates every bulk target before publishing any decision', async () => {
    const first = await service.create(createInput('change-first'));
    const second = await service.create(createInput('change-second'));

    await expect(
      service.bulkApprove({ ids: [first.id, 'missing'] }),
    ).rejects.toThrow(ProposedChangeNotFoundError);
    expect(service.get(first.id)?.status).toBe('pending');

    await service.approve(second.id);
    await expect(
      service.bulkApprove({ ids: [first.id, second.id] }),
    ).rejects.toThrow(ProposedChangeTransitionError);
    expect(service.get(first.id)?.status).toBe('pending');
    expect(service.get(second.id)?.status).toBe('approved');

    await expect(
      service.bulkReject({ ids: [first.id, first.id] }),
    ).rejects.toThrow(ProposedChangeValidationError);
    expect(service.get(first.id)?.status).toBe('pending');
  });

  test('does not partially publish a bulk decision when durable writing fails', async () => {
    const first = await service.create(createInput('change-first'));
    const second = await service.create(createInput('change-second'));
    const file = join(dir, 'proposed-changes.json');
    const before = readFileSync(file, 'utf8');
    const store = (
      service as unknown as { store: { write: (value: unknown) => void } }
    ).store;
    const write = store.write;
    store.write = () => {
      throw new Error('durable write failed');
    };

    await expect(
      service.bulkReject({ ids: [first.id, second.id] }),
    ).rejects.toThrow('durable write failed');
    store.write = write;

    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(service.get(first.id)?.status).toBe('pending');
    expect(service.get(second.id)?.status).toBe('pending');
  });

  test('refuses an unavailable mutation lock without changing persisted changes', async () => {
    const existing = await service.create(createInput('change-existing'));
    const file = join(dir, 'proposed-changes.json');
    const before = readFileSync(file, 'utf8');
    const locked = new ProposedChangeService(dir, {
      acquireMutationLock: () => {
        throw new Error('proposed-change mutation lock is held');
      },
    });

    await expect(locked.approve(existing.id)).rejects.toThrow(
      'proposed-change mutation lock is held',
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test.each([
    ['malformed JSON', '{ unreadable'],
    ['wrong document shape', '[]'],
    ['invalid persisted change', JSON.stringify({ changes: [{}] })],
  ])(
    'fails loudly on %s without replacing the original bytes',
    async (_label, bytes) => {
      const file = join(dir, 'proposed-changes.json');
      writeFileSync(file, bytes, 'utf8');

      expect(() => service.list()).toThrow();
      await expect(service.create(createInput('change-new'))).rejects.toThrow();
      expect(readFileSync(file, 'utf8')).toBe(bytes);
      expect(existsSync(`${file}.mutation`)).toBe(false);
    },
  );

  test('refuses an unrecognized persisted field without rewriting it', async () => {
    const change = await service.create(createInput('change-existing'));
    const file = join(dir, 'proposed-changes.json');
    const bytes = JSON.stringify({ changes: [{ ...change, injected: true }] });
    writeFileSync(file, bytes, 'utf8');

    expect(() => new ProposedChangeService(dir).list()).toThrow(
      'Invalid proposed change store',
    );
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  });

  test.each([
    [
      'duplicate decision ids',
      (
        first: Awaited<ReturnType<typeof service.approve>>,
        second: typeof first,
      ) => ({
        changes: [
          first,
          {
            ...second,
            status: 'rejected',
            decisions: [
              {
                ...first.decisions[0],
                changeId: second.id,
                decision: 'rejected',
              },
            ],
          },
        ],
      }),
    ],
    [
      'a decision attached to the wrong change',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [
          {
            ...first,
            decisions: [{ ...first.decisions[0], changeId: 'other-change' }],
          },
        ],
      }),
    ],
    [
      'a pending change with a terminal decision',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [{ ...first, status: 'pending' }],
      }),
    ],
    [
      'a terminal change without its effective decision',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [{ ...first, decisions: [] }],
      }),
    ],
    [
      'an inconsistent supersession',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [
          {
            ...first,
            status: 'superseded',
            decisions: [{ ...first.decisions[0], decision: 'superseded' }],
          },
        ],
      }),
    ],
    [
      'a dangling supersession target',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [
          {
            ...first,
            status: 'superseded',
            decisions: [{ ...first.decisions[0], decision: 'superseded' }],
            supersededById: 'missing-change',
          },
        ],
      }),
    ],
    [
      'a supersession cycle',
      (
        first: Awaited<ReturnType<typeof service.approve>>,
        second: typeof first,
      ) => ({
        changes: [
          {
            ...first,
            status: 'superseded',
            decisions: [{ ...first.decisions[0], decision: 'superseded' }],
            supersededById: second.id,
          },
          {
            ...second,
            path: first.path,
            status: 'superseded',
            updatedAt: second.createdAt,
            decisions: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                changeId: second.id,
                decision: 'superseded',
                actorType: 'human',
                decidedAt: second.createdAt,
              },
            ],
            supersededById: first.id,
          },
        ],
      }),
    ],
    [
      'a cross-context supersession target',
      (
        first: Awaited<ReturnType<typeof service.approve>>,
        second: typeof first,
      ) => ({
        changes: [
          {
            ...first,
            status: 'superseded',
            decisions: [{ ...first.decisions[0], decision: 'superseded' }],
            supersededById: second.id,
          },
          { ...second, sessionId: 'session-other', path: first.path },
        ],
      }),
    ],
    [
      'a cross-path supersession target',
      (
        first: Awaited<ReturnType<typeof service.approve>>,
        second: typeof first,
      ) => ({
        changes: [
          {
            ...first,
            status: 'superseded',
            decisions: [{ ...first.decisions[0], decision: 'superseded' }],
            supersededById: second.id,
          },
          second,
        ],
      }),
    ],
    [
      'a terminal timestamp that differs from its decision',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [{ ...first, updatedAt: '2020-01-01T00:00:00.000Z' }],
      }),
    ],
    [
      'a noncanonical bulk decision id',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [
          {
            ...first,
            decisions: [
              { ...first.decisions[0], bulkDecisionId: ' bulk-decision ' },
            ],
          },
        ],
      }),
    ],
    [
      'a noncanonical decision id',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [
          { ...first, decisions: [{ ...first.decisions[0], id: 'decision' }] },
        ],
      }),
    ],
    [
      'incoherent members of the same bulk decision',
      (
        first: Awaited<ReturnType<typeof service.approve>>,
        second: typeof first,
      ) => {
        const bulkDecision = {
          ...first.decisions[0],
          bulkDecisionId: '22222222-2222-4222-8222-222222222222',
        };
        return {
          changes: [
            { ...first, decisions: [bulkDecision] },
            {
              ...second,
              status: 'approved',
              updatedAt: bulkDecision.decidedAt,
              decisions: [
                {
                  ...bulkDecision,
                  id: '11111111-1111-4111-8111-111111111111',
                  changeId: second.id,
                  actorType: 'agent',
                },
              ],
            },
          ],
        };
      },
    ],
    [
      'a padded persisted identity',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [{ ...first, sessionId: ` ${first.sessionId} ` }],
      }),
    ],
    [
      'a padded persisted path',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [{ ...first, path: ` ${first.path} ` }],
      }),
    ],
    [
      'a padded persisted runtime',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [{ ...first, sourceRuntime: ` ${first.sourceRuntime} ` }],
      }),
    ],
    [
      'a date-only persisted timestamp',
      (first: Awaited<ReturnType<typeof service.approve>>) => ({
        changes: [{ ...first, createdAt: '2026-01-01' }],
      }),
    ],
  ])(
    'rejects %s persisted state without rewriting it',
    async (_label, document) => {
      const first = await service.create(createInput('change-first'));
      const second = await service.create(createInput('change-second'));
      const approved = await service.approve(first.id);
      const bytes = JSON.stringify(document(approved, second));
      const file = join(dir, 'proposed-changes.json');
      writeFileSync(file, bytes, 'utf8');

      expect(() => service.list()).toThrow();
      await expect(service.create(createInput('change-new'))).rejects.toThrow();
      expect(readFileSync(file, 'utf8')).toBe(bytes);
    },
  );
});
