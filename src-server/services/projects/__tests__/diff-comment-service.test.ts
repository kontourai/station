import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  reviewCommentsCreated: { add: vi.fn() },
  reviewCommentsDeleted: { add: vi.fn() },
  reviewCommentsListed: { add: vi.fn() },
}));

import { DiffCommentService } from '../diff-comment-service.js';

describe('DiffCommentService', () => {
  let storePath: string;
  let service: DiffCommentService;

  beforeEach(() => {
    storePath = join(tmpdir(), `diff-comments-${randomUUID()}.json`);
    service = new DiffCommentService();
  });

  afterEach(() => {
    if (existsSync(storePath)) rmSync(storePath);
  });

  it('creates a comment and lists it back', async () => {
    const created = await service.create(storePath, {
      projectId: 'demo',
      filePath: 'src/foo.ts',
      side: 'additions',
      lineNumber: 12,
      body: '  needs a null check  ',
    });
    expect(created.id).toBeTruthy();
    expect(created.body).toBe('needs a null check'); // trimmed
    expect(created.createdAt).toBeTruthy();

    const all = service.list(storePath);
    expect(all).toHaveLength(1);
    expect(all[0].filePath).toBe('src/foo.ts');
  });

  it('filters by file path', async () => {
    await service.create(storePath, {
      projectId: 'demo',
      filePath: 'a.ts',
      side: 'additions',
      lineNumber: 1,
      body: 'on a',
    });
    await service.create(storePath, {
      projectId: 'demo',
      filePath: 'b.ts',
      side: 'deletions',
      lineNumber: 2,
      body: 'on b',
    });
    expect(service.list(storePath, 'a.ts')).toHaveLength(1);
    expect(service.list(storePath, 'a.ts')[0].body).toBe('on a');
    expect(service.list(storePath)).toHaveLength(2);
  });

  it('sorts comments by creation time', async () => {
    const first = await service.create(storePath, {
      projectId: 'demo',
      filePath: 'a.ts',
      side: 'additions',
      lineNumber: 1,
      body: 'first',
    });
    // Force a later timestamp on the second comment so ordering is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(first.createdAt) + 1000));
    await service.create(storePath, {
      projectId: 'demo',
      filePath: 'a.ts',
      side: 'additions',
      lineNumber: 2,
      body: 'second',
    });
    vi.useRealTimers();
    expect(service.list(storePath).map((c) => c.body)).toEqual([
      'first',
      'second',
    ]);
  });

  it('deletes by id and reports whether anything was removed', async () => {
    const created = await service.create(storePath, {
      projectId: 'demo',
      filePath: 'a.ts',
      side: 'additions',
      lineNumber: 1,
      body: 'doomed',
    });
    expect(await service.delete(storePath, 'nonexistent')).toBe(false);
    expect(await service.delete(storePath, created.id)).toBe(true);
    expect(service.list(storePath)).toHaveLength(0);
  });

  it('rejects an empty body', async () => {
    await expect(
      service.create(storePath, {
        projectId: 'demo',
        filePath: 'a.ts',
        side: 'additions',
        lineNumber: 1,
        body: '   ',
      }),
    ).rejects.toThrow(/body is required/i);
  });

  it('returns an empty list when the store does not exist yet', () => {
    expect(service.list(storePath)).toEqual([]);
  });

  it('lists across multiple project stores, newest first', async () => {
    const storeA = join(tmpdir(), `diff-comments-a-${randomUUID()}.json`);
    const storeB = join(tmpdir(), `diff-comments-b-${randomUUID()}.json`);
    try {
      const a = await service.create(storeA, {
        projectId: 'alpha',
        filePath: 'a.ts',
        side: 'additions',
        lineNumber: 1,
        body: 'older',
      });
      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.parse(a.createdAt) + 1000));
      await service.create(storeB, {
        projectId: 'beta',
        filePath: 'b.ts',
        side: 'deletions',
        lineNumber: 2,
        body: 'newer',
      });
      vi.useRealTimers();

      // Missing store paths contribute nothing rather than throwing.
      const missing = join(
        tmpdir(),
        `diff-comments-missing-${randomUUID()}.json`,
      );
      const all = service.listAcross([storeA, storeB, missing]);
      expect(all.map((c) => c.body)).toEqual(['newer', 'older']);
      expect(all.map((c) => c.projectId)).toEqual(['beta', 'alpha']);
    } finally {
      if (existsSync(storeA)) rmSync(storeA);
      if (existsSync(storeB)) rmSync(storeB);
    }
  });

  it('re-reads under the mutation lock so a stale create cannot restore a deleted comment', async () => {
    const removed = await service.create(storePath, {
      projectId: 'demo',
      filePath: 'a.ts',
      side: 'additions',
      lineNumber: 1,
      body: 'remove me',
    });
    let lockCalls = 0;
    const stale = new DiffCommentService({
      acquireMutationLock: async () => {
        lockCalls += 1;
        // Completes fully (through the real cross-process lock, uncontended)
        // before `stale`'s own mutation proceeds — still proves the
        // fresh-read-under-lock ordering the test names.
        if (lockCalls === 1) await service.delete(storePath, removed.id);
        return () => {};
      },
    });

    await stale.create(storePath, {
      projectId: 'demo',
      filePath: 'b.ts',
      side: 'additions',
      lineNumber: 2,
      body: 'new comment',
    });

    expect(service.list(storePath)).toEqual([
      expect.objectContaining({ body: 'new comment' }),
    ]);
  });

  it('preserves distinct concurrent creates and reopens them durably', async () => {
    let lockCalls = 0;
    const stale = new DiffCommentService({
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 1) {
          await service.create(storePath, {
            projectId: 'demo',
            filePath: 'first.ts',
            side: 'additions',
            lineNumber: 1,
            body: 'first',
          });
        }
        return () => {};
      },
    });

    await stale.create(storePath, {
      projectId: 'demo',
      filePath: 'second.ts',
      side: 'deletions',
      lineNumber: 2,
      body: 'second',
    });

    expect(lockCalls).toBe(1);
    expect(
      new DiffCommentService().list(storePath).map((comment) => comment.body),
    ).toEqual(['first', 'second']);
  });

  it('orders a lock-blocked create by when it committed, not when it started', async () => {
    // The test above only distinguishes commit-order from start-order when the
    // two writes land in different milliseconds. On a fast host they collide,
    // the createdAt comparison ties, and a stable sort hides the difference —
    // which is why it passed in isolation and failed under load. This forces a
    // real time gap so the ordering contract is asserted deterministically.
    let lockCalls = 0;
    const blocked = new DiffCommentService({
      acquireMutationLock: async () => {
        lockCalls += 1;
        if (lockCalls === 1) {
          // Burn past a millisecond boundary BEFORE the inner create, so the
          // blocked writer's start time is strictly earlier than the comment
          // that actually commits first.
          const start = Date.now();
          while (Date.now() - start < 3) {
            /* busy-wait: the gap is the point of this test */
          }
          await service.create(storePath, {
            projectId: 'demo',
            filePath: 'committed-first.ts',
            side: 'additions',
            lineNumber: 1,
            body: 'committed-first',
          });
        }
        return () => {};
      },
    });

    await blocked.create(storePath, {
      projectId: 'demo',
      filePath: 'committed-second.ts',
      side: 'deletions',
      lineNumber: 2,
      body: 'committed-second',
    });

    const listed = new DiffCommentService().list(storePath);
    expect(listed.map((comment) => comment.body)).toEqual([
      'committed-first',
      'committed-second',
    ]);
    // The persisted stamps must agree with the order, not merely happen to
    // sort that way: the blocked writer must not carry its pre-lock time.
    expect(
      listed[0]!.createdAt.localeCompare(listed[1]!.createdAt),
    ).toBeLessThanOrEqual(0);
  });

  it('refuses a mutation lock without changing the persisted comments', async () => {
    const comment = await service.create(storePath, {
      projectId: 'demo',
      filePath: 'a.ts',
      side: 'additions',
      lineNumber: 1,
      body: 'locked',
    });
    const before = readFileSync(storePath, 'utf8');
    const locked = new DiffCommentService({
      acquireMutationLock: () => {
        throw new Error('diff comment lock unavailable');
      },
    });

    await expect(locked.delete(storePath, comment.id)).rejects.toThrow(
      'diff comment lock unavailable',
    );
    expect(readFileSync(storePath, 'utf8')).toBe(before);
    expect(existsSync(`${storePath}.mutation`)).toBe(false);
  });

  it('does not publish a create when durable writing fails', async () => {
    const failing = new DiffCommentService({
      storeFactory: (path) => ({
        read: () => JSON.parse(readFileSync(path, 'utf8')),
        write: () => {
          throw new Error('durable write failed');
        },
      }),
    });
    await service.create(storePath, {
      projectId: 'demo',
      filePath: 'a.ts',
      side: 'additions',
      lineNumber: 1,
      body: 'already durable',
    });
    const before = readFileSync(storePath, 'utf8');

    await expect(
      failing.create(storePath, {
        projectId: 'demo',
        filePath: 'b.ts',
        side: 'additions',
        lineNumber: 2,
        body: 'must not persist',
      }),
    ).rejects.toThrow('durable write failed');
    expect(readFileSync(storePath, 'utf8')).toBe(before);
  });

  it('rejects an unsafe path before acquiring a mutation lock', async () => {
    let lockCalls = 0;
    const strict = new DiffCommentService({
      acquireMutationLock: () => {
        lockCalls += 1;
        return () => {};
      },
    });

    await expect(
      strict.create(storePath, {
        projectId: 'demo',
        filePath: '../outside.ts',
        side: 'additions',
        lineNumber: 1,
        body: 'invalid path',
      }),
    ).rejects.toThrow('Diff comment is invalid');
    expect(lockCalls).toBe(0);
  });

  it('rejects directory paths and empty author ids before acquiring a lock', async () => {
    let lockCalls = 0;
    const strict = new DiffCommentService({
      acquireMutationLock: () => {
        lockCalls += 1;
        return () => {};
      },
    });
    for (const input of [
      { filePath: 'src/' },
      { filePath: '.', authorId: '' },
    ]) {
      const base = {
        projectId: 'demo',
        filePath: 'a.ts',
        side: 'additions' as const,
        lineNumber: 1,
        body: 'invalid',
      };
      await expect(
        strict.create(storePath, { ...base, ...input }),
      ).rejects.toThrow('Diff comment is invalid');
    }
    expect(lockCalls).toBe(0);
  });

  it.each([
    ['malformed JSON', '{ unreadable'],
    ['wrong root shape', '{}'],
    ['invalid stored record', JSON.stringify([{ id: 'not-a-uuid' }])],
  ])(
    'fails loudly on %s without replacing the original bytes',
    async (_label, bytes) => {
      writeFileSync(storePath, bytes, 'utf8');

      expect(() => service.list(storePath)).toThrow();
      await expect(
        service.create(storePath, {
          projectId: 'demo',
          filePath: 'a.ts',
          side: 'additions',
          lineNumber: 1,
          body: 'must not replace corruption',
        }),
      ).rejects.toThrow();
      expect(readFileSync(storePath, 'utf8')).toBe(bytes);
      expect(existsSync(`${storePath}.mutation`)).toBe(false);
    },
  );

  it.each([
    [
      'duplicate persisted ids',
      (comment: Awaited<ReturnType<typeof service.create>>) => [
        comment,
        { ...comment, filePath: 'other.ts' },
      ],
    ],
    [
      'a noncanonical persisted path',
      (comment: Awaited<ReturnType<typeof service.create>>) => [
        { ...comment, filePath: '../outside.ts' },
      ],
    ],
    [
      'a padded persisted body',
      (comment: Awaited<ReturnType<typeof service.create>>) => [
        { ...comment, body: ` ${comment.body} ` },
      ],
    ],
    [
      'a date-only persisted timestamp',
      (comment: Awaited<ReturnType<typeof service.create>>) => [
        { ...comment, updatedAt: '2026-01-01' },
      ],
    ],
    [
      'a changed immutable updated timestamp',
      (comment: Awaited<ReturnType<typeof service.create>>) => [
        { ...comment, updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    ],
    [
      'a persisted directory path',
      (comment: Awaited<ReturnType<typeof service.create>>) => [
        { ...comment, filePath: 'src/' },
      ],
    ],
    [
      'an empty persisted author id',
      (comment: Awaited<ReturnType<typeof service.create>>) => [
        { ...comment, authorId: '' },
      ],
    ],
  ])('rejects %s without rewriting bytes', async (_label, document) => {
    const comment = await service.create(storePath, {
      projectId: 'demo',
      filePath: 'a.ts',
      side: 'additions',
      lineNumber: 1,
      body: 'valid',
    });
    const bytes = JSON.stringify(document(comment));
    writeFileSync(storePath, bytes, 'utf8');

    expect(() => service.list(storePath)).toThrow();
    await expect(
      service.create(storePath, {
        projectId: 'demo',
        filePath: 'b.ts',
        side: 'additions',
        lineNumber: 2,
        body: 'must not overwrite',
      }),
    ).rejects.toThrow();
    expect(readFileSync(storePath, 'utf8')).toBe(bytes);
  });
});
