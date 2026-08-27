import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * #1162: a durable write fsync'd a descriptor opened read-only. POSIX allows
 * that, so every test on macOS/Linux passed; Windows implements fsync as
 * FlushFileBuffers, which requires write access and returns EPERM — taking
 * server startup down whenever a migration performed a durable write.
 *
 * The defect is therefore invisible to behavioural assertions on a POSIX CI
 * host. What IS portable is the open mode itself, so that is what this pins.
 */
const opens = vi.hoisted(() => [] as Array<{ path: string; flags: unknown }>);
const fsyncs = vi.hoisted(() => [] as number[]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (path: never, flags: never, ...rest: never[]) => {
      opens.push({ path: String(path), flags });
      return actual.openSync(path, flags, ...rest);
    },
    fsyncSync: (fd: never) => {
      fsyncs.push(fd);
      return actual.fsyncSync(fd);
    },
  };
});

describe('durable write fsync open mode (#1162)', () => {
  let dir: string;

  beforeEach(() => {
    opens.length = 0;
    fsyncs.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'station-fsync-mode-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('never fsyncs a descriptor opened read-only', async () => {
    const { JsonFileStore } = await import('../json-store.js');
    const path = join(dir, 'durable.json');
    const store = new JsonFileStore(
      path,
      { value: 0 },
      { durableAtomicWrite: true },
    );

    store.write({ value: 1 });
    store.write({ value: 2 });

    // A directory open stays read-only on purpose — fsyncDirectory already
    // tolerates failure and a directory cannot be opened 'r+' on Windows at
    // all. Only FILE opens must carry write access.
    // A read-only open is only legitimate for a DIRECTORY: fsyncDirectory
    // already tolerates failure, and a directory cannot be opened 'r+' on
    // Windows at all. Every FILE fsync must hold write access.
    const readOnlyFileOpens = opens
      .filter((entry) => entry.flags === 'r')
      .filter((entry) => {
        try {
          return !statSync(entry.path).isDirectory();
        } catch {
          return true;
        }
      })
      .map((entry) => entry.path);
    expect(readOnlyFileOpens).toEqual([]);
    expect(store.read()).toEqual({ value: 2 });
  });
});

/**
 * station#1686 review round 1, MEDIUM 7: the project-resource shadow record
 * is written once per session start, synchronously, on the event loop. At
 * `crash-safe` durability that is four fsyncs — measured at ~3.6ms each,
 * ~15.4ms per write on this repo's reference host — which is 4.5x the `git`
 * spawn that shadow's own decision 1 already refuses to leave on the
 * session-start stack.
 *
 * A timing assertion would be a flake, so what is pinned is the MECHANISM:
 * the mode changes whether fsync is called at all, while the properties that
 * make the write non-tearing — a complete primary and a retained `.previous`
 * — are identical in both modes.
 */
describe('atomicWriteDurability (station#1686)', () => {
  let dir: string;

  beforeEach(() => {
    opens.length = 0;
    fsyncs.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'station-durability-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeTwice(
    durability?: 'crash-safe' | 'tear-safe',
  ): Promise<{ path: string; fsyncCount: number }> {
    const { JsonFileStore } = await import('../json-store.js');
    const path = join(dir, 'record.json');
    const store = new JsonFileStore(
      path,
      { value: 0 },
      {
        durableAtomicWrite: true,
        ...(durability ? { atomicWriteDurability: durability } : {}),
      },
    );
    store.write({ value: 1 });
    fsyncs.length = 0; // Measure the steady-state write, with a primary present.
    store.write({ value: 2 });
    expect(store.read()).toEqual({ value: 2 });
    return { path, fsyncCount: fsyncs.length };
  }

  test('the default is unchanged: a durable write still fsyncs', async () => {
    // The control. Every pre-existing caller passes no durability at all, so
    // this is what a silent regression to `tear-safe` would break.
    const { fsyncCount } = await writeTwice();
    // The EXACT count, not a floor: the temp file, the retained `.previous`,
    // and the directory after each of the two renames. A `> 0` floor would
    // let three of the four go missing unnoticed.
    expect(fsyncCount).toBe(4);
  });

  test('`crash-safe` names the same behavior explicitly', async () => {
    const { fsyncCount } = await writeTwice('crash-safe');
    expect(fsyncCount).toBe(4);
  });

  test('`tear-safe` performs NO fsync', async () => {
    const { fsyncCount } = await writeTwice('tear-safe');
    expect(fsyncCount).toBe(0);
  });

  test('an unrecognised durability value keeps its fsyncs (fails CLOSED)', async () => {
    // Round 2, LOW 4. Spelled as `=== 'crash-safe'` the check was fail-OPEN:
    // anything that is not exactly that literal silently degraded to no
    // fsync. Today only two literals exist so the two tests above cannot tell
    // the spellings apart — this one can, and it is what makes a third mode
    // (or a value arriving from config) safe to add.
    const { fsyncCount } = await writeTwice(
      'durable-plus' as unknown as 'crash-safe',
    );
    expect(fsyncCount).toBe(4);
  });

  test('`tear-safe` still writes a complete primary and retains `.previous`', async () => {
    // The half that must NOT change: dropping the atomic rename or the
    // retained prior value would make a record `unreadable`, which for the
    // shadow record destroys every observation it ever accumulated — a far
    // worse failure than the power-loss window `tear-safe` accepts.
    const { path } = await writeTwice('tear-safe');
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ value: 2 });
    expect(JSON.parse(readFileSync(`${path}.previous`, 'utf-8'))).toEqual({
      value: 1,
    });
    // An EXACT set, not "no .tmp files" (round 2, LOW 3). The original form
    // asserted on a fixed `.record.json.tmp`, which cannot exist in any mode
    // — the temp name carries the pid and a random suffix — so it could never
    // fail. An exact set catches a stray artifact from any cause, not just a
    // leaked temp under the name we happened to guess.
    //
    // DISCLOSED, because fixing the assertion did not make the `finally`
    // cleanup covered: on the success path BOTH temps are renamed away, so
    // nothing remains whether or not that block runs. Deleting the cleanup
    // entirely leaves this green (verified by injection). The block is
    // failure-path-only and stays uncovered; it is documented in the store as
    // best-effort.
    expect(readdirSync(dir).sort()).toEqual([
      'record.json',
      'record.json.previous',
    ]);
  });
});
