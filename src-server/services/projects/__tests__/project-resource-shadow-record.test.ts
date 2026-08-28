/**
 * archive#1686 — the shadow counter's local read path.
 *
 * The defect these tests exist for is not "a counter was missing a feature".
 * It is that `station.project_resource.shadow_comparisons` has been
 * discarding every write since slice 3a merged, so slice 3c's gate —
 * "the divergence record is empty AND the counter shows all four populations
 * were exercised" — would have read an instrument's silence as clearance.
 *
 * So the load-bearing assertions here are the ones that prove the two zeros
 * are distinguishable: an outcome that was never observed is ABSENT (never a
 * zero row), a home with no record answers `never-observed` (never an empty
 * record), and a record that cannot be parsed answers `unreadable` (never
 * folded into "nothing was seen").
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { projectResourceShadowComparisons } from '../../../telemetry/metrics.js';
import {
  NON_DIVERGENT_OUTCOMES,
  observeCwdShadow,
  SHADOW_LOG_DEDUPE,
  SHADOW_RECORD_FAILURE_LATCH,
} from '../project-resource-shadow.js';
import {
  NON_DIVERGENT_RECORD_OUTCOMES,
  readShadowRecord,
  recordShadowComparison,
  SHADOW_RECORD_VERSION,
  SLICE_3C_POPULATIONS,
  shadowRecordPath,
} from '../project-resource-shadow-record.js';

const tmpRoots: string[] = [];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'station-1686-record-'));
  tmpRoots.push(home);
  SHADOW_RECORD_FAILURE_LATCH.warned = false;
  SHADOW_LOG_DEDUPE.clear();
});

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.STATION_PROJECT_RESOURCE_SHADOW;
});

const dims = {
  seam: 'start_session_cwd',
  outcome: 'agree',
  baseline: 'directory',
  provider: 'claude',
  shadow: 'bound',
};

describe('the two zeros are structurally distinguishable', () => {
  test('a home that has never observed anything answers `never-observed`, not an empty record', () => {
    const read = readShadowRecord(home);
    expect(read.state).toBe('never-observed');
    // The distinction the whole issue turns on: a caller cannot reach a
    // count of any kind from this answer, so it cannot render one as zero.
    expect('record' in read).toBe(false);
  });

  test('an observer that ran and saw only agreement is a DIFFERENT answer from one that never ran', () => {
    recordShadowComparison(home, dims, '2026-08-03T00:00:00.000Z');
    const read = readShadowRecord(home);
    expect(read.state).toBe('observed');
    if (read.state !== 'observed') throw new Error('unreachable');
    expect(read.record.observations).toBe(1);
    // …and the tripwire outcome is ABSENT rather than present-with-zero, so
    // nothing downstream can print "conflated-unbound: 0" for a population
    // it never looked at.
    expect(
      read.record.entries.some(
        (entry) => entry.outcome === 'conflated-unbound',
      ),
    ).toBe(false);
    // No zero rows exist at all, for any outcome, ever.
    expect(read.record.entries.every((entry) => entry.count > 0)).toBe(true);
  });

  test('a corrupt record is `unreadable`, never folded into "nothing was observed"', () => {
    writeFileSync(shadowRecordPath(home), '{ not json');
    const read = readShadowRecord(home);
    expect(read.state).toBe('unreadable');
  });

  test('a future record version fails closed on both the read and the write', () => {
    writeFileSync(
      shadowRecordPath(home),
      JSON.stringify({
        version: SHADOW_RECORD_VERSION + 1,
        observations: 9,
        firstObservedAt: 'x',
        lastObservedAt: 'x',
        entries: [],
      }),
    );
    const read = readShadowRecord(home);
    expect(read.state).toBe('unreadable');
    if (read.state !== 'unreadable') throw new Error('unreachable');
    expect(read.reason).toContain(String(SHADOW_RECORD_VERSION + 1));
    // A newer Station's record must not be silently overwritten (and
    // renumbered) by an older one, which would destroy accumulated evidence.
    expect(() => recordShadowComparison(home, dims)).toThrow();
  });
});

describe('accumulation', () => {
  test('the same dimension tuple accumulates; a different one is a new entry', () => {
    recordShadowComparison(home, dims, '2026-08-01T00:00:00.000Z');
    recordShadowComparison(home, dims, '2026-08-02T00:00:00.000Z');
    recordShadowComparison(
      home,
      { ...dims, outcome: 'agree-unverified', shadow: 'stale' },
      '2026-08-03T00:00:00.000Z',
    );
    const read = readShadowRecord(home);
    if (read.state !== 'observed') throw new Error('unreachable');
    expect(read.record.observations).toBe(3);
    expect(read.record.entries).toHaveLength(2);
    const agree = read.record.entries.find(
      (entry) => entry.outcome === 'agree',
    );
    expect(agree?.count).toBe(2);
    expect(agree?.firstObservedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(agree?.lastObservedAt).toBe('2026-08-02T00:00:00.000Z');
    // The window spans every process that used this home — the property a
    // process-scoped in-memory metric reader could not have provided, and
    // the reason legs 2–4 of slice 3c's gate are reachable at all.
    expect(read.record.firstObservedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(read.record.lastObservedAt).toBe('2026-08-03T00:00:00.000Z');
  });

  test('a record written by an earlier process survives a later one', () => {
    recordShadowComparison(home, dims, '2026-08-01T00:00:00.000Z');
    // Second "boot": nothing is carried in memory between these calls.
    recordShadowComparison(home, dims, '2026-08-04T00:00:00.000Z');
    const read = readShadowRecord(home);
    if (read.state !== 'observed') throw new Error('unreachable');
    expect(read.record.observations).toBe(2);
  });

  test('accumulation CONTINUES across a boot that recovers from `.previous`', () => {
    // Review round 1, MEDIUM 3. The reader recovers a lost primary from the
    // retained `.previous`; the writer used to gate on the primary alone, so
    // on this exact boot it started from an empty record and reset the count
    // to 1 — silently destroying the cross-boot accumulation that is the only
    // reason this record exists instead of the OTel counter.
    recordShadowComparison(home, dims, '2026-08-01T00:00:00.000Z');
    recordShadowComparison(home, dims, '2026-08-02T00:00:00.000Z');
    recordShadowComparison(home, dims, '2026-08-03T00:00:00.000Z');
    const primary = shadowRecordPath(home);
    // What the reader already recovers from, so the writer must too.
    const recoverable = JSON.parse(
      readFileSync(`${primary}.previous`, 'utf-8'),
    ) as { observations: number };
    expect(recoverable.observations).toBe(2);

    // The boot on which the primary is gone but `.previous` is not.
    rmSync(primary);
    expect(readShadowRecord(home).state).toBe('observed');

    recordShadowComparison(home, dims, '2026-08-04T00:00:00.000Z');

    const read = readShadowRecord(home);
    if (read.state !== 'observed') throw new Error('unreachable');
    // CONTINUES from the recovered value (2 -> 3). The defect produced 1.
    expect(read.record.observations).toBe(3);
    expect(read.record.entries).toHaveLength(1);
    expect(read.record.entries[0].count).toBe(3);
    // And the accumulated window is preserved, not restarted at this boot.
    expect(read.record.firstObservedAt).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('the reader refuses a broken record instead of crashing the reporter', () => {
  // Review round 1, MEDIUM 4: `Array.isArray(entries)` said nothing about the
  // elements, so a structurally-broken entry reached the reporter, which sums
  // `entry.count` and renders `entry.outcome`. "A guardrail whose rejection
  // path has never executed is unproven" — these are that rejection path.
  function writeRecord(entries: unknown[]): void {
    writeFileSync(
      shadowRecordPath(home),
      JSON.stringify({
        version: SHADOW_RECORD_VERSION,
        observations: 3,
        firstObservedAt: '2026-08-01T00:00:00.000Z',
        lastObservedAt: '2026-08-01T00:00:00.000Z',
        entries,
      }),
    );
  }

  const good = {
    seam: 'start_session_cwd',
    outcome: 'agree',
    baseline: 'directory',
    provider: 'claude',
    shadow: 'bound',
    count: 3,
    firstObservedAt: '2026-08-01T00:00:00.000Z',
    lastObservedAt: '2026-08-01T00:00:00.000Z',
  };

  test('the well-formed control is accepted, so the rejections below discriminate', () => {
    // Without this, every case beneath could be failing for an unrelated
    // reason and the suite would read as proof anyway.
    writeRecord([good]);
    expect(readShadowRecord(home).state).toBe('observed');
  });

  // The `NaN count` case this list used to carry was not testing what it
  // said: `JSON.stringify(NaN) === 'null'`, so the on-disk value was `null`
  // and the `typeof === 'number'` clause rejected it before any numeric check
  // ran. `JSON.parse` cannot produce NaN or Infinity at all, so a
  // `Number.isFinite` guard here had no reachable rejection path — which is
  // why it is now `Number.isInteger` plus a floor, constraints a real file
  // CAN violate and the three numeric cases below actually exercise (round 2,
  // LOW 5).
  test.each([
    ['a null entry', null],
    ['a string entry', 'agree'],
    ['a non-numeric count', { ...good, count: '3' }],
    ['a fractional count', { ...good, count: 1.5 }],
    ['a zero count', { ...good, count: 0 }],
    ['a negative count', { ...good, count: -3 }],
    ['a missing outcome', { ...good, outcome: undefined }],
    ['a non-string seam', { ...good, seam: 7 }],
    ['a non-string shadow', { ...good, shadow: 7 }],
    ['a missing lastObservedAt', { ...good, lastObservedAt: undefined }],
  ])('%s makes the record `unreadable`, not summable', (_label, entry) => {
    writeRecord([good, entry]);
    const read = readShadowRecord(home);
    expect(read.state).toBe('unreadable');
    if (read.state !== 'unreadable') throw new Error('unreachable');
    expect(read.reason).toBe('not a shadow record');
  });

  test.each([
    ['a non-numeric observations', 'lots'],
    ['a fractional observations', 1.5],
    ['a negative observations', -1],
  ])('%s makes the record `unreadable` too', (_label, observations) => {
    writeFileSync(
      shadowRecordPath(home),
      JSON.stringify({
        version: SHADOW_RECORD_VERSION,
        observations,
        firstObservedAt: '2026-08-01T00:00:00.000Z',
        lastObservedAt: '2026-08-01T00:00:00.000Z',
        entries: [],
      }),
    );
    expect(readShadowRecord(home).state).toBe('unreadable');
  });

  test('a corrupt PRIMARY recovers from `.previous` instead of stranding the home', () => {
    // Round 2, MEDIUM 2. `JsonFileStore.read()` consults `.previous` only
    // when the primary is MISSING; a present-but-garbage primary — the state
    // dropping the fsyncs makes reachable — threw straight past the retained
    // copy. Combined with the writer's (correct) refusal to overwrite an
    // unreadable record, that turned a recoverable loss into a home that
    // silently records nothing, every boot, forever.
    recordShadowComparison(home, dims, '2026-08-01T00:00:00.000Z');
    recordShadowComparison(home, dims, '2026-08-02T00:00:00.000Z');
    recordShadowComparison(home, dims, '2026-08-03T00:00:00.000Z');
    const primary = shadowRecordPath(home);
    // What a power loss between the rename's metadata and the temp file's
    // data leaves behind: a primary that EXISTS and is garbage.
    writeFileSync(primary, '{"version":1,"observ');

    const read = readShadowRecord(home);
    expect(read.state).toBe('observed');
    if (read.state !== 'observed') throw new Error('unreachable');
    expect(read.recoveredFrom).toBe(`${primary}.previous`);
    expect(read.record.observations).toBe(2);

    // …and the home is NOT stuck: the next observation accumulates onto the
    // recovered history rather than throwing forever.
    expect(() =>
      recordShadowComparison(home, dims, '2026-08-04T00:00:00.000Z'),
    ).not.toThrow();
    const after = readShadowRecord(home);
    if (after.state !== 'observed') throw new Error('unreachable');
    expect(after.record.observations).toBe(3);
    // Recovery is a DIFFERENT fact from an intact read, and once the primary
    // is whole again the reader stops claiming it.
    expect(after.recoveredFrom).toBeUndefined();
  });

  test('a corrupt primary with NO usable `.previous` is still `unreadable`', () => {
    // The residual, and it must stay loud rather than starting a fresh record
    // — silently beginning again is the emptiness-as-clearance shape.
    writeFileSync(shadowRecordPath(home), '{ not json');
    writeFileSync(`${shadowRecordPath(home)}.previous`, 'also not json');
    const read = readShadowRecord(home);
    expect(read.state).toBe('unreadable');
    if (read.state !== 'unreadable') throw new Error('unreachable');
    // Names the primary's own failure, plus why the fallback could not help.
    expect(read.reason).toContain('could not stand in');
  });

  test('a FUTURE-versioned primary does NOT fall back to `.previous`', () => {
    // The one deliberate exception. A newer record is intact, not corrupt;
    // recovering a stale `.previous` here would let this older reader answer
    // `observed` and then write over a newer Station's history — exactly what
    // the version check exists to prevent.
    recordShadowComparison(home, dims, '2026-08-01T00:00:00.000Z');
    recordShadowComparison(home, dims, '2026-08-02T00:00:00.000Z');
    writeFileSync(
      shadowRecordPath(home),
      JSON.stringify({
        version: SHADOW_RECORD_VERSION + 1,
        observations: 99,
        firstObservedAt: 'x',
        lastObservedAt: 'x',
        entries: [],
      }),
    );
    const read = readShadowRecord(home);
    expect(read.state).toBe('unreadable');
    if (read.state !== 'unreadable') throw new Error('unreachable');
    expect(read.reason).toContain(String(SHADOW_RECORD_VERSION + 1));
    expect(() => recordShadowComparison(home, dims)).toThrow();
  });

  test.each([
    [
      'additive (still current-shape-valid)',
      {
        observations: 99,
        firstObservedAt: 'x',
        lastObservedAt: 'x',
        entries: [],
      },
    ],
    [
      'NON-additive (shape actually changed)',
      {
        // `SHADOW_RECORD_VERSION` is documented as bumped when the on-disk
        // shape changes. Shape-first classification once sent this case to
        // `unusable`, recovered a stale `.previous`, and let this reader
        // overwrite a newer primary.
        // The old test used the additive case only, so it proved the easy
        // direction and missed this one entirely.
        observations: { total: 99, byOutcome: {} },
        window: { first: 'x', last: 'x' },
        rows: [],
      },
    ],
  ])(
    'a newer-versioned primary that is %s never reads `.previous`',
    (_label, body) => {
      recordShadowComparison(home, dims, '2026-08-01T00:00:00.000Z');
      recordShadowComparison(home, dims, '2026-08-02T00:00:00.000Z');
      writeFileSync(
        shadowRecordPath(home),
        JSON.stringify({ version: SHADOW_RECORD_VERSION + 1, ...body }),
      );

      const read = readShadowRecord(home);
      expect(read.state).toBe('unreadable');
      if (read.state !== 'unreadable') throw new Error('unreachable');
      expect(read.reason).toContain(String(SHADOW_RECORD_VERSION + 1));

      // The outcome the exception exists to prevent: an older Station
      // answering `observed` from a stale copy and then renumbering the newer
      // record it could not understand.
      expect(() => recordShadowComparison(home, dims)).toThrow();
      const onDisk = JSON.parse(
        readFileSync(shadowRecordPath(home), 'utf-8'),
      ) as { version: number };
      expect(onDisk.version).toBe(SHADOW_RECORD_VERSION + 1);
    },
  );

  test.each([
    [
      'non-JSON garbage (power-loss zero/whitespace fill)',
      '\u0000\u0000\u0000',
    ],
    ['truncated JSON', '{"version":1,"observ'],
    ['a fractional version', '{"version":1.5,"observations":9}'],
    ['a zero version', '{"version":0,"observations":9}'],
    ['a negative version', '{"version":-1,"observations":9}'],
    ['a null version', '{"version":null,"observations":9}'],
    ['an array body', '[1,2,3]'],
    ['a string body', '"nope"'],
  ])(
    'a primary corrupted as %s still RECOVERS from `.previous`',
    (_l, bytes) => {
      // Hoisting the version check ahead of the shape check once stranded
      // corrupt shapes that recovery had handled: any parseable object with a
      // numeric `version` outside the supported band was read as a future
      // version. Fractional, zero, and negative values are damage, so they
      // remain eligible for recovery from `.previous`.
      recordShadowComparison(home, dims, '2026-08-01T00:00:00.000Z');
      recordShadowComparison(home, dims, '2026-08-02T00:00:00.000Z');
      writeFileSync(shadowRecordPath(home), bytes);

      const read = readShadowRecord(home);
      expect(read.state).toBe('observed');
      if (read.state !== 'observed') throw new Error('unreachable');
      expect(read.recoveredFrom).toBe(`${shadowRecordPath(home)}.previous`);
    },
  );

  test('the removed version 1 persisted shape is rejected explicitly', () => {
    // Version 1 used the `legacy` dimension. Version 2 names the comparison
    // baseline directly, so the reader must not reinterpret the old record.
    recordShadowComparison(home, dims, '2026-08-01T00:00:00.000Z');
    recordShadowComparison(home, dims, '2026-08-02T00:00:00.000Z');
    writeFileSync(
      shadowRecordPath(home),
      JSON.stringify({
        version: 1,
        observations: 1,
        firstObservedAt: '2026-08-01T00:00:00.000Z',
        lastObservedAt: '2026-08-01T00:00:00.000Z',
        entries: [
          {
            seam: 'start_session_cwd',
            outcome: 'agree',
            legacy: 'directory',
            provider: 'claude',
            shadow: 'bound',
            count: 1,
            firstObservedAt: '2026-08-01T00:00:00.000Z',
            lastObservedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const read = readShadowRecord(home);
    expect(read.state).toBe('unreadable');
    if (read.state !== 'unreadable') throw new Error('unreachable');
    expect(read.reason).toContain('unsupported record version 1');
    expect(() => recordShadowComparison(home, dims)).toThrow(/unreadable/);
  });

  test('the writer REFUSES a record the reader calls unreadable', () => {
    // The writer once substituted an empty record for an unrecognised shape,
    // overwriting and renumbering a file the reader had refused.
    writeRecord([{ ...good, count: '3' }]);
    expect(() => recordShadowComparison(home, dims)).toThrow(/unreadable/);
    // …and left it alone rather than replacing it with a fresh record.
    expect(readShadowRecord(home).state).toBe('unreadable');
  });
});

describe('the record and the counter cannot describe different facts', () => {
  test('observeCwdShadow writes the record with EXACTLY the dimensions it gives the counter', async () => {
    const add = vi.spyOn(projectResourceShadowComparisons, 'add');
    try {
      await observeCwdShadow(
        {
          projectSlug: 'acme',
          provider: 'claude',
          baseline: { kind: 'missing-directory', path: '/gone' },
        },
        {
          homeDir: home,
          logged: new Set(),
          resolve: async () => ({
            state: 'unbound',
            resourceId: 'r',
            reason: 'gone',
          }),
        },
      );
      const counterAttributes = add.mock.calls[0]?.[1];
      const read = readShadowRecord(home);
      if (read.state !== 'observed') throw new Error('unreachable');
      const entry = read.record.entries[0];
      // Not "the record has an entry" — the SAME tuple. A record that
      // summarised the counter differently would be a second derivation of
      // the fact slice 3c reads.
      expect({
        seam: entry.seam,
        provider: entry.provider,
        outcome: entry.outcome,
        baseline: entry.baseline,
        shadow: entry.shadow,
      }).toEqual(counterAttributes);
      expect(entry.outcome).toBe('conflated-unbound');
    } finally {
      add.mockRestore();
    }
  });

  test('the kill switch is recorded, so a quiet record from `off` is not a quiet record from agreement', async () => {
    process.env.STATION_PROJECT_RESOURCE_SHADOW = 'off';
    await observeCwdShadow(
      {
        projectSlug: 'acme',
        provider: 'claude',
        baseline: { kind: 'no-directory' },
      },
      { homeDir: home },
    );
    const read = readShadowRecord(home);
    if (read.state !== 'observed') throw new Error('unreachable');
    expect(read.record.entries[0].outcome).toBe('disabled');
  });

  test('an unwritable record says so ONCE and never disturbs the comparison', async () => {
    const logger = { warn: vi.fn() };
    const deps = {
      // A path under a FILE, so mkdir/write fails for real rather than by
      // mock — the observer must survive a genuinely broken home.
      homeDir: join(home, 'not-a-directory.txt', 'nested'),
      logger,
      logged: new Set<string>(),
      resolve: async () =>
        ({ state: 'bound', resourceId: 'r', path: '/repo' }) as const,
    };
    writeFileSync(join(home, 'not-a-directory.txt'), 'blocking file');

    const first = await observeCwdShadow(
      {
        projectSlug: 'acme',
        provider: 'claude',
        baseline: { kind: 'directory', path: '/repo' },
      },
      deps,
    );
    const second = await observeCwdShadow(
      {
        projectSlug: 'acme',
        provider: 'claude',
        baseline: { kind: 'directory', path: '/repo' },
      },
      deps,
    );

    // The comparison is unchanged — the shadow must never disturb what it
    // observes, and that includes its own record failing.
    expect([first.outcome, second.outcome]).toEqual(['agree', 'agree']);
    // Said once, not once per session start.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('NOT being accumulated');
  });
});

test('the reader-side divergence set matches the observer`s, in both directions', () => {
  // A one-directional assertion (every reader outcome is in the observer set)
  // cannot catch the reader forgetting one, and vice versa. Pin the sets.
  expect([...NON_DIVERGENT_RECORD_OUTCOMES].sort()).toEqual(
    [...NON_DIVERGENT_OUTCOMES].sort(),
  );
});

test('every slice 3c population names a distinct dimension tuple', () => {
  // Two populations that collapse to the same tuple would let one sample
  // satisfy both legs of the gate — the exact substitution `agree-drifted`
  // was split out of `agree-unverified` to prevent.
  const keys = SLICE_3C_POPULATIONS.map(
    (population) =>
      `${population.outcome}|${population.baseline}|${population.shadow}`,
  );
  expect(new Set(keys).size).toBe(SLICE_3C_POPULATIONS.length);
  expect(SLICE_3C_POPULATIONS).toHaveLength(4);
});
