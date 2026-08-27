/**
 * station#2904 — detect a second live instance sharing one Station home.
 *
 * `assertNoPortConflicts` compares PORTS only, so two instances on different
 * ports quietly share one `~/.station`. That is not benign: both construct
 * `FileMemoryAdapter` and write the same conversation transcripts, and
 * station#2252 serialized those mutations only WITHIN a process — an update
 * lost between two servers is lost with no error.
 *
 * The matching rule is tested here rather than through `start` because
 * `listRunningInstances` reads a state directory and filters on live PIDs;
 * a test that had to fabricate running processes to exercise the rule would
 * mostly be testing the fabrication.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertNoSharedHome,
  collectSharedHomeInstances,
  findSharedHomeInstances,
  type InstanceStateRecord,
} from '../commands/lifecycle.js';

// No cast: every required field is present, so a future required field that
// the rule depends on becomes a compile error here instead of silently
// defaulting to undefined.
function record(
  instanceId: string,
  baseDir: string,
  serverPort: number,
): InstanceStateRecord {
  return {
    baseDir: resolve(baseDir),
    build: null,
    cwd: '/repo',
    host: '127.0.0.1',
    homeSource: 'default',
    instanceId,
    serverPid: 1234,
    serverPort,
    startedAt: new Date(0).toISOString(),
    statePath: `/state/${instanceId}.json`,
    uiPid: 5678,
    uiPort: serverPort + 1000,
  };
}

const HOME = '/Users/someone/.station';
const OTHER_HOME = '/tmp/station-temp-home';

describe('findSharedHomeInstances (station#2904)', () => {
  test('reports another instance on the same home', () => {
    const found = findSharedHomeInstances(
      [record('desktop', HOME, 3141)],
      'dev',
      HOME,
    );
    expect(found.map((r) => r.instanceId)).toEqual(['desktop']);
  });

  test('does NOT report an instance on a different home', () => {
    // The discriminating case. Without the baseDir comparison this would
    // report every running instance, which would fire on the supported
    // pattern — a second instance started with `--temp-home` — and train
    // everyone to ignore the warning.
    const found = findSharedHomeInstances(
      [record('smoke', OTHER_HOME, 3242)],
      'dev',
      HOME,
    );
    expect(found).toEqual([]);
  });

  test('does not report the starting instance against itself', () => {
    // `start` re-registers an instance it is promoting or restarting; matching
    // its own record would warn on every ordinary restart.
    const found = findSharedHomeInstances(
      [record('dev', HOME, 3141)],
      'dev',
      HOME,
    );
    expect(found).toEqual([]);
  });

  test('matches a home given in unnormalized form', () => {
    // Records store a resolved path; the caller may not. The selector
    // normalizes, and this pins that — a raw string comparison would silently
    // miss the collision it exists to catch.
    const found = findSharedHomeInstances(
      [record('desktop', HOME, 3141)],
      'dev',
      `${HOME}/../.station`,
    );
    expect(found.map((r) => r.instanceId)).toEqual(['desktop']);
  });

  test('reports every colliding instance, not just the first', () => {
    const found = findSharedHomeInstances(
      [
        record('desktop', HOME, 3141),
        record('smoke', OTHER_HOME, 3242),
        record('bridge', HOME, 3343),
      ],
      'dev',
      HOME,
    );
    expect(found.map((r) => r.instanceId)).toEqual(['desktop', 'bridge']);
  });
});

/**
 * The half that matters most, and the half the first version got wrong: the
 * HOME-scoped registry (`<STATION_HOME>/instances.json`) is where the Desktop
 * sidecar and service installs publish, and it is the only one that spans
 * checkouts. The first implementation read the CWD-anchored
 * `.station/instances/*` instead and was structurally blind to both.
 */
function seedHome(instances: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'station-home-2904-'));
  // 0600: the registry refuses to load a file any group/other bit can
  // reach, so a default-mode fixture would exercise the throw path instead
  // of the read path.
  writeFileSync(
    join(home, 'instances.json'),
    JSON.stringify({ version: 1, instances }),
    { encoding: 'utf-8', mode: 0o600 },
  );
  return home;
}

describe('collectSharedHomeInstances — home-scoped registry (station#2904)', () => {
  test('does not report the starting instance against its own registry entry', () => {
    // Load-bearing since the producer slice: `start` publishes its own entry
    // before the success-path warning runs. Without self-exclusion every
    // start on a shared home warns about ITSELF — observed live before this
    // test existed (instance B's warning listed r2904b).
    const home = seedHome({
      dev: { type: 'inline', port: 3299, pid: process.pid },
    });
    expect(collectSharedHomeInstances('dev', home, [])).toEqual([]);
  });

  test('names a live Desktop sidecar by its registry key, not its type', () => {
    // `process.pid` is alive by construction, which is what the liveness
    // filter checks — no fabricated process needed.
    //
    // The KEY is the assertion that matters. `findRunning` returns
    // `Object.values(...)` and discards it, which rendered the desktop as
    // "sidecar (sidecar)" — a name the user cannot find or stop. An earlier
    // version of this test asserted only `toContain('sidecar')` and passed
    // against exactly that broken string.
    const home = seedHome({
      'desktop-sidecar-4242': {
        type: 'sidecar',
        port: 3141,
        pid: process.pid,
        checkout: '/Applications/Station.app',
      },
    });

    const found = collectSharedHomeInstances('dev', home, []);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('desktop-sidecar-4242');
    expect(found[0]).toContain('3141');
    expect(found[0]).not.toContain('sidecar (sidecar)');
  });

  test('ignores an entry whose process is dead', () => {
    // The discriminating case: without the liveness filter every stale record
    // ever written would warn, and the warning would be noise on first use.
    const home = seedHome({
      ghost: { type: 'service', port: 3141, pid: 2 ** 31 - 1 },
    });

    expect(collectSharedHomeInstances('dev', home, [])).toEqual([]);
  });

  test('reports an instance from each registry', () => {
    const home = seedHome({
      'desktop-sidecar-1': { type: 'sidecar', port: 3141, pid: process.pid },
    });
    const sibling = record('other-cli', home, 3242);

    const found = collectSharedHomeInstances('dev', home, [sibling]);

    expect(found).toHaveLength(2);
    expect(found.some((line) => line.includes('desktop-sidecar-1'))).toBe(true);
    expect(found.some((line) => line.includes('3242'))).toBe(true);
  });

  test('does not report one instance twice when both registries carry it', () => {
    // The dedupe the previous test's NAME claimed but never exercised: it used
    // different ports, so it read the same with no dedupe at all. Keyed on
    // PORT because one process cannot hold two — an earlier key of
    // `type:port` could never match, since the home registry's InstanceType
    // union has no CLI member.
    const home = seedHome({
      'shared-3242': { type: 'inline', port: 3242, pid: process.pid },
    });
    const sameInstance = record('other-cli', home, 3242);

    const found = collectSharedHomeInstances('dev', home, [sameInstance]);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('shared-3242');
  });

  test('a home with no registry is silent — no result and no note', () => {
    // `readInstanceRegistry` rejects a loosely-permissioned HOME before even
    // checking for the file, so without an absence check every start on a
    // plain-mkdir home (0755) would end with a scary could-not-read note
    // about a registry that never existed.
    const home = mkdtempSync(join(tmpdir(), 'station-home-2904-empty-'));
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(collectSharedHomeInstances('dev', home, [])).toEqual([]);
    } finally {
      process.stderr.write = original;
    }
    expect(written).toEqual([]);
  });
});

describe('collectSharedHomeInstances — a broken registry cannot break start', () => {
  test('an unreadable registry yields no warning instead of throwing', () => {
    // `readInstanceRegistry` throws on a corrupt or loosely-permissioned file.
    // Surfacing that from a WARNING would turn a cosmetic check into a reason
    // `station start` fails, which is strictly worse than the silence this
    // change exists to remove.
    const home = mkdtempSync(join(tmpdir(), 'station-home-2904-bad-'));
    writeFileSync(join(home, 'instances.json'), '{ not json', {
      encoding: 'utf-8',
      mode: 0o600,
    });

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(() => collectSharedHomeInstances('dev', home, [])).not.toThrow();
      expect(collectSharedHomeInstances('dev', home, [])).toEqual([]);
    } finally {
      process.stderr.write = original;
    }

    // Silent would be indistinguishable from "nothing else is running", on a
    // feature whose thesis is that silence must mean something.
    expect(written.join('')).toContain('could not read the instance registry');
  });
});

describe('assertNoSharedHome — the warn→refuse graduation (station#2904 2b)', () => {
  test('a genuinely-new start on an occupied home REFUSES with the full detail', () => {
    const home = seedHome({
      'desktop-sidecar-1': { type: 'sidecar', port: 3141, pid: process.pid },
    });
    expect(() => assertNoSharedHome('dev', home, [], false)).toThrow(
      /start is blocked/,
    );
    try {
      assertNoSharedHome('dev', home, [], false);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('desktop-sidecar-1');
      expect(message).toContain('--allow-shared-home');
      expect(message).toContain('--base=');
    }
  });

  test('--allow-shared-home proceeds', () => {
    const home = seedHome({
      'desktop-sidecar-1': { type: 'sidecar', port: 3141, pid: process.pid },
    });
    expect(() => assertNoSharedHome('dev', home, [], true)).not.toThrow();
  });

  test('an empty home proceeds', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-refuse-empty-'));
    expect(() => assertNoSharedHome('dev', home, [], false)).not.toThrow();
  });

  test('a dead occupant does not refuse', () => {
    // The counterpart that keeps the refusal honest: a crashed instance's
    // leftover entry must not block every future start on the home.
    const home = seedHome({
      ghost: { type: 'sidecar', port: 3141, pid: 2 ** 31 - 1 },
    });
    expect(() => assertNoSharedHome('dev', home, [], false)).not.toThrow();
  });
});
