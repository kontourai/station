import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readCorruptionMarker } from '@kontourai/station-shared/sqlite-corruption-marker';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import {
  createSchedulerLedger,
  type SchedulerLedger,
  SchedulerStorageCorruptError,
  SchedulerStorageUnavailableError,
} from '../scheduler-ledger.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number },
  ) => {
    exec(sql: string): void;
    close(): void;
  };
};

/**
 * archive#3220. Real corrupt bytes on a real store, never a thrown fixture.
 *
 * The scenario is the one the ledger's boot `quick_check` structurally cannot
 * see: a store that opens healthy and goes bad while Station is running. So
 * nothing here stubs the integrity seam — the real check runs against an
 * undamaged file and passes, and only then are the bytes destroyed.
 *
 * Two things this deliberately does NOT claim, because SQLite does not owe
 * them and pretending otherwise would be a test that lies:
 *
 *  - The store is larger than SQLite's default page cache (~2MB). A smaller
 *    one is served entirely from memory after the schema upgrade scans it, so
 *    every query returns stale good pages and the whole file passes while
 *    proving nothing. Measured: at ~500KB `create`, `update` and `list` all
 *    still succeed after the file has been overwritten.
 *  - Not every operation NOTICES. An INSERT or DELETE resolved from cached
 *    index pages can still report success on a wrecked file — and would then
 *    tell the user their job exists. That is why classification alone was not
 *    enough and the ledger latches once SQLite has said the file is damaged;
 *    see 'a store already proved corrupt stops answering "created"'. Each
 *    operation below is exercised as the FIRST call after the damage, against
 *    its own freshly seeded store, rather than riding on cache eviction left
 *    behind by the assertion before it.
 */
const SEEDED_JOBS = 400;
const SEEDED_PROMPT_BYTES = 25_000;
const CORRUPT = { kind: 'unavailable', reason: 'corrupt' } as const;
const TRANSIENT = { kind: 'unavailable', reason: 'transient' } as const;

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'scheduler-ledger-corruption-'));
  databasePath = join(directory, 'scheduler.sqlite');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function seedLargeLedger(): void {
  const ledger = createSchedulerLedger({ directory });
  for (let index = 0; index < SEEDED_JOBS; index += 1) {
    ledger.create({
      name: `job-${index}`,
      prompt: `payload ${index} ${'x'.repeat(SEEDED_PROMPT_BYTES)}`,
      enabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }
  ledger.close();
  expect(statSync(databasePath).size).toBeGreaterThan(4 * 1024 * 1024);
}

/** Destroys every page after the header, leaving the file openable. */
function damagePagesAfterHeader(): void {
  const bytes = readFileSync(databasePath);
  bytes.fill(0x5a, 8192, bytes.byteLength);
  writeFileSync(databasePath, bytes);
}

/** A live ledger over a store that was healthy at open and is now wrecked. */
function openThenDamage(): SchedulerLedger {
  seedLargeLedger();
  const ledger = createSchedulerLedger({ directory });
  damagePagesAfterHeader();
  return ledger;
}

function closeQuietly(ledger: SchedulerLedger): void {
  try {
    ledger.close();
  } catch {
    // Closing a handle onto damaged bytes is allowed to fail.
  }
}

function newJob(name: string) {
  return {
    name,
    prompt: 'run',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('SchedulerLedger tells damaged bytes apart from a busy store', () => {
  test.each([
    [
      'update',
      (ledger: SchedulerLedger) => ledger.update('job-1', { enabled: true }),
    ],
    ['list', (ledger: SchedulerLedger) => ledger.list()],
    ['listViews', (ledger: SchedulerLedger) => ledger.listViews()],
    ['claimDue', (ledger: SchedulerLedger) => ledger.claimDue(Date.now())],
    [
      'claimManual',
      (ledger: SchedulerLedger) => ledger.claimManual('job-1', Date.now()),
    ],
  ])(
    '%s reports corruption rather than an unavailable store',
    (_name, call) => {
      const ledger = openThenDamage();
      try {
        expect(call(ledger)).toEqual(CORRUPT);
      } finally {
        closeQuietly(ledger);
      }
    },
  );

  test('a store already proved corrupt stops answering "created"', () => {
    // The review reproduction. Before the latch this sequence returned
    // `{kind:'created'}` — a 200 and "Job 'x' created" — from a process that
    // had ALREADY written the corruption marker four lines earlier, for a job
    // the next boot's `quick_check` refuses to even open. SQLite can satisfy
    // an INSERT from cached index pages on a wrecked file, so the absence of
    // an error here is not evidence of durability.
    const ledger = openThenDamage();
    try {
      expect(ledger.update('job-1', { enabled: true })).toEqual(CORRUPT);
      expect(readCorruptionMarker(databasePath)).not.toBeNull();

      expect(ledger.create(newJob('after-damage'))).toEqual(CORRUPT);
      expect(ledger.remove('job-2')).toEqual(CORRUPT);
      expect(ledger.claimManual('job-1', Date.now())).toEqual(CORRUPT);
      expect(ledger.claimDue(Date.now())).toEqual(CORRUPT);
    } finally {
      closeQuietly(ledger);
    }
  });

  test('a receipt claimed before the damage cannot open its invocation fence', () => {
    // The delta-review reproduction. A run claimed while the store was healthy
    // walks in the side door: `claimDue`/`claimManual` guard the front one, but
    // this receipt is already in memory. `beginInvocation` is what authorizes
    // the adapter call, and SQLite served that write from cached pages — so
    // Station invoked a real unattended agent behind a fence in bytes the next
    // boot refuses to open, and nothing recorded the run.
    seedLargeLedger();
    const ledger = createSchedulerLedger({ directory });
    try {
      const claim = ledger.claimManual('job-1', Date.now());
      if (claim.kind !== 'claimed') throw new Error('expected a healthy claim');

      damagePagesAfterHeader();
      expect(ledger.update('job-2', { enabled: true })).toEqual(CORRUPT);
      expect(readCorruptionMarker(databasePath)).not.toBeNull();

      expect(claim.receipt.beginInvocation()).toEqual(CORRUPT);
    } finally {
      closeQuietly(ledger);
    }
  });

  test('a transient failure does not latch a healthy store shut', () => {
    // The latch's own negative control. It must arm on damaged bytes only —
    // a store that merely lost a race has to keep working once the lock goes,
    // or one contended write would take the scheduler down until restart.
    const ledger = createSchedulerLedger({ directory, busyTimeoutMs: 10 });
    const peer = new DatabaseSync(databasePath, { timeout: 10 });
    peer.exec('BEGIN IMMEDIATE');
    try {
      expect(ledger.create(newJob('during-lock'))).toEqual(TRANSIENT);
      peer.exec('ROLLBACK');
      expect(ledger.create(newJob('after-lock'))).toEqual({ kind: 'created' });
    } finally {
      peer.close();
      closeQuietly(ledger);
    }
  });

  test('the observation reaches the durable marker', () => {
    const ledger = openThenDamage();
    try {
      expect(readCorruptionMarker(databasePath)).toBeNull();
      expect(ledger.update('job-1', { enabled: true })).toEqual(CORRUPT);

      // Same marker archive#3215 defines. Nothing reads it yet — archive#3217
      // is building the first consumer — so this asserts the record exists and
      // is accurate, not that anything acts on it.
      const marker = readCorruptionMarker(databasePath);
      expect(marker).not.toBeNull();
      expect(marker?.databasePath).toBe(
        // Canonical, not the string handed in — the marker resolves the
        // directory so two runtimes spelling one home differently still
        // recognise each other's observation (archive#3215).
        join(realpathSync(dirname(databasePath)), basename(databasePath)),
      );
      expect([11, 26]).toContain(marker?.errcode);
    } finally {
      closeQuietly(ledger);
    }
  });

  test('a real write lock still reports a transient outcome and no marker', () => {
    // The negative control, and the reason this change is safe at all: without
    // it, a classifier that answered "corrupt" to every failure would pass
    // every test above and look correct, while quarantining healthy stores.
    const ledger = createSchedulerLedger({ directory, busyTimeoutMs: 10 });
    const peer = new DatabaseSync(databasePath, { timeout: 10 });
    peer.exec('BEGIN IMMEDIATE');
    try {
      expect(ledger.create(newJob('locked'))).toEqual(TRANSIENT);
      expect(readCorruptionMarker(databasePath)).toBeNull();
    } finally {
      try {
        peer.exec('ROLLBACK');
      } catch {
        // The lock is released by the close below either way.
      }
      peer.close();
      closeQuietly(ledger);
    }
  });

  test('a closed handle is transient, not damage', () => {
    const ledger = createSchedulerLedger({ directory });
    ledger.close();
    expect(ledger.create(newJob('closed'))).toEqual(TRANSIENT);
    expect(readCorruptionMarker(databasePath)).toBeNull();
  });

  test('a store that is already damaged at boot leaves a marker', () => {
    // The other discovery path. Recording only the runtime one would leave the
    // commonest case — a store already damaged at start — with no diagnostic
    // record at all.
    writeFileSync(databasePath, 'not a sqlite database');
    expect(() => createSchedulerLedger({ directory })).toThrow(
      SchedulerStorageCorruptError,
    );
    const marker = readCorruptionMarker(databasePath);
    expect(marker?.databasePath).toBe(
      // Canonical, not the string handed in — the marker resolves the
      // directory so two runtimes spelling one home differently still
      // recognise each other's observation (archive#3215).
      join(realpathSync(dirname(databasePath)), basename(databasePath)),
    );
    // These bytes make `PRAGMA quick_check` THROW, so the connection watch is
    // what recorded this one — hence the result code.
    expect([11, 26]).toContain(marker?.errcode);
  });

  test('a quick_check that reports damage without throwing still leaves a marker', () => {
    // The discriminating case for the boot-path record, and the reason it is
    // not redundant with the watch: `quick_check` answers a damaged b-tree
    // with rows describing it rather than an exception, so nothing throws and
    // the connection watch never sees anything. Removing the explicit record
    // is invisible to the fixture above and caught only here.
    const ledger = createSchedulerLedger({ directory });
    ledger.close();
    expect(() =>
      createSchedulerLedger({
        directory,
        integrityCheck: () => ({ kind: 'corrupt' }),
      }),
    ).toThrow(SchedulerStorageCorruptError);
    const marker = readCorruptionMarker(databasePath);
    expect(marker?.databasePath).toBe(
      // Canonical, not the string handed in — the marker resolves the
      // directory so two runtimes spelling one home differently still
      // recognise each other's observation (archive#3215).
      join(realpathSync(dirname(databasePath)), basename(databasePath)),
    );
    expect(marker?.errcode).toBeUndefined();
  });
});

describe('BuiltinScheduler acts on the difference', () => {
  const turnAdapter = {
    invoke: vi.fn(async () => ({ kind: 'completed' as const, output: 'ok' })),
  };

  async function stopQuietly(scheduler: BuiltinScheduler): Promise<void> {
    try {
      await scheduler.stop();
    } catch {
      // Closing a handle onto damaged bytes is allowed to fail.
    }
  }

  test.each([
    ['listJobs', (scheduler: BuiltinScheduler) => scheduler.listJobs()],
    ['getStats', (scheduler: BuiltinScheduler) => scheduler.getStats()],
    [
      'editJob',
      (scheduler: BuiltinScheduler) =>
        scheduler.editJob('job-1', { enabled: true }),
    ],
  ])(
    '%s raises the actionable corrupt error, not "temporarily unavailable"',
    async (_name, call) => {
      const scheduler = new BuiltinScheduler({
        ledger: openThenDamage(),
        turnAdapter,
      });
      try {
        await expect(call(scheduler)).rejects.toThrow(
          SchedulerStorageCorruptError,
        );
        // Scoped claim: the API error names the repair, where 503
        // "temporarily unavailable" told an operator to wait for a store that
        // waiting cannot fix. It does NOT reach the Schedule page —
        // `src-ui/src/views/ScheduleView.tsx` renders a hardcoded "Scheduler
        // Unavailable / Check that the server is running" whenever both its
        // queries error, discarding status and body. Deliberately out of scope
        // here; filed as follow-up (archive#3220 review, HIGH-2).
        await expect(call(scheduler)).rejects.toThrow(
          /restore a validated backup/,
        );
      } finally {
        await stopQuietly(scheduler);
      }
    },
  );

  test('a locked ledger still raises the retryable error', async () => {
    const ledger = createSchedulerLedger({ directory, busyTimeoutMs: 10 });
    const scheduler = new BuiltinScheduler({ ledger, turnAdapter });
    const peer = new DatabaseSync(databasePath, { timeout: 10 });
    peer.exec('BEGIN IMMEDIATE');
    try {
      const rejection = await scheduler
        .addJob({ name: 'locked', prompt: 'run' })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(rejection).toBeInstanceOf(SchedulerStorageUnavailableError);
      expect(rejection).not.toBeInstanceOf(SchedulerStorageCorruptError);
    } finally {
      try {
        peer.exec('ROLLBACK');
      } catch {
        // The lock is released by the close below either way.
      }
      peer.close();
      await stopQuietly(scheduler);
    }
  });

  test('the not-invoked retry loop gives up on a damaged store instead of spinning', async () => {
    // The loop retains one exact capability across transient SQLite ambiguity
    // by asking again every 25-250ms until `stop()`. Against damaged bytes
    // that is an unbounded hot loop on a store that will never answer, so the
    // corrupt verdict has to end it the way the stopping path does.
    seedLargeLedger();
    const ledger = createSchedulerLedger({ directory });
    const scheduler = new BuiltinScheduler({
      ledger,
      turnAdapter: {
        invoke: async () => {
          // Damage arrives mid-flight, after the claim already exists.
          damagePagesAfterHeader();
          return {
            kind: 'definitely-not-invoked' as const,
            error: 'adapter refused before invocation',
          };
        },
      },
    });
    try {
      await scheduler.addJob({ name: 'not-invoked', prompt: 'run' });
      const settled = await Promise.race([
        scheduler.runJob('not-invoked'),
        new Promise<{ outcome: string; message: string }>((resolve) =>
          setTimeout(
            () => resolve({ outcome: 'still-retrying', message: '' }),
            2_000,
          ),
        ),
      ]);
      expect(settled.outcome).toBe('indeterminate');
      // The string the operator reads on the run. "(scheduler receipt
      // unavailable)" was the old text for both damage and contention, and it
      // is the only clue this run carries about why it stopped.
      expect(settled.message).toContain('scheduler storage corrupt');
    } finally {
      await stopQuietly(scheduler);
    }
  });

  function recordingLogger() {
    return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  }

  /**
   * Settlement happens after the adapter has returned, so a store that goes
   * bad (or busy) DURING the run reaches it with the receipt already in hand.
   * `disrupt` runs inside `invoke`, which is the one seam between claiming and
   * settling.
   */
  async function runWithDisruption(
    disrupt: () => void,
    // Which settlement the run reaches. A completed turn settles through the
    // "X is <word>" frame; a throwing one settles through the parenthetical
    // frame. They are different strings built by different helpers, so a test
    // for one proves nothing about the other — FI-J found exactly that.
    adapterOutcome: 'completed' | 'throws' = 'completed',
  ): Promise<string> {
    seedLargeLedger();
    const ledger = createSchedulerLedger({ directory, busyTimeoutMs: 10 });
    const scheduler = new BuiltinScheduler({
      ledger,
      turnAdapter: {
        invoke: async () => {
          disrupt();
          if (adapterOutcome === 'throws') throw new Error('adapter exploded');
          return { kind: 'completed' as const, output: 'ok' };
        },
      },
    });
    try {
      const receipt = await scheduler.runJob('job-1');
      return receipt.message;
    } finally {
      await stopQuietly(scheduler);
    }
  }

  test('a settlement onto damaged bytes says corrupt, not unavailable', async () => {
    expect(await runWithDisruption(damagePagesAfterHeader)).toContain(
      'Scheduler receipt settlement is corrupt',
    );
  });

  test('a settlement that merely lost a race keeps saying unavailable', async () => {
    // The other branch, and the one that must NOT change wording: two Stations
    // sharing a home contend on settlements routinely, and telling that
    // operator their storage is corrupt is this issue's defect inverted.
    let peer: InstanceType<typeof DatabaseSync> | undefined;
    try {
      const message = await runWithDisruption(() => {
        peer = new DatabaseSync(databasePath, { timeout: 10 });
        peer.exec('BEGIN IMMEDIATE');
      });
      expect(message).toContain('Scheduler receipt settlement is unavailable');
      expect(message).not.toContain('corrupt');
    } finally {
      try {
        peer?.exec('ROLLBACK');
      } catch {
        // The close below releases the lock either way.
      }
      peer?.close();
    }
  });

  test('a run whose store goes bad after claiming never reaches the adapter', async () => {
    // The end of the HIGH-3 tail, driven through the real execution path: the
    // point of refusing the fence is that no unattended agent runs behind it.
    // The ledger wrapper damages the store in the one window the production
    // sequence leaves — after `claimManual` returns a receipt, before
    // `executeSchedulerJobAttempt` opens the fence.
    seedLargeLedger();
    const ledger = createSchedulerLedger({ directory });
    const invoke = vi.fn(async () => ({
      kind: 'completed' as const,
      output: 'ok',
    }));
    // Delegates every operation to the real ledger and overrides exactly one.
    // A spread would drop the prototype methods instead of forwarding them,
    // which only looks harmless while this test happens not to call them.
    const damagingLedger = new Proxy(ledger, {
      get(target: any, prop: string | symbol) {
        if (prop === 'claimManual') {
          return (name: string, now: number) => {
            const claim = target.claimManual(name, now);
            damagePagesAfterHeader();
            // Arm the latch the way any other statement would have.
            target.update('job-2', { enabled: true });
            return claim;
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as SchedulerLedger;
    const scheduler = new BuiltinScheduler({
      ledger: damagingLedger,
      turnAdapter: { invoke },
    });
    try {
      const receipt = await scheduler.runJob('job-1');
      expect(invoke).not.toHaveBeenCalled();
      expect(receipt.outcome).toBe('indeterminate');
      expect(receipt.message).toContain(
        'Scheduler receipt invocation is corrupt',
      );
    } finally {
      await stopQuietly(scheduler);
    }
  });

  test('a failed run settling onto damaged bytes says corrupt', async () => {
    expect(await runWithDisruption(damagePagesAfterHeader, 'throws')).toContain(
      'scheduler storage corrupt',
    );
  });

  test('a failed run settling under a lock keeps saying unavailable', async () => {
    // The branch FI-J proved was unreachable from my first attempt at this
    // coverage: I had tested the completed-turn frame twice and the throwing
    // one not at all, so hardcoding this helper to "corrupt" passed the suite.
    let peer: InstanceType<typeof DatabaseSync> | undefined;
    try {
      const message = await runWithDisruption(() => {
        peer = new DatabaseSync(databasePath, { timeout: 10 });
        peer.exec('BEGIN IMMEDIATE');
      }, 'throws');
      expect(message).toContain('scheduler storage unavailable');
      expect(message).not.toContain('corrupt');
    } finally {
      try {
        peer?.exec('ROLLBACK');
      } catch {
        // The close below releases the lock either way.
      }
      peer?.close();
    }
  });

  test('the tick names the damage instead of reporting a busy store', async () => {
    const logger = recordingLogger();
    const scheduler = new BuiltinScheduler({
      ledger: openThenDamage(),
      turnAdapter,
      logger: logger as never,
    });
    try {
      // `start()` ticks once synchronously before arming its interval.
      scheduler.start();

      expect(logger.error).toHaveBeenCalledWith(
        'Scheduler storage is corrupt; no scheduled job will run until it is restored',
        expect.objectContaining({
          error: expect.stringContaining('restore a validated backup'),
        }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await stopQuietly(scheduler);
    }
  });

  test('a contended tick still warns and never reports an incident', async () => {
    // The other half of that branch, and this issue's own defect run
    // backwards: two Stations sharing a home contend on every tick, and an
    // `instanceof` widened by accident would log "no scheduled job will run
    // until it is restored" once a minute against a perfectly healthy store —
    // telling an operator to restore from backup because a peer held a lock.
    const ledger = createSchedulerLedger({ directory, busyTimeoutMs: 10 });
    const logger = recordingLogger();
    const scheduler = new BuiltinScheduler({
      ledger,
      turnAdapter,
      logger: logger as never,
    });
    const peer = new DatabaseSync(databasePath, { timeout: 10 });
    peer.exec('BEGIN IMMEDIATE');
    try {
      scheduler.start();

      expect(logger.warn).toHaveBeenCalledWith(
        'Scheduler storage unavailable during tick',
        expect.anything(),
      );
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      try {
        peer.exec('ROLLBACK');
      } catch {
        // The lock is released by the close below either way.
      }
      peer.close();
      await stopQuietly(scheduler);
    }
  });
});
