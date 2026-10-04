import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';
import {
  runWithSessionControlKey,
  SESSION_CONTROL_REQUEST_KEY_TTL_MS,
  sessionControlDeliveryId,
  sessionControlRequestDigest,
} from '../session-control-request-keys.js';

const dirs: string[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function open(path?: string) {
  const dir = path ? undefined : mkdtempSync(join(tmpdir(), 'sc-keys-'));
  if (dir) dirs.push(dir);
  const file = path ?? join(dir!, 'events.sqlite');
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
});
