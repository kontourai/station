/**
 * #3600 — two tabs, one shared connection profile.
 *
 * Credential generations used to be per-store memory while the profiles they
 * order are shared through localStorage. Tab A could therefore issue a
 * request, tab B meet a 401 and record `required`, and tab A's older 2xx land
 * carrying a generation that looked current TO TAB A and overwrite it — the
 * lockout ordering `recordAuthenticatedSuccess` already guards within one tab,
 * reachable again across two.
 *
 * Both halves are asserted here because they answer different questions: the
 * shared generation decides what tab A is allowed to WRITE, and the `storage`
 * event decides what tab A SHOWS. A tab that silently keeps rendering
 * "connected" against a store that says `required` is the same contradiction
 * the credential-evidence work exists to remove.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStoreLockManager } from '../core/ConnectionStore';
import { ConnectionStore } from '../core/ConnectionStore';
import type { StorageAdapter } from '../core/types';

const REMOTE = 'https://station.example.test';
const KEY = 'station-connect-connections';
/** The name `ConnectionStore` serializes its shared writes under. */
const STATION_LOCK = `station-connect:${KEY}`;

/**
 * One backing object shared by both stores — what localStorage is to two tabs
 * on the same origin. Writes are visible to the other store immediately; the
 * `storage` EVENT is what the browser delivers separately, and this suite
 * dispatches it by hand exactly where the browser would.
 */
function sharedStorage(): StorageAdapter {
  const values: Record<string, string> = {};
  return {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

function tabs() {
  const storage = sharedStorage();
  const tabA = new ConnectionStore({ storage, storageKey: KEY });
  const connection = tabA.add('Station', REMOTE);
  tabA.setActive(connection.id);
  tabA.markDeviceSession(connection.id);
  const tabB = new ConnectionStore({ storage, storageKey: KEY });
  return { storage, tabA, tabB, id: connection.id };
}

/**
 * Shared storage that keeps every value written to the profile key, so a test
 * can assert what other documents could EVER have observed — not just where
 * the sequence happened to land.
 */
function recordingStorage() {
  const values: Record<string, string> = {};
  const profileWrites: string[] = [];
  const adapter: StorageAdapter = {
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
      if (key === KEY) profileWrites.push(value);
    },
    remove: (key) => {
      delete values[key];
    },
  };
  return {
    adapter,
    /** Every credential state the profile key has ever held for `id`. */
    statesEverWritten(id: string) {
      return profileWrites.map((raw) => {
        const parsed = JSON.parse(raw) as Array<{
          id: string;
          credentialState: string;
        }>;
        return parsed.find((item) => item.id === id)?.credentialState;
      });
    },
    reset: () => {
      profileWrites.length = 0;
    },
  };
}

/** A document that dies before its queued callback runs. */
function neverRunningLocks(): ConnectionStoreLockManager {
  return { request: () => new Promise<never>(() => {}) };
}

function credentialState(store: ConnectionStore, id: string) {
  return store.getAll().find((item) => item.id === id)?.credentialState;
}

/**
 * A Web-Locks-shaped manager standing in for `navigator.locks`, which jsdom
 * does not provide: one exclusive queue, and a handle that lets a test HOLD
 * the lock so two documents' sequences are genuinely overlapping rather than
 * merely consecutive. Without this a single-JS-context test can only run tab
 * operations one after another, which is exactly the gap the review named.
 */
function exclusiveLocks() {
  // One queue PER NAME, like the real Web Locks API — the previous revision
  // shared a single queue, so a lock held under any name blocked the store's
  // own lock and the tests were exercising a stricter world than production
  // (delta review, test gap).
  const queues = new Map<string, Promise<unknown>>();
  const manager: ConnectionStoreLockManager = {
    request(name, callback) {
      const queue = queues.get(name) ?? Promise.resolve();
      const run = queue.then(() => callback());
      queues.set(
        name,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      return run;
    },
  };
  return {
    manager,
    /**
     * Acquires the store's OWN lock and holds it until the returned function
     * is called, so operations issued in the meantime are genuinely queued
     * behind it rather than merely issued in order.
     */
    hold() {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      void manager.request(STATION_LOCK, () => gate);
      return release;
    },
    /** Resolves once every queued sequence has run. */
    idle: async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.all([...queues.values()]);
      }
    },
  };
}

describe('credential generations coordinate across tabs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops tab A's stale acceptance of a credential tab B has since seen rejected", () => {
    const { tabA, tabB, id } = tabs();

    // Tab A issues a request and captures the generation it is authenticated
    // against.
    const generationInTabA = tabA.credentialGeneration(id);

    // Tab B's request meets a 401 first and records the rejection.
    tabB.markCredentialRequired(id, undefined, tabB.credentialGeneration(id));
    expect(credentialState(tabB, id)).toBe('required');

    // Tab A's older 2xx lands.
    tabA.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      generationInTabA,
    );

    expect(
      credentialState(tabB, id),
      "tab A's stale acceptance erased the rejection tab B recorded",
    ).toBe('required');
  });

  it('still accepts a generation captured after the other tab wrote', () => {
    // The mirror case: coordination must not make every cross-tab acceptance
    // unusable, or the shared counter would just be a way to never recover.
    const { tabA, tabB, id } = tabs();

    tabB.markCredentialRequired(id, undefined, tabB.credentialGeneration(id));
    // Tab A issues its request AFTER that, so it carries the newer generation.
    const generationInTabA = tabA.credentialGeneration(id);

    tabA.recordAuthenticatedSuccess(
      id,
      `${REMOTE}/api/settings`,
      generationInTabA,
    );

    expect(credentialState(tabB, id)).toBe('device-session');
  });

  it("observes the other tab's write through the browser's storage event", () => {
    const { tabA, tabB, id } = tabs();
    const off = tabA.observeStorageEvents();
    const notified = vi.fn();
    tabA.subscribe(notified);
    // Tab A has rendered, so its snapshot is cached.
    expect(credentialState(tabA, id)).toBe('device-session');

    tabB.markCredentialRequired(id, undefined, tabB.credentialGeneration(id));
    expect(
      credentialState(tabA, id),
      'the cached snapshot was expected to still be stale here',
    ).toBe('device-session');

    // The browser delivers the event for the other document's write.
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));

    expect(notified).toHaveBeenCalled();
    expect(
      credentialState(tabA, id),
      "tab A kept showing a device session after tab B's 401",
    ).toBe('required');
    off();
  });

  it('ignores a storage event for a key this store does not own', () => {
    const { tabA, id } = tabs();
    const off = tabA.observeStorageEvents();
    expect(credentialState(tabA, id)).toBe('device-session');
    const notified = vi.fn();
    tabA.subscribe(notified);

    window.dispatchEvent(
      new StorageEvent('storage', { key: 'some-other-app-key' }),
    );

    expect(notified).not.toHaveBeenCalled();
    off();
  });

  it('stops observing once the caller disposes the subscription', () => {
    const { tabA, id } = tabs();
    const off = tabA.observeStorageEvents();
    off();
    const notified = vi.fn();
    tabA.subscribe(notified);

    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));

    expect(notified).not.toHaveBeenCalled();
    expect(credentialState(tabA, id)).toBe('device-session');
  });
});

describe('counter mutations are serialized across documents', () => {
  it('makes the second increment observe the first, so a generation never repeats or regresses', async () => {
    // The HIGH finding: a read-modify-write with no cross-document exclusion
    // lets two tabs read the same value and write the same increment, so a
    // generation repeats — and a response captured against it looks current
    // again. Both tabs invalidate while the lock is HELD, so their sequences
    // genuinely overlap.
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    tabA.setActive(connection.id);
    const tabB = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    await locks.idle();
    const before = tabA.credentialGeneration(connection.id);

    const release = locks.hold();
    tabA.markDeviceSession(connection.id);
    tabB.markDeviceSession(connection.id);
    release();
    await locks.idle();

    // Two invalidations, two increments. Under the previous shared-document
    // read-modify-write both tabs wrote `before + 1`.
    expect(tabA.credentialGeneration(connection.id)).toBe(before + 2);
    expect(tabB.credentialGeneration(connection.id)).toBe(before + 2);
  });

  it("never lets a document's own view of a counter go backwards", async () => {
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    tabA.setActive(connection.id);
    await locks.idle();

    const release = locks.hold();
    tabA.markDeviceSession(connection.id);
    // The write is still queued behind the held lock, but a request issued in
    // this same tick must already be authenticated against the invalidated
    // generation — otherwise its 401 would delete the session just paired.
    const captured = tabA.credentialGeneration(connection.id);
    expect(captured).toBeGreaterThan(0);
    release();
    await locks.idle();

    expect(tabA.credentialGeneration(connection.id)).toBeGreaterThanOrEqual(
      captured,
    );
  });

  it('serializes a rejection and an acceptance that overlap, and the rejection stands', async () => {
    // The check-then-mutate half of the finding: another document must not be
    // able to pair or reject between the generation check and the profile
    // write. Both sequences are issued while the lock is held.
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    tabA.setActive(connection.id);
    tabA.markDeviceSession(connection.id);
    const tabB = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    await locks.idle();
    const staleGeneration = tabA.credentialGeneration(connection.id);

    const release = locks.hold();
    // Tab B's request is rejected; tab A's older acceptance lands too.
    tabB.markCredentialRequired(
      connection.id,
      undefined,
      tabB.credentialGeneration(connection.id),
    );
    tabA.recordAuthenticatedSuccess(
      connection.id,
      `${REMOTE}/api/settings`,
      staleGeneration,
    );
    release();
    await locks.idle();

    expect(
      credentialState(tabB, connection.id),
      "tab A's overtaken acceptance erased tab B's rejection",
    ).toBe('required');
  });

  it('works synchronously when the page has no lock manager', () => {
    // Node, SSR, jsdom and a non-secure context all lack `navigator.locks`,
    // and every one of them is a single document — where the synchronous path
    // IS the serialization.
    const storage = sharedStorage();
    const store = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: null,
    });
    const connection = store.add('Station', REMOTE);
    store.setActive(connection.id);
    const before = store.credentialGeneration(connection.id);

    store.markDeviceSession(connection.id);

    expect(store.credentialGeneration(connection.id)).toBe(before + 1);
    expect(credentialState(store, connection.id)).toBe('device-session');
    // And it is in shared storage immediately, not queued behind a microtask.
    const reloaded = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: null,
    });
    expect(reloaded.credentialGeneration(connection.id)).toBe(before + 1);
  });
});
describe('every writer of shared storage takes the same lock', () => {
  /** Shared storage as a third document would read it, with no local view. */
  function sharedView(storage: StorageAdapter, id: string) {
    return new ConnectionStore({ storage, storageKey: KEY, locks: null })
      .getAll()
      .find((item) => item.id === id)?.credentialState;
  }

  it('does not let a queued 401 reporter revert a pairing that happened while it waited', async () => {
    // The delta review's ordering, exactly. A lock that pairing BYPASSES gives
    // no exclusion against the writer that matters most:
    //   1. an old 401's reporter is queued first;
    //   2. another tab pairs — its profile write used to land immediately
    //      while its counter write queued behind the reporter;
    //   3. the reporter takes the lock, still reads the old shared generation,
    //      and flips the freshly paired profile back to `required`.
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    tabA.setActive(connection.id);
    tabA.markDeviceSession(connection.id);
    const tabB = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    await locks.idle();
    // Tab A issued a request against this generation; its 401 is on the way.
    const staleGeneration = tabA.credentialGeneration(connection.id);

    const release = locks.hold();
    void tabA.markCredentialRequired(connection.id, undefined, staleGeneration);
    tabB.markDeviceSession(connection.id);
    release();
    await locks.idle();

    expect(
      sharedView(storage, connection.id),
      "an old 401's reporter undid the pairing that happened while it waited",
    ).toBe('device-session');
    // And the tab that paired is not left rendering something shared storage
    // contradicts.
    expect(credentialState(tabB, connection.id)).toBe('device-session');
  });

  it('keeps a pairing visible to its own document in the SAME tick', async () => {
    // Taking the lock must not make pairing asynchronous: a request issued in
    // the same tick captures the connection, credential and generation from
    // the local view, and would otherwise be authenticated against the
    // pre-pairing snapshot — the race `captureCredentialEvidence` exists to
    // prevent.
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const store = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = store.add('Station', REMOTE);
    store.setActive(connection.id);
    await locks.idle();
    const before = store.credentialGeneration(connection.id);

    const release = locks.hold();
    store.markDeviceSession(connection.id);

    // Synchronously, with the storage write still queued:
    expect(credentialState(store, connection.id)).toBe('device-session');
    expect(store.credentialGeneration(connection.id)).toBeGreaterThan(before);
    release();
    await locks.idle();
    expect(sharedView(storage, connection.id)).toBe('device-session');
  });

  it('adopts shared storage again once nothing of its own is in flight', async () => {
    // The local view is not a cache: it exists only while this document has a
    // queued write, so another tab's later change is never shadowed by it.
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    tabA.setActive(connection.id);
    tabA.markDeviceSession(connection.id);
    const tabB = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    await locks.idle();

    tabB.setCredential(connection.id, 'a-bearer-not-for-production');
    await locks.idle();
    tabA.reload();

    expect(credentialState(tabA, connection.id)).toBe('saved');
  });

  it('hands back the transition so a caller can order itself after it', async () => {
    // What the SDK awaits before resolving a response (delta review, MEDIUM).
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const store = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = store.add('Station', REMOTE);
    store.setActive(connection.id);
    store.markDeviceSession(connection.id);
    await locks.idle();
    store.markCredentialRequired(
      connection.id,
      undefined,
      store.credentialGeneration(connection.id),
    );
    await locks.idle();
    expect(credentialState(store, connection.id)).toBe('required');

    await store.recordAuthenticatedSuccess(
      connection.id,
      `${REMOTE}/api/settings`,
      store.credentialGeneration(connection.id),
    );

    // No `idle()`, no `waitFor`: awaiting the returned transition is enough.
    expect(credentialState(store, connection.id)).toBe('device-session');
  });
});

describe('a stale rejection is SUPPRESSED, not overwritten afterwards', () => {
  function sharedView(storage: StorageAdapter, id: string) {
    return new ConnectionStore({ storage, storageKey: KEY, locks: null })
      .getAll()
      .find((item) => item.id === id)?.credentialState;
  }

  it('never writes `required` at all when a pairing overtakes the reporter', async () => {
    // Delta review 2: the reporter used to take the lock BEFORE the pairing's
    // queued counter bump, read the old shared generation, accept the stale
    // rejection and write `required` — the end state came out right only
    // because the pairing's own profile write landed later and overwrote it.
    // Now the bump is published immediately, so the reporter sees it inside
    // its lock turn and does nothing: no `required` is ever written, and no
    // other document can observe one.
    const locks = exclusiveLocks();
    const storage = recordingStorage();
    const tabA = new ConnectionStore({
      storage: storage.adapter,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    tabA.setActive(connection.id);
    tabA.markDeviceSession(connection.id);
    const tabB = new ConnectionStore({
      storage: storage.adapter,
      storageKey: KEY,
      locks: locks.manager,
    });
    await locks.idle();
    const staleGeneration = tabA.credentialGeneration(connection.id);
    storage.reset();

    const release = locks.hold();
    void tabA.markCredentialRequired(connection.id, undefined, staleGeneration);
    tabB.markDeviceSession(connection.id);
    release();
    await locks.idle();

    expect(
      storage.statesEverWritten(connection.id),
      'a `required` state reached shared storage, even if only transiently',
    ).not.toContain('required');
    expect(sharedView(storage.adapter, connection.id)).toBe('device-session');
  });

  it('leaves the pre-pairing profile durable when the pairing tab dies before its flush', async () => {
    // The durability half. The pairing publishes its invalidation immediately
    // but its profile write is queued; if that tab closes first, shared
    // storage must be left holding the state BEFORE the pairing — never a
    // `required` the stale reporter invented.
    const locks = exclusiveLocks();
    const storage = recordingStorage();
    const tabA = new ConnectionStore({
      storage: storage.adapter,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    tabA.setActive(connection.id);
    tabA.markDeviceSession(connection.id);
    await locks.idle();
    const staleGeneration = tabA.credentialGeneration(connection.id);
    storage.reset();

    // This tab's queued callbacks never run — it is gone.
    const dyingTab = new ConnectionStore({
      storage: storage.adapter,
      storageKey: KEY,
      locks: neverRunningLocks(),
    });
    dyingTab.markDeviceSession(connection.id);
    // Its invalidation still reached shared storage, synchronously.
    expect(tabA.credentialGeneration(connection.id)).toBeGreaterThan(
      staleGeneration,
    );

    await tabA.markCredentialRequired(
      connection.id,
      undefined,
      staleGeneration,
    );
    await locks.idle();

    expect(
      storage.statesEverWritten(connection.id),
      'the reporter wrote a state the pairing tab was no longer alive to undo',
    ).not.toContain('required');
    expect(sharedView(storage.adapter, connection.id)).not.toBe('required');
  });

  it('still records a rejection that is genuinely current', () => {
    // The suppression must be about staleness, not about rejections.
    const storage = recordingStorage();
    const store = new ConnectionStore({
      storage: storage.adapter,
      storageKey: KEY,
      locks: null,
    });
    const connection = store.add('Station', REMOTE);
    store.setActive(connection.id);
    store.markDeviceSession(connection.id);

    store.markCredentialRequired(
      connection.id,
      undefined,
      store.credentialGeneration(connection.id),
    );

    expect(credentialState(store, connection.id)).toBe('required');
  });
});

describe('the residual check-write window is self-correcting (station#3624)', () => {
  /**
   * The floor of this primitive, pinned rather than described.
   *
   * `markCredentialRequired` and `recordAuthenticatedSuccess` re-read the
   * shared generation and write the profile as two adjacent SYNCHRONOUS
   * statements inside their lock turn. A pairing in another document bumps
   * that counter WITHOUT the lock — deliberately, because queueing the bump is
   * what let a stale rejection reach shared storage in the first place (see
   * `bumpCounter`) — so a bump landing between those two statements is not
   * excluded by anything.
   *
   * It cannot be closed here, and the two shapes the issue sketched both fail
   * for the same structural reason:
   *
   *  - `navigator.locks` around the bump as well: a value only the pairing
   *    document can see orders nothing, so the bump would have to be published
   *    from inside the lock turn — the queued shape this replaced, whose
   *    failure (`leaves the pre-pairing profile durable when the pairing tab
   *    dies before its flush`) is pinned above. Broadcasting the value instead
   *    does not help: a `BroadcastChannel` message is delivered in a TASK, and
   *    the window is inside one synchronous block, which no task can enter.
   *  - a transactional store (IndexedDB): every read here is synchronous
   *    (`credentialGeneration`, `getCredential`, `getAll`, the
   *    `useSyncExternalStore` snapshot) and `captureCredentialEvidence` reads
   *    the generation in the same tick as a pairing. An asynchronous store is
   *    only readable through a mirror, and a cached generation is exactly the
   *    staleness #3600 removed.
   *
   * So the contract is not "this cannot happen" — it is "ONE stale report is
   * accepted and the next authenticated response corrects it". That sentence
   * is what these tests hold to.
   */

  /** Shared storage that runs `hook` the first time `key` is READ. */
  function interposingStorage(base: StorageAdapter) {
    let armed: { key: string; hook: () => void } | null = null;
    const adapter: StorageAdapter = {
      get: (key) => {
        const value = base.get(key);
        if (armed && armed.key === key) {
          const { hook } = armed;
          armed = null;
          hook();
        }
        return value;
      },
      set: (key, value) => base.set(key, value),
      remove: (key) => base.remove(key),
    };
    return {
      adapter,
      /**
       * The interleaving itself: the other document's write lands between the
       * reporter's generation READ and its profile WRITE, which is the only
       * place it can do damage.
       */
      interposeOnGenerationRead(id: string, hook: () => void) {
        armed = { key: `${KEY}-generation:${id}`, hook };
      },
    };
  }

  it('accepts ONE stale rejection when a pairing lands inside the window, and the next authenticated response corrects it', async () => {
    const locks = exclusiveLocks();
    const storage = recordingStorage();
    const shared = interposingStorage(storage.adapter);
    const reporter = new ConnectionStore({
      storage: shared.adapter,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = reporter.add('Station', REMOTE);
    reporter.setActive(connection.id);
    reporter.markDeviceSession(connection.id);
    await locks.idle();
    const staleGeneration = reporter.credentialGeneration(connection.id);

    // A pairing tab that does not survive its own queued profile flush, so the
    // stale `required` is not merely overwritten a moment later — this is the
    // case where it is genuinely durable.
    const pairingTab = new ConnectionStore({
      storage: shared.adapter,
      storageKey: KEY,
      locks: neverRunningLocks(),
    });
    shared.interposeOnGenerationRead(connection.id, () => {
      pairingTab.markDeviceSession(connection.id);
    });

    await reporter.markCredentialRequired(
      connection.id,
      undefined,
      staleGeneration,
    );
    await locks.idle();

    // The pairing really did land inside the reporter's lock turn: the lock
    // does not exclude it, which is the whole point.
    expect(reporter.credentialGeneration(connection.id)).toBeGreaterThan(
      staleGeneration,
    );
    // …and the stale report was accepted. This assertion is the floor. If a
    // future change closes the window it fails HERE, which is the signal to
    // rewrite this test rather than to discover the guarantee changed by
    // accident.
    expect(credentialState(reporter, connection.id)).toBe('required');

    // The correction: the next accepted authenticated response retires it.
    await reporter.recordAuthenticatedSuccess(
      connection.id,
      REMOTE,
      reporter.credentialGeneration(connection.id),
    );
    await locks.idle();
    expect(credentialState(reporter, connection.id)).toBe('device-session');
    expect(
      new ConnectionStore({
        storage: shared.adapter,
        storageKey: KEY,
        locks: null,
      })
        .getAll()
        .find((item) => item.id === connection.id)?.credentialState,
      'the correction must reach SHARED storage, not just the reporting tab',
    ).toBe('device-session');
  });

  it('suppresses the same rejection when the pairing lands OUTSIDE the window', async () => {
    // The negative control for the two tests around it. Identical setup and
    // identical pairing — only the moment it lands moves, from between the
    // reporter's generation read and its write to before the read. If this
    // ever also accepted `required`, the tests above would be pinning a
    // permanently broken guard rather than a two-statement window.
    const locks = exclusiveLocks();
    const storage = recordingStorage();
    const shared = interposingStorage(storage.adapter);
    const reporter = new ConnectionStore({
      storage: shared.adapter,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = reporter.add('Station', REMOTE);
    reporter.setActive(connection.id);
    reporter.markDeviceSession(connection.id);
    await locks.idle();
    const staleGeneration = reporter.credentialGeneration(connection.id);

    const pairingTab = new ConnectionStore({
      storage: shared.adapter,
      storageKey: KEY,
      locks: neverRunningLocks(),
    });
    pairingTab.markDeviceSession(connection.id);

    await reporter.markCredentialRequired(
      connection.id,
      undefined,
      staleGeneration,
    );
    await locks.idle();

    expect(reporter.credentialGeneration(connection.id)).toBeGreaterThan(
      staleGeneration,
    );
    expect(credentialState(reporter, connection.id)).not.toBe('required');
  });

  it('corrects a stale acceptance the same way — with the next rejection', async () => {
    // The mirror site. `recordAuthenticatedSuccess` has the identical two
    // adjacent statements, so a rejection recorded by another document inside
    // the window is erased by an acceptance that predates it.
    const locks = exclusiveLocks();
    const storage = recordingStorage();
    const shared = interposingStorage(storage.adapter);
    const reporter = new ConnectionStore({
      storage: shared.adapter,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = reporter.add('Station', REMOTE);
    reporter.setActive(connection.id);
    reporter.markDeviceSession(connection.id);
    await locks.idle();
    reporter.markCredentialRequired(
      connection.id,
      undefined,
      reporter.credentialGeneration(connection.id),
    );
    await locks.idle();
    expect(credentialState(reporter, connection.id)).toBe('required');
    const staleGeneration = reporter.credentialGeneration(connection.id);

    const otherTab = new ConnectionStore({
      storage: shared.adapter,
      storageKey: KEY,
      locks: neverRunningLocks(),
    });
    shared.interposeOnGenerationRead(connection.id, () => {
      otherTab.markDeviceSession(connection.id);
    });

    await reporter.recordAuthenticatedSuccess(
      connection.id,
      REMOTE,
      staleGeneration,
    );
    await locks.idle();
    expect(reporter.credentialGeneration(connection.id)).toBeGreaterThan(
      staleGeneration,
    );
    // The acceptance was applied against a generation the pairing had already
    // superseded — the floor again.
    expect(credentialState(reporter, connection.id)).not.toBe('required');

    // And the next genuinely current rejection re-records it, so no state is
    // stranded.
    await reporter.markCredentialRequired(
      connection.id,
      undefined,
      reporter.credentialGeneration(connection.id),
    );
    await locks.idle();
    expect(credentialState(reporter, connection.id)).toBe('required');
  });
});

describe('a pending local write does not shadow another document', () => {
  it("shows another tab's update for a connection this one has no pending write for", async () => {
    // Delta review 2, MEDIUM: the local view was one whole-list snapshot, so
    // ANY pending local write hid every other connection's shared state — and
    // the eventual flush overwrote it.
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const first = tabA.add('Station A', REMOTE);
    const second = tabA.add('Station B', 'https://other.example.test');
    await locks.idle();
    // A document with no Web Locks (an insecure context) writes immediately.
    const tabB = new ConnectionStore({ storage, storageKey: KEY, locks: null });

    const release = locks.hold();
    tabA.update(first.id, { name: 'Renamed by A' });
    tabB.update(second.id, { name: 'Renamed by B' });
    // The `storage` event another document's write delivers.
    tabA.reload();

    const namesDuring = tabA.getAll();
    expect(
      namesDuring.find((item) => item.id === second.id)?.name,
      "tab A's unrelated pending write hid tab B's update",
    ).toBe('Renamed by B');
    expect(namesDuring.find((item) => item.id === first.id)?.name).toBe(
      'Renamed by A',
    );

    release();
    await locks.idle();

    // And the flush merged rather than republishing a stale snapshot.
    const durable = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: null,
    }).getAll();
    expect(durable.find((item) => item.id === second.id)?.name).toBe(
      'Renamed by B',
    );
    expect(durable.find((item) => item.id === first.id)?.name).toBe(
      'Renamed by A',
    );
  });
});

describe('the overlay claims only what the operation itself changed', () => {
  it('does not republish a connection another document changed mid-operation', async () => {
    // Delta review 3, MEDIUM. A mutation reads, transforms, and writes. If
    // another document changes a DIFFERENT connection in between, the
    // operation's untouched copy of it is stale — and classifying against a
    // freshly read baseline at write time saw that difference as a local
    // change, put it in the overlay, and published the stale copy over the
    // newer one. Classification uses the snapshot the operation was computed
    // from instead, where the untouched connection is byte-identical.
    const locks = exclusiveLocks();
    const values: Record<string, string> = {};
    let interleave: (() => void) | null = null;
    const storage: StorageAdapter = {
      get: (key) => {
        // Read the value FIRST, so the caller receives the pre-interleave
        // state: that staleness is the whole point.
        const value = values[key] ?? null;
        if (key === KEY && interleave) {
          const run = interleave;
          interleave = null;
          run();
        }
        return value;
      },
      set: (key, value) => {
        values[key] = value;
      },
      remove: (key) => {
        delete values[key];
      },
    };
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const x = tabA.add('Station X', REMOTE);
    const y = tabA.add('Station Y', 'https://other.example.test');
    await locks.idle();
    // A document with no Web Locks, so its write lands immediately.
    const tabB = new ConnectionStore({ storage, storageKey: KEY, locks: null });

    const release = locks.hold();
    // Tab B renames Y between tab A's read and tab A's write.
    interleave = () => {
      tabB.update(y.id, { name: 'Renamed by B' });
    };
    tabA.update(x.id, { name: 'Renamed by A' });
    expect(interleave, 'the interleave never fired').toBeNull();
    release();
    await locks.idle();

    const durable = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: null,
    }).getAll();
    expect(
      durable.find((item) => item.id === y.id)?.name,
      'tab A republished its stale copy of a connection it never touched',
    ).toBe('Renamed by B');
    expect(durable.find((item) => item.id === x.id)?.name).toBe('Renamed by A');
  });
});

/**
 * #3626 — a removal has to retire the connection's counter epochs for every
 * document, not merely delete this one's keys.
 *
 * Deleting them is a regression dressed as cleanup: the shared value drops
 * back to 0 while other tabs keep their own `counterView` entry (a `storage`
 * event reloads profiles, never counter views), and the values the removed
 * connection already issued become available again. The counters exist to
 * decide, by EQUALITY against a value captured when a request started,
 * whether an in-flight report is still about the connection in front of the
 * user — so a recycled value is a report about a REMOVED Station being
 * applied to whatever now holds its id.
 *
 * Reachable wherever ids are not freshly minted: the native profile
 * projection and an imported/restored profile both bring an exact id back.
 */
describe("a removal retires the connection's counter epochs globally", () => {
  /**
   * The same id coming back. Externally restored profiles reach the store by
   * writing the profile document itself, which is what this does.
   */
  function restoreSameId(
    storage: StorageAdapter,
    id: string,
    credentialState = 'device-session',
  ): void {
    storage.set(
      KEY,
      JSON.stringify([
        { id, name: 'Station (restored)', url: REMOTE, credentialState },
      ]),
    );
  }

  it('does not let a recreated id climb back onto a generation captured before the removal', () => {
    const { storage, tabA, id } = tabs();
    // A request is in flight, captured against the connection as it is now.
    const capturedBeforeRemoval = tabA.credentialGeneration(id);

    tabA.remove(id);
    restoreSameId(storage, id);
    tabA.reload();
    // The recreated connection is paired, which bumps its generation. From a
    // counter that restarted at zero that walks straight back onto the value
    // the removed connection had already issued.
    tabA.markDeviceSession(id);

    expect(
      tabA.credentialGeneration(id),
      'a recreated id reused a generation the removed connection had already issued',
    ).toBeGreaterThan(capturedBeforeRemoval);

    // ...so the in-flight report about the REMOVED connection is dropped
    // rather than deleting the credential of the one that now holds its id.
    tabA.markCredentialRequired(id, undefined, capturedBeforeRemoval);
    expect(
      credentialState(tabA, id),
      "a removed connection's in-flight rejection was applied to the recreated one",
    ).toBe('device-session');
  });

  it('retires an epoch another tab still holds in its own counter view', () => {
    const { storage, tabA, tabB, id } = tabs();
    // Tab B has written the counter itself, so it holds its own view of it.
    // Nothing a removal in tab A does can clear that view: the browser
    // delivers a `storage` event, and this store's reaction to one is to
    // reload profiles.
    tabB.markDeviceSession(id);
    const capturedInTabB = tabB.credentialGeneration(id);

    tabA.remove(id);
    restoreSameId(storage, id);
    tabB.reload();

    expect(
      tabB.credentialGeneration(id),
      "tab B kept issuing the removed connection's generation",
    ).toBeGreaterThan(capturedInTabB);

    tabB.markCredentialRequired(id, undefined, capturedInTabB);
    expect(
      credentialState(tabB, id),
      "tab B's report about the removed connection was applied to the recreated one",
    ).toBe('device-session');
  });

  it('retires the credential-authority epoch too', () => {
    const { storage, tabA, id } = tabs();
    // The signal a parked probe waits on: it wakes when this CHANGES. A
    // recreated id that restarts the count re-issues values a parked consumer
    // is already holding, so the pairing it is waiting for reads as no news.
    const authorityBeforeRemoval = tabA.credentialAuthorityGeneration(id);

    tabA.remove(id);
    restoreSameId(storage, id, 'required');
    tabA.reload();
    tabA.markDeviceSession(id);

    expect(
      tabA.credentialAuthorityGeneration(id),
      'the recreated id re-issued a credential-authority value a parked consumer already holds',
    ).toBeGreaterThan(authorityBeforeRemoval);
  });

  it("leaves another connection's counters untouched", () => {
    const { tabA } = tabs();
    const other = tabA.add('Other', 'https://other.example.test');
    tabA.markDeviceSession(other.id);
    const generation = tabA.credentialGeneration(other.id);
    const authority = tabA.credentialAuthorityGeneration(other.id);

    tabA.remove(tabA.getAll()[0]!.id);

    expect(tabA.credentialGeneration(other.id)).toBe(generation);
    expect(tabA.credentialAuthorityGeneration(other.id)).toBe(authority);
  });
});

/**
 * #3626 review — the tombstone has to become visible WITH the removal, and the
 * removal has to be durable against a queued write for the same id.
 *
 * Both defects have the same root: a removal used to be two publications with
 * a gap between them (the counters, synchronously; the profile, behind the
 * lock), and the overlay that carries a queued write knew nothing about
 * removals at all.
 */
describe('a removal publishes as one observation', () => {
  /** Shared storage that keeps the full ordered history of every write. */
  function historyStorage() {
    const values: Record<string, string> = {};
    const history: Array<{ key: string; value: string | null }> = [];
    const adapter: StorageAdapter = {
      get: (key) => values[key] ?? null,
      set: (key, value) => {
        values[key] = value;
        history.push({ key, value });
      },
      remove: (key) => {
        delete values[key];
        history.push({ key, value: null });
      },
    };
    return {
      adapter,
      history,
      /**
       * Whether the epoch was retired while the connection was still
       * published — read at the instant the FIRST tombstone was written, which
       * is the only moment another document could observe the two disagreeing.
       * (A later restoration legitimately republishes the id while the
       * tombstone stands; that is the tombstone working, not the defect.)
       */
      retiredWhileStillListed(id: string) {
        let listed = false;
        for (const entry of history) {
          if (entry.key === KEY) {
            listed = (JSON.parse(entry.value ?? '[]') as Array<{ id: string }>)
              .map((item) => item.id)
              .includes(id);
          }
          if (
            entry.key.includes('-retired-') &&
            entry.key.endsWith(id) &&
            entry.value !== null
          ) {
            return listed;
          }
        }
        return false;
      },
    };
  }

  function restoreSameId(storage: StorageAdapter, id: string): void {
    storage.set(
      KEY,
      JSON.stringify([
        {
          id,
          name: 'Station (restored)',
          url: REMOTE,
          credentialState: 'device-session',
        },
      ]),
    );
  }

  it('never retires the epoch while the connection is still published', async () => {
    const locks = exclusiveLocks();
    const storage = historyStorage();
    const tabA = new ConnectionStore({
      storage: storage.adapter,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    tabA.markDeviceSession(connection.id);
    await locks.idle();
    const tabB = new ConnectionStore({
      storage: storage.adapter,
      storageKey: KEY,
      locks: locks.manager,
    });

    const release = locks.hold();
    tabA.remove(connection.id);

    // The removal is queued, so tab B still reads the connection — and a
    // request it issues right now captures the generation of a connection that
    // still exists.
    expect(credentialState(tabB, connection.id)).toBe('device-session');
    const capturedInTabB = tabB.credentialGeneration(connection.id);

    release();
    await locks.idle();
    restoreSameId(storage.adapter, connection.id);
    tabB.reload();

    expect(
      tabB.credentialGeneration(connection.id),
      "tab B's capture became the recreated connection's own generation",
    ).toBeGreaterThan(capturedInTabB);
    expect(
      storage.retiredWhileStillListed(connection.id),
      'a retired epoch was readable while the connection was still published',
    ).toBe(false);
  });

  it('does not let a queued write resurrect a connection another document removed', async () => {
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const connection = tabA.add('Station', REMOTE);
    await locks.idle();
    const tabB = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });

    const release = locks.hold();
    // A removes; B renames the same connection before A's removal is
    // published, so B's flush runs after it with the profile still in its
    // overlay.
    tabA.remove(connection.id);
    tabB.update(connection.id, { name: 'Renamed by B' });
    release();
    await locks.idle();

    const durable = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: null,
    }).getAll();
    expect(
      durable.find((item) => item.id === connection.id),
      'a queued rename re-added the connection the user had removed',
    ).toBeUndefined();
  });

  it('still publishes a connection this document created while a write was queued', async () => {
    // The mirror case: dropping overlay entries that shared storage has not
    // seen must not stop this document from ever adding anything.
    const locks = exclusiveLocks();
    const storage = sharedStorage();
    const tabA = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });
    const existing = tabA.add('Station', REMOTE);
    await locks.idle();
    const tabB = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: locks.manager,
    });

    const release = locks.hold();
    const created = tabB.add('Second', 'https://second.example.test');
    tabA.update(existing.id, { name: 'Renamed by A' });
    release();
    await locks.idle();

    const durable = new ConnectionStore({
      storage,
      storageKey: KEY,
      locks: null,
    }).getAll();
    expect(durable.map((item) => item.id)).toContain(created.id);
    expect(durable.find((item) => item.id === existing.id)?.name).toBe(
      'Renamed by A',
    );
  });
});
