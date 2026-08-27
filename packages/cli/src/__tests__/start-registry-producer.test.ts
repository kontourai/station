/**
 * station#2904 slice 2 — `station start` as a home-registry producer.
 *
 * `<STATION_HOME>/instances.json` is the registry that spans checkouts: the
 * Desktop sidecar and service installs publish there, `lazy-start` and the
 * shared-home warning read there. The CLI never produced into it, so a
 * CLI-started server was invisible home-wide, and #2955's warning needed a
 * checkout-scoped fallback to see its own siblings. The `InstanceType` union
 * reserved `'inline' | 'worktree'` for exactly this producer.
 *
 * These tests drive the real registry module against a real temp home
 * (mkdtemp yields 0700, which the registry's parent-trust check requires).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findRunning,
  readInstanceRegistry,
  upsertInstance,
} from '@kontourai/station-shared/instance-registry';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  instanceTypeForCheckout,
  registerStartInHomeRegistry,
  unregisterStopFromHomeRegistry,
} from '../commands/lifecycle.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-reg-2904-'));
});

afterEach(() => {
  // best-effort; temp dirs are reaped by the OS regardless
});

function captureStderr(run: () => void): string[] {
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return written;
}

describe('registerStartInHomeRegistry (station#2904 slice 2)', () => {
  test('publishes a liveness-complete entry the home-wide readers can see', async () => {
    // `process.pid` as the server pid: alive by construction, and the birth
    // fingerprint resolves for a real process — so this asserts the entry
    // passes the SAME liveness filter `lazy-start` and the shared-home
    // warning apply, not merely that bytes landed in a file.
    registerStartInHomeRegistry('dev', home, 3299, 5299, process.pid);

    const entry = readInstanceRegistry(home).instances.dev;
    expect(entry.port).toBe(3299);
    expect(entry.uiPort).toBe(5299);
    expect(['inline', 'worktree']).toContain(entry.type);
    expect(entry.pid).toBe(process.pid);
    // The pid-reuse guard: now that findRunning REJECTS on birth mismatch,
    // a wrong-pid fingerprint here would make every entry read as dead — so
    // this must be the REAL fingerprint of the recorded pid, not just any
    // string (a shape assertion would pass with the bug that bricks it).
    const { lookupProcessBirthFingerprint } = await import(
      '@kontourai/station-shared/process-identity'
    );
    expect(entry.birth).toBe(lookupProcessBirthFingerprint(process.pid));
    expect(entry.status).toBe('running');
    expect(typeof entry.checkout).toBe('string');

    const running = findRunning(home);
    expect(running).toHaveLength(1);
    expect(running[0].port).toBe(3299);
  });

  test('never adopts an entry another surface owns', () => {
    // `service` resolves ids through the SAME resolveLifecycleInstanceId as
    // --instance, and both share the default id — so this collision is the
    // default×default path, not an exotic one. upsertInstance merges
    // partials: without the guard, a service record becomes a half-CLI
    // chimera and the stop path then deletes the service's entry, which
    // service.ts treats as the durable origin-policy authority (#1983).
    upsertInstance(
      'dev',
      { port: 4000, type: 'service', env: { A: 'b' } },
      home,
    );

    const written = captureStderr(() => {
      registerStartInHomeRegistry('dev', home, 3299, 5299, process.pid);
    });

    const entry = readInstanceRegistry(home).instances.dev;
    expect(entry.type).toBe('service');
    expect(entry.port).toBe(4000);
    expect(written.join('')).toContain("registered as type 'service'");
  });

  test('declines to overwrite a LIVE same-type entry from another checkout', () => {
    // The default×default path: two checkouts, both `station start`, one home.
    // Overwriting would erase the sibling home-wide AND the warning's
    // id-keyed self-exclusion would then hide the clobbered entry — the
    // sibling goes invisible at the exact moment two servers share
    // transcripts. The guard declines; the sibling entry survives.
    upsertInstance(
      'dev',
      {
        port: 4000,
        type: 'worktree',
        pid: process.pid,
        checkout: '/other/checkout',
      },
      home,
    );

    const written = captureStderr(() => {
      registerStartInHomeRegistry('dev', home, 3299, 5299, process.pid + 1);
    });

    const entry = readInstanceRegistry(home).instances.dev;
    expect(entry.port).toBe(4000);
    expect(entry.checkout).toBe('/other/checkout');
    expect(written.join('')).toContain('already registered by a live instance');
  });

  test('a DEAD same-type entry is overwritten, not preserved as a ghost', () => {
    // The counterpart that keeps the guard from ossifying: a crashed
    // sibling's leftover entry must not block this checkout from
    // registering forever.
    upsertInstance(
      'dev',
      { port: 4000, type: 'worktree', pid: 2 ** 31 - 1 },
      home,
    );

    registerStartInHomeRegistry('dev', home, 3299, 5299, process.pid);

    const entry = readInstanceRegistry(home).instances.dev;
    expect(entry.port).toBe(3299);
    expect(entry.pid).toBe(process.pid);
  });

  test('a pid-reused entry reads as dead to findRunning once birth mismatches', () => {
    // The review HIGH: an orphaned entry whose pid was reissued to an
    // unrelated process read as alive forever, permanently blocking
    // fail-closed consumers (home backup/restore). With a recorded birth
    // that mismatches the live process, the liveness seam rejects it.
    upsertInstance(
      'dev',
      {
        port: 4000,
        type: 'worktree',
        pid: process.pid,
        birth: 'not-this-process-birth',
      },
      home,
    );
    expect(findRunning(home)).toEqual([]);
  });

  test('a corrupt registry degrades to a stderr note, never a failed start', () => {
    writeFileSync(join(home, 'instances.json'), '{ not json', {
      encoding: 'utf-8',
      mode: 0o600,
    });

    const written = captureStderr(() => {
      expect(() =>
        registerStartInHomeRegistry('dev', home, 3299, 5299, process.pid),
      ).not.toThrow();
    });

    expect(written.join('')).toContain(
      'could not record this instance in the home registry',
    );
  });
});

describe('unregisterStopFromHomeRegistry', () => {
  test('removes the entry it registered', () => {
    registerStartInHomeRegistry('dev', home, 3299, 5299, process.pid);
    unregisterStopFromHomeRegistry('dev', home, process.pid);
    expect(readInstanceRegistry(home).instances.dev).toBeUndefined();
  });

  test('does NOT remove an entry owned by a different pid', () => {
    // The identity check: a stop racing a newer start of the same instance
    // id must not remove the newer start's entry. Without the pid comparison
    // this silently deletes live state — the discriminating case.
    registerStartInHomeRegistry('dev', home, 3299, 5299, process.pid);
    unregisterStopFromHomeRegistry('dev', home, process.pid + 1);
    expect(readInstanceRegistry(home).instances.dev).toBeDefined();
  });

  test('never removes an entry another surface owns, even on pid match', () => {
    upsertInstance(
      'dev',
      { port: 4000, type: 'service', pid: process.pid },
      home,
    );
    unregisterStopFromHomeRegistry('dev', home, process.pid);
    expect(readInstanceRegistry(home).instances.dev).toBeDefined();
  });

  test('a corrupt registry does not block a stop', () => {
    writeFileSync(join(home, 'instances.json'), '{ not json', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    expect(() =>
      unregisterStopFromHomeRegistry('dev', home, process.pid),
    ).not.toThrow();
  });
});

describe('instanceTypeForCheckout', () => {
  test('a linked worktree (.git file) is worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-reg-root-'));
    writeFileSync(join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    expect(instanceTypeForCheckout(root)).toBe('worktree');
  });

  test('a primary checkout (.git directory) is inline', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-reg-root-'));
    mkdirSync(join(root, '.git'));
    expect(instanceTypeForCheckout(root)).toBe('inline');
  });

  test('a non-git root is inline', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-reg-root-'));
    expect(instanceTypeForCheckout(root)).toBe('inline');
  });
});
