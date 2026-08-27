import { randomUUID } from 'node:crypto';
import {
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { verificationLeaseOwnership } from '../lib/verification-lease-ownership.mjs';

/**
 * station#3287: host disk exhaustion surfaced as an unhandled ENOSPC out of
 * the lease writer, and the failure mode worth defending against is a torn
 * lease file that either crashes every later run at the host-wide request
 * scan or wedges a request key until manual cleanup.
 *
 * The ENOSPC faults are simulated through the repo's proven cross-platform
 * delegate-to-actual `vi.mock('node:fs')` seam (json-store-fsync-mode.test.ts,
 * referenced by #3277) so the fault fires identically on every platform. The
 * write fault deliberately tears the target (writes a truncated prefix before
 * throwing), which is what a real ENOSPC mid-write does: under the atomic
 * writer only the uniquely-named temporary can be torn, so these tests go red
 * if the writer ever stops publishing via rename.
 */
const faults = vi.hoisted(() => ({
  writeMatch: null as RegExp | null,
  writeTornPrefixBytes: null as number | null,
  renameMatch: null as RegExp | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (path: never, data: never, ...rest: never[]) => {
      if (faults.writeMatch?.test(String(path))) {
        if (faults.writeTornPrefixBytes !== null)
          actual.writeFileSync(
            path,
            String(data).slice(0, faults.writeTornPrefixBytes) as never,
            ...rest,
          );
        throw Object.assign(
          new Error('ENOSPC: no space left on device, write'),
          { code: 'ENOSPC' },
        );
      }
      return actual.writeFileSync(path, data, ...rest);
    },
    renameSync: (from: never, to: never) => {
      if (faults.renameMatch?.test(String(to)))
        throw Object.assign(
          new Error('ENOSPC: no space left on device, rename'),
          { code: 'ENOSPC' },
        );
      return actual.renameSync(from, to);
    },
  };
});

const {
  acquireLeaseDirectory,
  acquireMutationClaim,
  cleanStaleDirectory,
  createOwner,
  markOwnershipLostBestEffort,
  readJson,
  releaseMutationClaim,
  statusForDirectory,
  writeJsonAtomic,
} = verificationLeaseOwnership;

const REQUEST_KEY = 'a'.repeat(64);

let root: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  faults.writeMatch = null;
  faults.writeTornPrefixBytes = null;
  faults.renameMatch = null;
  root = mkdtempSync(join(tmpdir(), 'station-lease-disk-faults-'));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  faults.writeMatch = null;
  faults.writeTornPrefixBytes = null;
  faults.renameMatch = null;
  warnSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

function requestDirectory() {
  return join(root, 'requests', REQUEST_KEY);
}

function seededLeaseDirectory(lease: Record<string, unknown>) {
  const directory = requestDirectory();
  expect(acquireLeaseDirectory(directory, lease)).toBe(true);
  return directory;
}

describe('lease writes under a full disk (#3287)', () => {
  test('ENOSPC mid-write names the condition, preserves the prior complete lease, and leaves no torn temporary', () => {
    const directory = join(root, 'stage');
    mkdirSync(directory, { recursive: true });
    const leasePath = join(directory, 'lease.json');
    const original = { state: 'queued', nonce: 'prior-complete' };
    writeJsonAtomic(leasePath, original);

    faults.writeMatch = /lease\.json(?:\.[0-9a-f-]+\.tmp)?$/;
    faults.writeTornPrefixBytes = 9;
    let caught: (Error & { code?: string; cause?: unknown }) | null = null;
    try {
      writeJsonAtomic(leasePath, { state: 'running', nonce: 'never-lands' });
    } catch (error) {
      caught = error as Error & { code?: string; cause?: unknown };
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(
      /host disk full: (\d+ MiB free|free space unknown)/,
    );
    expect(caught?.message).toMatch(/verification lease cannot be recorded/);
    expect(caught?.code).toBe('ENOSPC');
    expect((caught?.cause as { code?: string })?.code).toBe('ENOSPC');

    faults.writeMatch = null;
    faults.writeTornPrefixBytes = null;
    // The published lease is the prior COMPLETE value — a torn write may only
    // ever tear the temporary. A non-atomic writer fails here.
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toEqual(original);
    // The torn temporary is removed rather than left as litter on a disk
    // that is already full.
    expect(readdirSync(directory)).toEqual(['lease.json']);
  });

  test('ENOSPC at the publish rename (the live #3287 trace shape) is translated and cleans its temporary', () => {
    const directory = join(root, 'stage');
    mkdirSync(directory, { recursive: true });
    const leasePath = join(directory, 'lease.json');
    const original = { state: 'running', nonce: 'prior-complete' };
    writeJsonAtomic(leasePath, original);

    faults.renameMatch = /lease\.json$/;
    let caught: (Error & { code?: string }) | null = null;
    try {
      writeJsonAtomic(leasePath, { state: 'ownership_lost' });
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught?.message).toMatch(/host disk full/);
    expect(caught?.code).toBe('ENOSPC');

    faults.renameMatch = null;
    expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toEqual(original);
    expect(readdirSync(directory)).toEqual(['lease.json']);
  });
});

describe('torn lease files (#3287)', () => {
  test('an unparseable lease reads as absent with one warning per path, never a crash, and is never trusted', () => {
    const directory = requestDirectory();
    mkdirSync(directory, { recursive: true });
    const leasePath = join(directory, 'lease.json');
    writeFileSync(leasePath, '{"state":"runni');

    expect(readJson(leasePath)).toBeNull();
    expect(readJson(leasePath)).toBeNull();
    const corruptWarnings = warnSpy.mock.calls.filter(([message]: unknown[]) =>
      /unparseable lease record treated as absent/.test(String(message)),
    );
    expect(corruptWarnings).toHaveLength(1);
    // The torn lease is not trusted as a capacity-consuming job.
    expect(statusForDirectory(directory, { now: Date.now() })).toBeNull();
  });

  test('a corrupt lease directory is reclaimed so the next run starts clean', () => {
    const directory = requestDirectory();
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'lease.json'), 'not json at all');

    expect(cleanStaleDirectory(directory, { now: Date.now() })).toBe(true);
    expect(existsSync(directory)).toBe(false);
    // The next (post-cleanup) run acquires the canonical name cleanly.
    expect(
      acquireLeaseDirectory(directory, {
        owner: createOwner(),
        state: 'queued',
        heartbeatAt: Date.now(),
      }),
    ).toBe(true);
  });

  test('a healthy live lease is never reclaimed by the corrupt path', () => {
    const lease = {
      owner: createOwner(),
      state: 'running',
      heartbeatAt: Date.now(),
    };
    const directory = seededLeaseDirectory(lease);
    expect(cleanStaleDirectory(directory, { now: Date.now() })).toBe(false);
    expect(
      JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
    ).toMatchObject({ state: 'running' });
  });

  test('a corrupt mutation claim is recovered instead of wedging the directory', () => {
    const owner = createOwner();
    const directory = seededLeaseDirectory({
      owner,
      state: 'running',
      heartbeatAt: Date.now(),
    });
    const lock = join(directory, '.mutation');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), '{"pid": 12');

    const claim = acquireMutationClaim(directory, owner, { now: Date.now() });
    expect(claim).toBe(lock);
    expect(releaseMutationClaim(claim, owner)).toBe(true);
  });
});

describe('ownership loss on a full disk (#3287)', () => {
  test('recording ownership loss never throws; each failed write is reported by name and the lease stays reclaimably intact', () => {
    const owner = createOwner();
    const original = {
      owner,
      state: 'running',
      heartbeatAt: Date.now(),
      weight: 20,
    };
    const directory = seededLeaseDirectory(original);

    // Every atomic JSON publish fails, as on a genuinely full disk.
    faults.renameMatch = /\.json$/;
    const warnings: string[] = [];
    let recorded: boolean | null = null;
    expect(() => {
      recorded = markOwnershipLostBestEffort({
        root,
        directory,
        owner,
        now: Date.now,
        warn: (message: string) => warnings.push(message),
      });
    }).not.toThrow();
    expect(recorded).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    for (const message of warnings) {
      expect(message).toMatch(/could not record ownership loss/);
      expect(message).toMatch(/reclaimed by the next run/);
    }
    expect(warnings.join('\n')).toMatch(/host disk full/);

    faults.renameMatch = null;
    // The lease was not torn and not deleted: it stays in its prior complete
    // state, stops heartbeating, and the next run reclaims it by staleness.
    expect(
      JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
    ).toMatchObject({ state: 'running' });
  });

  test('with a writable disk every ownership-loss write lands', () => {
    const owner = createOwner();
    const directory = seededLeaseDirectory({
      owner,
      state: 'running',
      heartbeatAt: Date.now(),
    });
    expect(
      markOwnershipLostBestEffort({
        root,
        directory,
        owner,
        now: Date.now,
        warn: () => {},
      }),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
    ).toMatchObject({ state: 'ownership_lost' });
  });
});

describe('fault seam self-check', () => {
  test('the delegate mock stays inert with no fault armed', () => {
    const path = join(root, `inert-${randomUUID()}.json`);
    writeJsonAtomic(path, { ok: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: true });
  });
});
