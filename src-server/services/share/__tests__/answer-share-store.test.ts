import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnswerShareStore,
  AnswerShareStoreError,
  type AnswerShareStoreOptions,
  answerShareTokenHash,
} from '../answer-share-store.js';

/**
 * The durable half of station#1423. Two properties carry the whole design and
 * both are asserted against the bytes on disk, not against the API's promises:
 * the token is never stored, and revocation tombstones rather than deletes.
 */

const homes: string[] = [];

function store(options: Omit<AnswerShareStoreOptions, 'homeDir'> = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-answer-shares-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  return {
    homeDir,
    store: new AnswerShareStore({ homeDir, ...options }),
    raw: () =>
      readFileSync(join(homeDir, 'security', 'answer-shares.json'), 'utf8'),
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('AnswerShareStore', () => {
  it('never writes the token — only its digest', async () => {
    const harness = store();
    const { token, record } = await harness.store.mint({
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });

    const bytes = harness.raw();
    expect(bytes).not.toContain(token);
    expect(bytes).toContain(createHash('sha256').update(token).digest('hex'));
    expect(record.tokenHash).toBe(answerShareTokenHash(token));
  });

  it('keeps the digest out of the operator-facing summary as well', async () => {
    const harness = store();
    const { token, record } = await harness.store.mint({
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
    const serialized = JSON.stringify(harness.store.list());
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(record.tokenHash);
    expect(serialized).toContain(record.id);
  });

  it('resolves a share only by its own token', async () => {
    const harness = store();
    const first = await harness.store.mint({
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
    const second = await harness.store.mint({
      sessionId: 'thread-2',
      turnId: 'turn-2',
    });

    expect(harness.store.resolveByToken(first.token)?.id).toBe(first.record.id);
    expect(harness.store.resolveByToken(second.token)?.id).toBe(
      second.record.id,
    );
  });

  it.each([
    ['an unknown but well-formed token', 'a'.repeat(43)],
    ['a malformed token', 'not a token!!'],
    ['an empty token', ''],
    ['the share id, which is not a capability', 'id-not-token'],
  ])('resolves %s to nothing at all', async (_label, candidate) => {
    const harness = store();
    await harness.store.mint({ sessionId: 'thread-1', turnId: 'turn-1' });
    // The enumeration guard: every non-token input reaches the same
    // `undefined`, so nothing distinguishes "no such share" from "wrong token
    // for a real share".
    expect(harness.store.resolveByToken(candidate)).toBeUndefined();
  });

  it('resolving by the operator-facing id is impossible even when that id is known', async () => {
    const harness = store();
    const { record } = await harness.store.mint({
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(harness.store.resolveByToken(record.id)).toBeUndefined();
  });

  it('tombstones on revoke so the record still answers its holder', async () => {
    let clock = Date.parse('2026-08-01T00:00:00.000Z');
    const harness = store({ now: () => clock });
    const { token, record } = await harness.store.mint({
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });

    clock += 60_000;
    const revoked = await harness.store.revoke(record.id);
    expect(revoked.state).toBe('revoked');
    expect(revoked.revokedAt).toBe('2026-08-01T00:01:00.000Z');
    // Still resolvable — that is what lets the view say "revoked" instead of
    // the ambiguous "not found".
    expect(harness.store.resolveByToken(token)?.revokedAt).toBe(
      '2026-08-01T00:01:00.000Z',
    );
    expect(harness.store.list()).toHaveLength(1);
  });

  it('is idempotent on revoke and does not move the recorded moment', async () => {
    let clock = Date.parse('2026-08-01T00:00:00.000Z');
    const harness = store({ now: () => clock });
    const { record } = await harness.store.mint({
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
    await harness.store.revoke(record.id);
    clock += 3_600_000;
    expect((await harness.store.revoke(record.id)).revokedAt).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('refuses to revoke an id it does not hold', async () => {
    const harness = store();
    await expect(harness.store.revoke('nope')).rejects.toThrowError(
      AnswerShareStoreError,
    );
  });

  it('clamps a lifetime past the declared ceiling instead of honouring it', async () => {
    const clock = Date.parse('2026-08-01T00:00:00.000Z');
    const harness = store({ now: () => clock });
    const { record } = await harness.store.mint({
      sessionId: 'thread-1',
      turnId: 'turn-1',
      ttlMs: 10 * 365 * 24 * 60 * 60 * 1000,
    });
    expect(Date.parse(record.expiresAt) - clock).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses the nonsensical lifetime %s rather than silently defaulting',
    async (ttlMs) => {
      const harness = store();
      await expect(
        harness.store.mint({
          sessionId: 'thread-1',
          turnId: 'turn-1',
          ttlMs,
        }),
      ).rejects.toThrowError(AnswerShareStoreError);
    },
  );

  it('refuses to mint past its record ceiling', async () => {
    const harness = store({ maxRecords: 1 });
    await harness.store.mint({ sessionId: 'thread-1', turnId: 'turn-1' });
    await expect(
      harness.store.mint({ sessionId: 'thread-2', turnId: 'turn-2' }),
    ).rejects.toThrowError(AnswerShareStoreError);
  });

  it('re-reads after holding the mutation lock so a stale mint cannot restore a revocation', async () => {
    const harness = store();
    const revoked = await harness.store.mint({
      sessionId: 'thread-revoked',
      turnId: 'turn-revoked',
    });
    const second = new AnswerShareStore({ homeDir: harness.homeDir });
    let secondMutationStarted = false;
    const first = new AnswerShareStore({
      homeDir: harness.homeDir,
      acquireMutationLock: async () => {
        if (!secondMutationStarted) {
          secondMutationStarted = true;
          // Completes fully (through the real cross-process lock,
          // uncontended) before `first`'s own mutation proceeds — still
          // proves the fresh-read-under-lock ordering the test names.
          await second.revoke(revoked.record.id);
        }
        return () => {};
      },
    });

    await first.mint({ sessionId: 'thread-new', turnId: 'turn-new' });

    const reopened = new AnswerShareStore({ homeDir: harness.homeDir });
    expect(reopened.resolveByToken(revoked.token)?.revokedAt).not.toBeNull();
    expect(reopened.list()).toHaveLength(2);
  });

  it('enforces capacity from the fresh locked document', async () => {
    const harness = store({ maxRecords: 1 });
    const second = new AnswerShareStore({
      homeDir: harness.homeDir,
      maxRecords: 1,
    });
    let secondMutationStarted = false;
    const first = new AnswerShareStore({
      homeDir: harness.homeDir,
      maxRecords: 1,
      acquireMutationLock: async () => {
        if (!secondMutationStarted) {
          secondMutationStarted = true;
          await second.mint({
            sessionId: 'thread-second',
            turnId: 'turn-second',
          });
        }
        return () => {};
      },
    });

    await expect(
      first.mint({ sessionId: 'thread-first', turnId: 'turn-first' }),
    ).rejects.toThrowError(AnswerShareStoreError);
    expect(
      new AnswerShareStore({ homeDir: harness.homeDir }).list(),
    ).toHaveLength(1);
  });

  it('preserves distinct mutations that begin from the same earlier document', async () => {
    const harness = store();
    const second = new AnswerShareStore({ homeDir: harness.homeDir });
    let secondMutationStarted = false;
    const first = new AnswerShareStore({
      homeDir: harness.homeDir,
      acquireMutationLock: async () => {
        if (!secondMutationStarted) {
          secondMutationStarted = true;
          await second.mint({
            sessionId: 'thread-second',
            turnId: 'turn-second',
          });
        }
        return () => {};
      },
    });

    await first.mint({ sessionId: 'thread-first', turnId: 'turn-first' });

    expect(
      new AnswerShareStore({ homeDir: harness.homeDir }).list(),
    ).toHaveLength(2);
  });

  it('refuses a lock acquisition without changing an existing store', async () => {
    const harness = store();
    await harness.store.mint({
      sessionId: 'thread-existing',
      turnId: 'turn-existing',
    });
    const before = harness.raw();
    const locked = new AnswerShareStore({
      homeDir: harness.homeDir,
      acquireMutationLock: () => {
        throw new Error('answer-share mutation lock is held');
      },
    });

    await expect(
      locked.mint({ sessionId: 'thread-locked', turnId: 'turn-locked' }),
    ).rejects.toThrow('answer-share mutation lock is held');
    expect(harness.raw()).toBe(before);
  });

  it('fails loudly on corrupt bytes and never writes a replacement document', async () => {
    const harness = store();
    const path = join(harness.homeDir, 'security', 'answer-shares.json');
    const corrupt = '{ unreadable';
    writeFileSync(path, corrupt, 'utf8');

    await expect(
      harness.store.mint({
        sessionId: 'thread-corrupt',
        turnId: 'turn-corrupt',
      }),
    ).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
    expect(existsSync(`${path}.mutation`)).toBe(false);
  });

  it('refuses initial creation when the mutation lock is unavailable', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-answer-shares-'));
    homes.push(homeDir);
    const path = join(homeDir, 'security', 'answer-shares.json');

    const locked = new AnswerShareStore({
      homeDir,
      acquireMutationLock: () => {
        throw new Error('answer-share mutation lock is held');
      },
    });
    await expect(
      locked.mint({ sessionId: 'thread-locked', turnId: 'turn-locked' }),
    ).rejects.toThrow('answer-share mutation lock is held');
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    [
      'write',
      {
        writeFileSync: () => {
          throw new Error('injected write failure');
        },
      },
      'injected write failure',
    ],
    [
      'file sync',
      {
        fsyncSync: () => {
          throw new Error('injected file sync failure');
        },
      },
      'injected file sync failure',
    ],
    [
      'close',
      {
        closeSync: (descriptor) => {
          closeSync(descriptor);
          throw new Error('injected close failure');
        },
      },
      'injected close failure',
    ],
    [
      'rename',
      {
        renameSync: () => {
          throw new Error('injected rename failure');
        },
      },
      'injected rename failure',
    ],
  ] satisfies Array<
    [string, NonNullable<AnswerShareStoreOptions['writeOperations']>, string]
  >)(
    'preserves the primary %s failure and cleans temporary state',
    async (_operation, writeOperations, failure) => {
      const harness = store();
      const path = join(harness.homeDir, 'security', 'answer-shares.json');
      await harness.store.mint({
        sessionId: 'thread-existing',
        turnId: 'turn-existing',
      });
      const before = harness.raw();
      const failing = new AnswerShareStore({
        homeDir: harness.homeDir,
        writeOperations,
      });

      await expect(
        failing.mint({ sessionId: 'thread-failure', turnId: 'turn-failure' }),
      ).rejects.toThrow(failure);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(readdirSync(join(harness.homeDir, 'security'))).not.toContain(
        expect.stringMatching(/\.tmp$/),
      );
      expect(existsSync(`${path}.mutation`)).toBe(false);
    },
  );

  it('returns a successful mint after a post-rename parent sync failure', async () => {
    const harness = store();
    const faulting = new AnswerShareStore({
      homeDir: harness.homeDir,
      writeOperations: {
        fsyncDirectorySync: () => {
          throw new Error('injected parent sync failure');
        },
      },
    });

    const minted = await faulting.mint({
      sessionId: 'thread-parent-sync',
      turnId: 'turn-parent-sync',
    });
    expect(
      new AnswerShareStore({ homeDir: harness.homeDir }).resolveByToken(
        minted.token,
      )?.id,
    ).toBe(minted.record.id);
  });

  it('returns a successful revoke after post-rename temp cleanup fails', async () => {
    const harness = store();
    const minted = await harness.store.mint({
      sessionId: 'thread-cleanup',
      turnId: 'turn-cleanup',
    });
    const faulting = new AnswerShareStore({
      homeDir: harness.homeDir,
      writeOperations: {
        rmSync: () => {
          throw new Error('injected cleanup failure');
        },
      },
    });

    expect((await faulting.revoke(minted.record.id)).state).toBe('revoked');
    expect(
      new AnswerShareStore({ homeDir: harness.homeDir }).resolveByToken(
        minted.token,
      )?.revokedAt,
    ).not.toBeNull();
    expect(
      existsSync(
        `${join(harness.homeDir, 'security', 'answer-shares.json')}.mutation`,
      ),
    ).toBe(false);
  });

  it('does not tell the operator to take an action no surface offers (L-7)', async () => {
    const harness = store({ maxRecords: 1 });
    await harness.store.mint({ sessionId: 'thread-1', turnId: 'turn-1' });
    let message = '';
    try {
      await harness.store.mint({ sessionId: 'thread-2', turnId: 'turn-2' });
    } catch (error) {
      message = (error as Error).message;
    }
    // v1 has no delete verb, so "prune some first" named something the
    // operator cannot do. The copy explains why revoked shares still count
    // instead.
    expect(message).not.toMatch(/prune/i);
    expect(message).toContain('Revoked and expired shares still count');
  });

  it('rejects a label carrying control characters', async () => {
    const harness = store();
    await expect(
      harness.store.mint({
        sessionId: 'thread-1',
        turnId: 'turn-1',
        label: `bad${String.fromCharCode(7)}label`,
      }),
    ).rejects.toThrowError(AnswerShareStoreError);
  });

  it('survives a reload with every record intact', async () => {
    const harness = store();
    const { token } = await harness.store.mint({
      sessionId: 'thread-1',
      turnId: 'turn-1',
      label: 'For the client',
    });
    const reopened = new AnswerShareStore({ homeDir: harness.homeDir });
    expect(reopened.resolveByToken(token)?.label).toBe('For the client');
  });
});
