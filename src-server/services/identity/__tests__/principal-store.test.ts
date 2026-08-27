import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  humanPrincipal,
  InvalidPrincipalComponentError,
} from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test } from 'vitest';
import { JsonFileStoreCorruptionError } from '../../infra/json-store.js';
import {
  PrincipalConflictError,
  PrincipalStore,
  PrincipalStoreShapeError,
  principalStorePath,
} from '../principal-store.js';

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'station-principal-store-home-'));
  tmpRoots.push(home);
  return home;
}

function writeStoreFile(home: string, value: unknown): void {
  const filePath = principalStorePath(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    filePath,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );
}

function validStore(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, principals: [], ...overrides };
}

describe('PrincipalStore — fail-closed reads', () => {
  test('a MISSING file reads as the empty store (absence is not corruption)', () => {
    const store = new PrincipalStore(createHome());
    expect(store.read()).toEqual({ schemaVersion: 1, principals: [] });
    expect(store.list()).toEqual([]);
  });

  test('a corrupt file THROWS instead of silently reading as empty', () => {
    const home = createHome();
    writeStoreFile(home, '{ not json');
    expect(() => new PrincipalStore(home).read()).toThrow(
      JsonFileStoreCorruptionError,
    );
  });

  test('a corrupt file is never overwritten by an attempted recordSeen', async () => {
    const home = createHome();
    const corruptBytes = '{ not json';
    writeStoreFile(home, corruptBytes);

    await expect(
      new PrincipalStore(home).recordSeen({
        id: 'human:tailscale-serve:brian@example.test',
        kind: 'human',
        display: 'Brian',
      }),
    ).rejects.toThrow(JsonFileStoreCorruptionError);
    expect(new PrincipalStore(home).path).toBe(principalStorePath(home));
  });

  test('an unknown schemaVersion is refused by name', () => {
    const home = createHome();
    writeStoreFile(home, validStore({ schemaVersion: 2 }));
    expect(() => new PrincipalStore(home).read()).toThrow(
      /schemaVersion: unknown or absent \(expected 1, got 2\)/,
    );
  });

  test('one malformed principal (bad kind) fails the whole read — a dropped row is a silent capability loss', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        principals: [
          {
            id: 'human:tailscale-serve:brian@example.test',
            kind: 'human',
            display: 'Brian',
            firstSeenAt: '2026-08-24T00:00:00.000Z',
          },
          {
            id: 'service:invoke-user',
            kind: 'nonsense',
            display: 'x',
            firstSeenAt: '2026-08-24T00:00:00.000Z',
          },
        ],
      }),
    );
    const store = new PrincipalStore(home);
    expect(() => store.read()).toThrow(PrincipalStoreShapeError);
    expect(() => store.read()).toThrow(/principals\[1\]\.kind/);
    // The valid row is not quietly returned on its own.
    expect(() =>
      store.find('human:tailscale-serve:brian@example.test'),
    ).toThrow(PrincipalStoreShapeError);
  });

  test('FINDING 1 (read-time): a well-typed id whose grammar does not match its declared kind fails the read', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        principals: [
          {
            // A service-shaped id declared as kind 'human' — a bare
            // non-empty-string check would previously have accepted this.
            id: 'service:invoke-user',
            kind: 'human',
            display: 'x',
            firstSeenAt: '2026-08-24T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(() => new PrincipalStore(home).read()).toThrow(
      /principals\[0\]\.id: does not match the 'human' id grammar/,
    );
  });

  test('FINDING 3c: firstSeenAt must be a real ISO-8601 instant, not any nonblank string', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        principals: [
          {
            id: 'service:invoke-user',
            kind: 'service',
            display: 'Invoke API',
            firstSeenAt: 'not-a-real-timestamp',
          },
        ],
      }),
    );
    expect(() => new PrincipalStore(home).read()).toThrow(
      /principals\[0\]\.firstSeenAt: must be an ISO-8601 UTC instant/,
    );
  });

  test('N3: an impossible calendar date rolls via Date.parse and must be REJECTED — a regex-only check let it through', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        principals: [
          {
            id: 'service:invoke-user',
            kind: 'service',
            display: 'Invoke API',
            // Date.parse silently rolls this to 2026-03-03; the round-trip
            // check catches that the re-serialized instant differs.
            firstSeenAt: '2026-02-31T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(() => new PrincipalStore(home).read()).toThrow(
      /principals\[0\]\.firstSeenAt: must be an ISO-8601 UTC instant/,
    );
  });

  test('N3 (discriminating control): a genuinely valid ISO-8601 instant is accepted', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        principals: [
          {
            id: 'service:invoke-user',
            kind: 'service',
            display: 'Invoke API',
            firstSeenAt: '2026-08-24T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(() => new PrincipalStore(home).read()).not.toThrow();
  });

  test('N2 (read-time): an empty or whitespace-only display fails the whole read', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        principals: [
          {
            id: 'service:invoke-user',
            kind: 'service',
            display: '   ',
            firstSeenAt: '2026-08-24T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(() => new PrincipalStore(home).read()).toThrow(
      /principals\[0\]\.display: must be a non-empty, non-whitespace-only string/,
    );
  });

  test('a duplicate principal id is refused', () => {
    const home = createHome();
    writeStoreFile(
      home,
      validStore({
        principals: [
          {
            id: 'service:invoke-user',
            kind: 'service',
            display: 'Invoke API',
            firstSeenAt: '2026-08-24T00:00:00.000Z',
          },
          {
            id: 'service:invoke-user',
            kind: 'service',
            display: 'Invoke API (again)',
            firstSeenAt: '2026-08-24T00:01:00.000Z',
          },
        ],
      }),
    );
    expect(() => new PrincipalStore(home).read()).toThrow(
      /principals\[1\]\.id: duplicate principal id/,
    );
  });
});

describe('PrincipalStore — recordSeen (first-seen, display)', () => {
  test('records a new principal with firstSeenAt from the injected clock', async () => {
    const home = createHome();
    const store = new PrincipalStore(home, {
      now: () => new Date('2026-08-24T00:00:00.000Z'),
    });
    const record = await store.recordSeen({
      id: 'service:invoke-user',
      kind: 'service',
      display: 'Invoke API',
    });
    expect(record).toEqual({
      id: 'service:invoke-user',
      kind: 'service',
      display: 'Invoke API',
      firstSeenAt: '2026-08-24T00:00:00.000Z',
    });
    expect(store.list()).toEqual([record]);
  });

  test('a later sighting refreshes display but NEVER rewrites firstSeenAt', async () => {
    const home = createHome();
    let now = new Date('2026-08-24T00:00:00.000Z');
    const store = new PrincipalStore(home, { now: () => now });
    const first = await store.recordSeen({
      id: 'human:tailscale-serve:brian@example.test',
      kind: 'human',
      display: 'Brian',
    });
    now = new Date('2026-08-24T05:00:00.000Z');
    const second = await store.recordSeen({
      id: 'human:tailscale-serve:brian@example.test',
      kind: 'human',
      display: 'Brian Anderson',
    });
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.display).toBe('Brian Anderson');
    expect(store.list()).toHaveLength(1);
  });

  test('distinct principals do not clobber one another', async () => {
    const home = createHome();
    const store = new PrincipalStore(home);
    await store.recordSeen({
      id: 'service:invoke-user',
      kind: 'service',
      display: 'Invoke API',
    });
    await store.recordSeen({
      id: 'service:chat-title-generator',
      kind: 'service',
      display: 'Chat title generator',
    });
    const ids = store
      .list()
      .map((principal) => principal.id)
      .sort();
    expect(ids).toEqual([
      'service:chat-title-generator',
      'service:invoke-user',
    ]);
  });

  test('rejects a principal with an empty id rather than persisting an unfindable record', async () => {
    const home = createHome();
    const store = new PrincipalStore(home);
    await expect(
      store.recordSeen({ id: '', kind: 'service', display: 'Nope' }),
    ).rejects.toThrow(TypeError);
    expect(store.list()).toEqual([]);
  });

  test('N2: recordSeen(humanPrincipal-with-empty-display) is unreachable — the constructor itself throws before recordSeen could ever be called', () => {
    expect(() => humanPrincipal('tailscale-serve', 'brian', '')).toThrow(
      InvalidPrincipalComponentError,
    );
  });

  test('N2 (belt for hand-built refs): recordSeen rejects a hand-built principal with an empty display, rather than persisting a row its own reader would then reject', async () => {
    const home = createHome();
    const store = new PrincipalStore(home);
    await expect(
      store.recordSeen({
        id: 'service:invoke-user',
        kind: 'service',
        display: '',
      }),
    ).rejects.toThrow(TypeError);
    expect(store.list()).toEqual([]);
    // The store must still be readable — nothing was persisted.
    expect(() => store.read()).not.toThrow();
  });

  test('N2: a whitespace-only display is rejected the same way', async () => {
    const home = createHome();
    const store = new PrincipalStore(home);
    await expect(
      store.recordSeen({
        id: 'service:invoke-user',
        kind: 'service',
        display: '   ',
      }),
    ).rejects.toThrow(TypeError);
    expect(store.list()).toEqual([]);
  });

  test('FINDING 3b: rejects a principal whose id grammar does not match its kind, rather than persisting a row its own reader would then reject', async () => {
    const home = createHome();
    const store = new PrincipalStore(home);
    await expect(
      store.recordSeen({
        // Not namespaced at all — a bare id-nonempty check would have
        // accepted this and then bricked the store on the next read.
        id: 'not-namespaced',
        kind: 'human',
        display: 'x',
      }),
    ).rejects.toThrow(TypeError);
    expect(store.list()).toEqual([]);
    // The store must still be readable — nothing was persisted.
    expect(() => store.read()).not.toThrow();
  });

  test('FINDING 3a (defense in depth): the conflict guard fires when a stored row is inconsistent with an incoming, well-formed principal of the same id', async () => {
    // Reachability note: Finding 1's id grammar ties an id's prefix to its
    // OWN kind, and this store's `read()` independently re-validates that
    // for every stored row (Finding 1, read-time) — together, given Finding
    // 3b also validates every INCOMING principal the same way, two
    // independently grammar-valid PrincipalRefs that share an id string
    // necessarily share a kind. A genuine cross-kind collision is therefore
    // unreachable through the public API today. This test overrides the
    // instance's own `read()` to return a raw, unvalidated row — simulating
    // "read-time validation had a gap" (a hand-edited file, or a future
    // grammar change) — to prove the guard is a real second layer of
    // defense, per the review ruling, not inert code kept for show.
    const home = createHome();
    const store = new PrincipalStore(home);
    (store as unknown as { read(): unknown }).read = () => ({
      schemaVersion: 1,
      principals: [
        {
          id: 'human:local:operator',
          kind: 'service', // inconsistent with its own 'human:' id prefix
          display: 'Stale',
          firstSeenAt: '2026-08-24T00:00:00.000Z',
        },
      ],
    });

    await expect(
      store.recordSeen({
        id: 'human:local:operator',
        kind: 'human',
        display: 'Operator',
      }),
    ).rejects.toThrow(PrincipalConflictError);
  });

  test('FINDING 3a: a same-kind upsert on the same id still refreshes display (not blocked by the conflict guard)', async () => {
    const home = createHome();
    const store = new PrincipalStore(home);
    await store.recordSeen({
      id: 'service:invoke-user',
      kind: 'service',
      display: 'Invoke API',
    });
    const updated = await store.recordSeen({
      id: 'service:invoke-user',
      kind: 'service',
      display: 'Invoke API (renamed)',
    });
    expect(updated.display).toBe('Invoke API (renamed)');
    expect(updated.kind).toBe('service');
  });

  test('FINDING 4: the fresh read happens INSIDE the lock — an interleaved write from another store instance is observed, not clobbered', async () => {
    const home = createHome();

    // The FIRST lock acquisition (recordSeen's own) blocks until the test
    // explicitly releases it, simulating another writer holding the file
    // lock while this store is waiting to acquire it.
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let acquireCount = 0;
    const store = new PrincipalStore(home, {
      acquireMutationLock: async () => {
        acquireCount += 1;
        if (acquireCount === 1) {
          await blocked;
        }
        return () => {};
      },
    });

    const recordSeenPromise = store.recordSeen({
      id: 'service:invoke-user',
      kind: 'service',
      display: 'Invoke API',
    });

    // While the above is still waiting on its lock, a SECOND store instance
    // (the REAL cross-process lock, uncontended) commits a different
    // principal directly to the same file.
    const other = new PrincipalStore(home);
    await other.recordSeen({
      id: 'service:chat-title-generator',
      kind: 'service',
      display: 'Chat title generator',
    });

    unblock!();
    await recordSeenPromise;

    // If the fresh read had happened ABOVE lock acquisition, `store` would
    // have captured the pre-interleaving (empty) state and overwritten the
    // file with only its own record, losing the other write.
    const ids = store
      .list()
      .map((principal) => principal.id)
      .sort();
    expect(ids).toEqual([
      'service:chat-title-generator',
      'service:invoke-user',
    ]);
  });
});
