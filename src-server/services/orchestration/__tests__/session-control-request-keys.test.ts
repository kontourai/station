import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import {
  createSqliteSessionControlRequestKeys,
  runWithSessionControlKey,
  SESSION_CONTROL_REQUEST_KEY_MAX_ROWS,
  SESSION_CONTROL_REQUEST_KEY_MAX_ROWS_PER_CALLER,
  SESSION_CONTROL_REQUEST_KEY_TTL_MS,
  sessionControlDeliveryId,
  sessionControlRequestDigest,
} from '../session-control-request-keys.js';
import type { SqliteDatabase } from '../sqlite-database.js';

// Registered first so the stores close (the hook below) before the directories go.
const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function open(path?: string) {
  const file = path ?? join(makeTempDir('sc-keys-'), 'events.sqlite');
  const store = new EventStore(file);
  stores.push(store);
  return { store, file };
}
const id = (
  key = 'key-00000001',
  caller = 'caller-a',
  tool = 'send_to_session',
) => ({
  callerSessionId: caller,
  tool,
  key,
});

describe('session control request keys (real SQLite table)', () => {
  test('a replay of the same request returns the stored result and runs nothing', async () => {
    const keys = open().store.sessionControlRequestKeys();
    let runs = 0;
    const attempt = async () => {
      runs += 1;
      return { settle: 'final' as const, result: { turn: runs } };
    };
    const digest = sessionControlRequestDigest(['s', 'auto', 'hello']);
    const first = await runWithSessionControlKey(keys, id(), digest, attempt);
    const second = await runWithSessionControlKey(keys, id(), digest, attempt);
    expect([first, second]).toEqual([
      { kind: 'executed', result: { turn: 1 } },
      { kind: 'replayed', result: { turn: 1 } },
    ]);
    expect(runs).toBe(1);
  });

  test('the same key with a different request is a conflict and runs nothing', async () => {
    const keys = open().store.sessionControlRequestKeys();
    let runs = 0;
    const attempt = async () => {
      runs += 1;
      return { settle: 'final' as const, result: runs };
    };
    await runWithSessionControlKey(
      keys,
      id(),
      sessionControlRequestDigest(['a']),
      attempt,
    );
    expect(
      await runWithSessionControlKey(
        keys,
        id(),
        sessionControlRequestDigest(['b']),
        attempt,
      ),
    ).toEqual({ kind: 'conflict' });
    expect(runs).toBe(1);
  });

  test('keys are scoped by the calling session and by tool', async () => {
    const keys = open().store.sessionControlRequestKeys();
    let runs = 0;
    const attempt = async () => {
      runs += 1;
      return { settle: 'final' as const, result: runs };
    };
    const digest = sessionControlRequestDigest(['x']);
    for (const scoped of [
      id(),
      id('key-00000001', 'caller-b'),
      id('key-00000001', 'caller-a', 'interrupt_session'),
    ])
      expect(
        (await runWithSessionControlKey(keys, scoped, digest, attempt)).kind,
      ).toBe('executed');
    expect(runs).toBe(3);
    expect(sessionControlDeliveryId(id())).not.toBe(
      sessionControlDeliveryId(id('key-00000001', 'caller-b')),
    );
  });

  test('a claim with no result survives a restart and is re-driven with its recorded decision', async () => {
    const { store, file } = open();
    const digest = sessionControlRequestDigest(['x']);
    const crashed = await runWithSessionControlKey(
      store.sessionControlRequestKeys(),
      id(),
      digest,
      async (resume) => {
        resume.recordDecision('steer:thread-1');
        return { settle: 'pending' as const, result: 'indeterminate' };
      },
    );
    expect(crashed).toEqual({ kind: 'executed', result: 'indeterminate' });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = open(file).store.sessionControlRequestKeys();
    const seen: Array<string | undefined> = [];
    const outcome = await runWithSessionControlKey(
      reopened,
      id(),
      digest,
      async (resume) => {
        seen.push(resume.decision);
        return { settle: 'final' as const, result: 'done' };
      },
    );
    expect(outcome).toEqual({ kind: 'executed', result: 'done' });
    expect(seen).toEqual(['steer:thread-1']);
    // And now it is a stored result.
    expect(
      await runWithSessionControlKey(reopened, id(), digest, async () => ({
        settle: 'final' as const,
        result: 'again',
      })),
    ).toEqual({ kind: 'replayed', result: 'done' });
  });

  test('a stored result is durable across a restart', async () => {
    const { store, file } = open();
    const digest = sessionControlRequestDigest(['x']);
    await runWithSessionControlKey(
      store.sessionControlRequestKeys(),
      id(),
      digest,
      async () => ({ settle: 'final' as const, result: { n: 1 } }),
    );
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(
      await runWithSessionControlKey(
        open(file).store.sessionControlRequestKeys(),
        id(),
        digest,
        async () => ({ settle: 'final' as const, result: { n: 2 } }),
      ),
    ).toEqual({ kind: 'replayed', result: { n: 1 } });
  });

  test('the same request arriving while it runs is in-progress, not a second run', async () => {
    const keys = open().store.sessionControlRequestKeys();
    const digest = sessionControlRequestDigest(['x']);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const slow = runWithSessionControlKey(keys, id(), digest, async () => {
      runs += 1;
      await gate;
      return { settle: 'final' as const, result: 'ok' };
    });
    const concurrent = await runWithSessionControlKey(
      keys,
      id(),
      digest,
      async () => {
        runs += 1;
        return { settle: 'final' as const, result: 'second' };
      },
    );
    release();
    expect(concurrent).toEqual({ kind: 'in-progress' });
    expect(await slow).toEqual({ kind: 'executed', result: 'ok' });
    expect(runs).toBe(1);
  });

  test('a released key (a clean failure) may run again; a thrown attempt keeps its claim', async () => {
    const keys = open().store.sessionControlRequestKeys();
    const digest = sessionControlRequestDigest(['x']);
    await runWithSessionControlKey(keys, id(), digest, async () => ({
      settle: 'release' as const,
      result: 'failed',
    }));
    expect(
      await runWithSessionControlKey(keys, id(), digest, async () => ({
        settle: 'final' as const,
        result: 'ok',
      })),
    ).toEqual({ kind: 'executed', result: 'ok' });
    await expect(
      runWithSessionControlKey(keys, id('key-00000002'), digest, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    let sawResume = false;
    await runWithSessionControlKey(
      keys,
      id('key-00000002'),
      digest,
      async () => {
        sawResume = true;
        return { settle: 'final' as const, result: 'ok' };
      },
    );
    expect(sawResume).toBe(true);
  });

  test('a release on a RESUMED claim keeps the claim and the branch it pinned', async () => {
    const keys = open().store.sessionControlRequestKeys();
    const digest = sessionControlRequestDigest(['x']);
    await runWithSessionControlKey(keys, id(), digest, async (resume) => {
      resume.recordDecision('steer:thread-1');
      return { settle: 'pending' as const, result: 'indeterminate' };
    });
    // The re-drive is refused and asks to release: the claim must survive.
    const refused = await runWithSessionControlKey(
      keys,
      id(),
      digest,
      async () => ({
        settle: 'release' as const,
        result: 'refused',
      }),
    );
    expect(refused).toEqual({ kind: 'executed', result: 'refused' });
    const seen: Array<string | undefined> = [];
    await runWithSessionControlKey(keys, id(), digest, async (resume) => {
      seen.push(resume.decision);
      return { settle: 'final' as const, result: 'ok' };
    });
    expect(seen).toEqual(['steer:thread-1']);
  });

  test('rows expire after the TTL', async () => {
    const { store } = open();
    const keys = store.sessionControlRequestKeys();
    const digest = sessionControlRequestDigest(['x']);
    await runWithSessionControlKey(keys, id(), digest, async () => ({
      settle: 'final' as const,
      result: 1,
    }));
    // A claim made past the TTL prunes the old row first.
    const realNow = Date.now;
    Date.now = () => realNow() + SESSION_CONTROL_REQUEST_KEY_TTL_MS + 1000;
    try {
      expect(
        await runWithSessionControlKey(keys, id(), digest, async () => ({
          settle: 'final' as const,
          result: 2,
        })),
      ).toEqual({ kind: 'executed', result: 2 });
    } finally {
      Date.now = realNow;
    }
  });

  describe('quotas', () => {
    const digest = sessionControlRequestDigest(['x']);
    const done = async () => ({ settle: 'final' as const, result: 'ok' });
    const fill = async (
      keys: ReturnType<EventStore['sessionControlRequestKeys']>,
      caller: string,
      count: number,
      attempt: () => Promise<{
        settle: 'final' | 'pending';
        result: string;
      }> = done,
    ) => {
      for (let index = 0; index < count; index += 1)
        await runWithSessionControlKey(
          keys,
          id(`fill-${String(index).padStart(6, '0')}`, caller),
          digest,
          attempt,
        );
    };

    test('one caller filling its quota never touches another caller', async () => {
      const keys = open().store.sessionControlRequestKeys();
      // Far more claims than the station-wide backstop holds: without a
      // per-caller quota this would fill the table for everyone.
      await fill(keys, 'noisy', SESSION_CONTROL_REQUEST_KEY_MAX_ROWS + 50);
      // Another caller claims, replays and completes as usual.
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('mine-0001', 'quiet'),
            digest,
            done,
          )
        ).kind,
      ).toBe('executed');
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('mine-0001', 'quiet'),
            digest,
            done,
          )
        ).kind,
      ).toBe('replayed');
    });

    test('past its quota a caller loses its OWN oldest completed rows, newest keep replaying', async () => {
      const keys = open().store.sessionControlRequestKeys();
      const cap = SESSION_CONTROL_REQUEST_KEY_MAX_ROWS_PER_CALLER;
      await fill(keys, 'noisy', cap);
      await fill(keys, 'other', 3);
      // One more: the oldest of ITS rows goes, nothing else.
      const extra = await runWithSessionControlKey(
        keys,
        id('extra-0001', 'noisy'),
        digest,
        done,
      );
      expect(extra.kind).toBe('executed');
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('fill-000000', 'noisy'),
            digest,
            done,
          )
        ).kind,
      ).toBe('executed');
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id(`fill-${String(cap - 1).padStart(6, '0')}`, 'noisy'),
            digest,
            done,
          )
        ).kind,
      ).toBe('replayed');
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('fill-000000', 'other'),
            digest,
            done,
          )
        ).kind,
      ).toBe('replayed');
    });

    test('unresolved claims are never evicted: a caller with only those is refused with a caller-scoped code', async () => {
      const keys = open().store.sessionControlRequestKeys();
      const cap = SESSION_CONTROL_REQUEST_KEY_MAX_ROWS_PER_CALLER;
      await fill(keys, 'stuck', cap, async () => ({
        settle: 'pending' as const,
        result: 'indeterminate',
      }));
      expect(
        await runWithSessionControlKey(
          keys,
          id('one-more-1', 'stuck'),
          digest,
          done,
        ),
      ).toEqual({ kind: 'capacity', scope: 'caller' });
      // All of its claims are still there to be resolved, and another caller is fine.
      let resumed = 0;
      await runWithSessionControlKey(
        keys,
        id('fill-000000', 'stuck'),
        digest,
        async () => {
          resumed += 1;
          return { settle: 'final' as const, result: 'ok' };
        },
      );
      expect(resumed).toBe(1);
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('mine-0001', 'quiet'),
            digest,
            done,
          )
        ).kind,
      ).toBe('executed');
      // Resolving one frees room for the stuck caller's next claim.
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('one-more-1', 'stuck'),
            digest,
            done,
          )
        ).kind,
      ).toBe('executed');
    });

    test('the defaults are the documented literals', () => {
      expect(SESSION_CONTROL_REQUEST_KEY_MAX_ROWS).toBe(10_000);
      expect(SESSION_CONTROL_REQUEST_KEY_MAX_ROWS_PER_CALLER).toBe(300);
    });

    test('the station-wide backstop refuses a new claim at the cap, while replays, conflicts and resumes still answer', async () => {
      const { store } = open();
      const keys = createSqliteSessionControlRequestKeys(
        (store as unknown as { db: SqliteDatabase }).db,
        { limits: { station: 4, perCaller: 100 } },
      );
      for (const caller of ['c1', 'c2', 'c3'])
        await runWithSessionControlKey(
          keys,
          id('done-0001', caller),
          digest,
          done,
        );
      // The fourth row is an unresolved claim.
      await runWithSessionControlKey(
        keys,
        id('stuck-0001', 'c4'),
        digest,
        async () => ({
          settle: 'pending' as const,
          result: 'indeterminate',
        }),
      );
      // At the cap a NEW claim is refused with the station-scoped code.
      expect(
        await runWithSessionControlKey(
          keys,
          id('late-0001', 'c5'),
          digest,
          done,
        ),
      ).toEqual({ kind: 'capacity', scope: 'station' });
      // Existing keys keep answering.
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('done-0001', 'c1'),
            digest,
            done,
          )
        ).kind,
      ).toBe('replayed');
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('done-0001', 'c1'),
            sessionControlRequestDigest(['other']),
            done,
          )
        ).kind,
      ).toBe('conflict');
      expect(
        (
          await runWithSessionControlKey(
            keys,
            id('stuck-0001', 'c4'),
            digest,
            done,
          )
        ).kind,
      ).toBe('executed');
      // One more row than the cap holds never appears.
      expect(
        await runWithSessionControlKey(
          keys,
          id('late-0002', 'c5'),
          digest,
          done,
        ),
      ).toEqual({ kind: 'capacity', scope: 'station' });
    });
  });
});
