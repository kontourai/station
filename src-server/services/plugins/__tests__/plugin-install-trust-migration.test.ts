/**
 * #2998: the install trust migration's state machine against the real
 * EventStore journal and the real trust file. Plugin classification is
 * supplied directly so each case controls exactly what the migration sees.
 */
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../orchestration/event-store.js';
import { MAX_INSTALL_TRUST_MIGRATION_PENDING } from '../package-mcp-admission.js';
import { ensurePluginInstallTrustMigration } from '../plugin-install-trust-migration.js';
import {
  migrateGrandfatheredPluginTrust,
  PLUGIN_TRUST_RECORDS_RECOVERY,
  type PluginTrustMigrationClassificationResult,
  PluginTrustMigrationRaceError,
  type PluginTrustMigrationWitness,
  type PluginTrustRecord,
  PluginTrustRecordsUnavailableError,
  pluginTrustMigrationWitness,
  pluginTrustRecordsPath,
  readPluginTrustRecord,
  writePluginTrustRecord,
} from '../plugin-install-trust-store.js';

const tempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;

function home() {
  const root = tempDir('station-trust-migration-');
  const store = new EventStore(join(root, 'events.sqlite'));
  stores.push(store);
  const journal = store.createPackageMcpAdmissionJournal();
  return { root, journal, witness: pluginTrustMigrationWitness(journal)! };
}

function run(
  root: string,
  witness: PluginTrustMigrationWitness | undefined,
  world: Record<string, PluginTrustMigrationClassificationResult>,
) {
  return migrateGrandfatheredPluginTrust({
    projectHomeDir: root,
    ...(witness ? { witness } : {}),
    candidates: async () => Object.keys(world),
    classify: async (name) => world[name] ?? { kind: 'absent' },
    now: () => new Date('2026-10-25T00:00:00.000Z'),
  });
}

const record = (fill: string): PluginTrustRecord => ({
  version: 1,
  signer: null,
  provenance: 'unsigned',
  contentDigest: digest(fill),
  // What the installer writes for a new unsigned install.
  tier: 3,
  decision: 'initial',
  decidedBy: 'station',
  decidedAt: '2026-10-25T00:00:00.000Z',
});

const installed = (fill: string): PluginTrustMigrationClassificationResult => ({
  kind: 'installed',
  contentDigest: digest(fill),
  signer: null,
});

describe('frozen digests', () => {
  test('a pending plugin is grandfathered only with the bytes frozen at the first attempt', async () => {
    const { root, journal, witness } = home();
    // First attempt: both readable bytes, but their manifests cannot be read.
    await run(root, witness, {
      same: { kind: 'transient', digest: digest('a') },
      swapped: { kind: 'transient', digest: digest('b') },
    });
    expect(journal.installTrustMigration!()).toEqual({
      state: 'started',
      pending: [
        { name: 'same', digest: digest('a') },
        { name: 'swapped', digest: digest('b') },
      ],
      fileWritten: true,
    });
    // Later: one is unchanged, the other's bytes were replaced meanwhile.
    await run(root, witness, { same: installed('a'), swapped: installed('c') });
    expect(readPluginTrustRecord(root, 'same', witness)).toMatchObject({
      state: 'recorded',
      record: {
        decision: 'grandfathered',
        tier: 2,
        contentDigest: digest('a'),
      },
    });
    expect(readPluginTrustRecord(root, 'swapped', witness)).toEqual({
      state: 'unrecorded',
    });
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
  });

  test('a plugin whose bytes could not be read at the freeze is never grandfathered', async () => {
    const { root, witness } = home();
    await run(root, witness, { unread: { kind: 'transient', digest: null } });
    await run(root, witness, { unread: installed('a') });
    expect(readPluginTrustRecord(root, 'unread', witness)).toEqual({
      state: 'unrecorded',
    });
  });
});

describe('journal first, failures fail closed', () => {
  test('a failed journal write fails the attempt before the file is written', async () => {
    const { root, journal } = home();
    const failing: PluginTrustMigrationWitness = {
      installTrustMigration: () => journal.installTrustMigration!(),
      recordInstallTrustMigration: () => ({ state: 'unavailable' }),
    };
    await expect(run(root, failing, { a: installed('a') })).rejects.toThrow(
      PluginTrustRecordsUnavailableError,
    );
    expect(() => readFileSync(pluginTrustRecordsPath(root))).toThrow();
    expect(journal.installTrustMigration!()).toEqual({ state: 'none' });
  });

  test('a failed journal write after the file write fails the attempt too', async () => {
    const { root, journal } = home();
    let writes = 0;
    const flaky: PluginTrustMigrationWitness = {
      installTrustMigration: () => journal.installTrustMigration!(),
      recordInstallTrustMigration: (expected, next) =>
        ++writes === 1
          ? journal.recordInstallTrustMigration!(expected, next)
          : { state: 'unavailable' },
    };
    await expect(run(root, flaky, { a: installed('a') })).rejects.toThrow(
      PluginTrustRecordsUnavailableError,
    );
  });

  test('a crash before the first file write rebuilds the file from the frozen set, grandfathering digest matches only', async () => {
    const { root, journal, witness } = home();
    // The journal froze the set; the file was never written.
    expect(
      journal.recordInstallTrustMigration!(
        { state: 'none' },
        {
          state: 'started',
          pending: [
            { name: 'same', digest: digest('a') },
            { name: 'swapped', digest: digest('b') },
            { name: 'unread', digest: null },
          ],
          fileWritten: false,
        },
      ),
    ).toEqual({ state: 'applied' });
    expect(readPluginTrustRecord(root, 'same', witness)).toEqual({
      state: 'pending-migration',
    });
    await run(root, witness, {
      same: installed('a'),
      swapped: installed('c'),
      unread: installed('a'),
      // Not in the frozen set: installed after the freeze.
      later: installed('d'),
    });
    expect(readPluginTrustRecord(root, 'same', witness)).toMatchObject({
      state: 'recorded',
      record: { decision: 'grandfathered', contentDigest: digest('a') },
    });
    for (const name of ['swapped', 'unread', 'later'])
      expect(readPluginTrustRecord(root, name, witness)).toEqual({
        state: 'unrecorded',
      });
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
  });

  test('a first file write that fails locks nothing out: the next attempt rebuilds', async () => {
    const { journal, witness } = home();
    // A separate trust home so only the trust file's directory is read-only.
    const trustHome = tempDir('station-trust-migration-home-');
    chmodSync(trustHome, 0o555);
    try {
      await expect(
        run(trustHome, witness, { a: installed('a') }),
      ).rejects.toThrow();
      expect(journal.installTrustMigration!()).toEqual({
        state: 'started',
        pending: [{ name: 'a', digest: digest('a') }],
        fileWritten: false,
      });
    } finally {
      chmodSync(trustHome, 0o755);
    }
    await run(trustHome, witness, { a: installed('a') });
    expect(readPluginTrustRecord(trustHome, 'a', witness)).toMatchObject({
      state: 'recorded',
      record: { decision: 'grandfathered' },
    });
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
  });

  test('a file deleted after it was written fails closed, and the named recovery works', async () => {
    const { root, journal, witness } = home();
    // One plugin is still pending, so the migration stays `started`.
    await run(root, witness, {
      a: installed('a'),
      b: { kind: 'transient', digest: digest('b') },
    });
    expect(journal.installTrustMigration!()).toMatchObject({
      state: 'started',
      fileWritten: true,
    });
    for (const suffix of ['', '.previous'])
      rmSync(`${pluginTrustRecordsPath(root)}${suffix}`, { force: true });
    await expect(
      run(root, witness, { a: installed('a'), b: installed('b') }),
    ).rejects.toThrow(PLUGIN_TRUST_RECORDS_RECOVERY);
    expect(() => readFileSync(pluginTrustRecordsPath(root))).toThrow();
    // The recovery the message names, written exactly as it reads.
    writeFileSync(
      pluginTrustRecordsPath(root),
      PLUGIN_TRUST_RECORDS_RECOVERY.slice(
        PLUGIN_TRUST_RECORDS_RECOVERY.indexOf('{'),
        PLUGIN_TRUST_RECORDS_RECOVERY.lastIndexOf('}') + 1,
      ),
    );
    await run(root, witness, { a: installed('a'), b: installed('b') });
    // The journal follows the completed file instead of resuming `b`.
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
    for (const name of ['a', 'b'])
      expect(readPluginTrustRecord(root, name, witness)).toEqual({
        state: 'unrecorded',
      });
    await writePluginTrustRecord(root, 'a', record('a'), witness);
    expect(readPluginTrustRecord(root, 'a', witness)).toMatchObject({
      state: 'recorded',
    });
  });

  test('deleting the file after completion re-grandfathers nothing', async () => {
    const { root, witness } = home();
    await run(root, witness, { a: installed('a') });
    for (const suffix of ['', '.previous'])
      rmSync(`${pluginTrustRecordsPath(root)}${suffix}`, { force: true });
    await expect(run(root, witness, { a: installed('a') })).rejects.toThrow(
      PLUGIN_TRUST_RECORDS_RECOVERY,
    );
    expect(() => readFileSync(pluginTrustRecordsPath(root))).toThrow();
  });
});

describe('concurrency and bounds', () => {
  test('the journal only applies a step from the state it was read in', async () => {
    const { journal } = home();
    const started = {
      state: 'started' as const,
      pending: [{ name: 'a', digest: digest('a') }],
      fileWritten: false,
    };
    expect(
      journal.recordInstallTrustMigration!({ state: 'none' }, started),
    ).toEqual({ state: 'applied' });
    // A second first attempt read `none` too; it must not overwrite.
    expect(
      journal.recordInstallTrustMigration!(
        { state: 'none' },
        { state: 'started', pending: [], fileWritten: false },
      ),
    ).toEqual({ state: 'stale' });
    expect(journal.installTrustMigration!()).toEqual(started);
  });

  test('two first attempts at once grandfather each plugin once and agree on the result', async () => {
    const { root, journal, witness } = home();
    const world = { a: installed('a'), b: installed('b') };
    const results = await Promise.allSettled([
      run(root, witness, world),
      run(root, witness, world),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of results)
      if (result.status === 'rejected')
        expect(result.reason).toBeInstanceOf(PluginTrustMigrationRaceError);
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
    for (const name of ['a', 'b'])
      expect(readPluginTrustRecord(root, name, witness)).toMatchObject({
        state: 'recorded',
        record: { decision: 'grandfathered' },
      });
  });

  test('more frozen plugins than the bound grandfather none and complete, without locking installs out', async () => {
    const { root, journal, witness } = home();
    const tooMany = Array.from(
      { length: MAX_INSTALL_TRUST_MIGRATION_PENDING + 1 },
      (_, index) => ({ name: `p${index}`, digest: digest('a') }),
    );
    // The journal itself refuses to store more than the bound.
    expect(
      journal.recordInstallTrustMigration!(
        { state: 'none' },
        { state: 'started', pending: tooMany, fileWritten: false },
      ),
    ).toEqual({ state: 'too-many' });
    const world = Object.fromEntries(
      tooMany.map((entry) => [entry.name, installed('a')]),
    );
    await expect(run(root, witness, world)).resolves.toMatchObject({
      state: 'migrated',
      grandfathered: [],
    });
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
    // The skip is recorded with the store, so the operator is told why
    // these plugins have no record, not only a log line.
    expect(readPluginTrustRecord(root, 'p0', witness)).toEqual({
      state: 'unrecorded',
      grandfatheringSkipped: true,
    });
    expect(
      JSON.parse(readFileSync(pluginTrustRecordsPath(root), 'utf8')).$migration
        .skippedOverBound,
    ).toBe(MAX_INSTALL_TRUST_MIGRATION_PENDING + 1);
    await writePluginTrustRecord(root, 'p0', record('a'), witness);
  });

  test('exactly the bound is still grandfathered', async () => {
    const { root, witness } = home();
    const world = Object.fromEntries(
      Array.from(
        { length: MAX_INSTALL_TRUST_MIGRATION_PENDING },
        (_, index) => [`p${index}`, installed('a')],
      ),
    );
    const result = await run(root, witness, world);
    expect(result).toMatchObject({ state: 'migrated' });
    expect(result.state === 'migrated' ? result.grandfathered.length : 0).toBe(
      MAX_INSTALL_TRUST_MIGRATION_PENDING,
    );
  });

  test('the file marker refuses the same bound on read', () => {
    const { root } = home();
    writeFileSync(
      pluginTrustRecordsPath(root),
      JSON.stringify({
        $migration: {
          version: 1,
          startedAt: '2026-10-25T00:00:00.000Z',
          pending: Array.from(
            { length: MAX_INSTALL_TRUST_MIGRATION_PENDING + 1 },
            (_, index) => ({ name: `p${index}`, digest: digest('a') }),
          ),
        },
      }),
    );
    expect(() => readPluginTrustRecord(root, 'p0')).toThrow(
      PluginTrustRecordsUnavailableError,
    );
  });
});

describe('a concurrent first attempt', () => {
  test('the loser retries once against the state the winner recorded', async () => {
    const { root, journal } = home();
    let raced = false;
    // The first journal write this attempt makes finds that another first
    // attempt froze the set just before it.
    const racing: typeof journal = {
      ...journal,
      recordInstallTrustMigration: (expected, next) => {
        if (!raced) {
          raced = true;
          journal.recordInstallTrustMigration!(
            { state: 'none' },
            { state: 'started', pending: [], fileWritten: false },
          );
        }
        return journal.recordInstallTrustMigration!(expected, next);
      },
    };
    await ensurePluginInstallTrustMigration({
      projectHomeDir: root,
      packageMcpJournal: racing,
    });
    expect(raced).toBe(true);
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
    expect(
      readPluginTrustRecord(root, 'a', pluginTrustMigrationWitness(journal)),
    ).toEqual({
      state: 'unrecorded',
    });
  });
});

describe('records from a newer build', () => {
  const newer = {
    version: 2,
    signer: null,
    provenance: 'something-new',
    contentDigest: digest('a'),
    tier: 4,
    decision: 'a-new-kind',
    decidedBy: 'someone-new',
    decidedAt: '2027-01-01T00:00:00.000Z',
  };

  test('a newer record reads as unreadable without hiding the rest of the store', async () => {
    const { root, witness } = home();
    await run(root, witness, { a: installed('a') });
    const file = JSON.parse(readFileSync(pluginTrustRecordsPath(root), 'utf8'));
    writeFileSync(
      pluginTrustRecordsPath(root),
      JSON.stringify({
        ...file,
        b: newer,
        'Not.A.Canonical.Key': newer,
      }),
    );
    expect(readPluginTrustRecord(root, 'b', witness)).toEqual({
      state: 'unreadable',
    });
    expect(readPluginTrustRecord(root, 'a', witness)).toMatchObject({
      state: 'recorded',
    });
  });

  test('a newer migration marker reads as a completed migration', async () => {
    const { root, witness } = home();
    writeFileSync(
      pluginTrustRecordsPath(root),
      JSON.stringify({ $migration: { version: 2, somethingNew: true } }),
    );
    expect(readPluginTrustRecord(root, 'a', witness)).toEqual({
      state: 'unrecorded',
    });
    await expect(run(root, witness, { a: installed('a') })).resolves.toEqual({
      state: 'already-migrated',
    });
  });

  test('a version-1 record with an unknown field is still refused', () => {
    const { root } = home();
    writeFileSync(
      pluginTrustRecordsPath(root),
      JSON.stringify({ a: { ...record('a'), surprise: true } }),
    );
    expect(() => readPluginTrustRecord(root, 'a')).toThrow(
      PluginTrustRecordsUnavailableError,
    );
  });
});

describe('records no writer produces', () => {
  const sigstore = {
    kind: 'sigstore',
    issuer: 'https://token.actions.githubusercontent.com',
    identity: 'https://github.com/acme/plugin/.github/workflows/release.yml',
    repositoryId: '1',
    ownerId: '2',
  } as const;
  const completed = {
    $migration: {
      version: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      pending: [],
    },
  };
  const write = (root: string, entry: Record<string, unknown>) =>
    writeFileSync(
      pluginTrustRecordsPath(root),
      JSON.stringify({ ...completed, a: entry }),
    );

  test.each([
    ['unsigned at tier 2', { ...record('a'), tier: 2 }],
    [
      'kontour without a signer',
      { ...record('a'), provenance: 'kontour', tier: 2 },
    ],
    [
      'kontour with a registry key',
      {
        ...record('a'),
        provenance: 'kontour',
        signer: { kind: 'ed25519', keyId: 'k', keyFingerprint: 'f' },
        tier: 2,
      },
    ],
    [
      'a registry-key publisher at tier 2',
      {
        ...record('a'),
        provenance: 'publisher',
        signer: { kind: 'ed25519', keyId: 'k', keyFingerprint: 'f' },
        tier: 2,
      },
    ],
    ['a signer with unsigned provenance', { ...record('a'), signer: sigstore }],
    [
      'a grandfathered record at tier 3',
      { ...record('a'), decision: 'grandfathered' },
    ],
    ['a stored unchanged decision', { ...record('a'), decision: 'unchanged' }],
    ['an operator decidedBy', { ...record('a'), decidedBy: 'operator' }],
    ['a prior tier without a new decision', { ...record('a'), priorTier: 2 }],
  ])('%s is malformed, so the store reads as unavailable', (_name, entry) => {
    const { root } = home();
    write(root, entry);
    expect(() => readPluginTrustRecord(root, 'a')).toThrow(
      PluginTrustRecordsUnavailableError,
    );
  });

  test.each([
    ['a new unsigned install', record('a')],
    [
      'a kontour install',
      { ...record('a'), provenance: 'kontour', signer: sigstore, tier: 2 },
    ],
    [
      'a kontour tier kept by a same-bytes reinstall after leaving the lock',
      { ...record('a'), provenance: 'publisher', signer: sigstore, tier: 2 },
    ],
    [
      'a grandfathered unsigned plugin',
      { ...record('a'), decision: 'grandfathered', tier: 2 },
    ],
    [
      'a lowered update',
      {
        ...record('a'),
        decision: 'new-decision',
        reason: 'signer-changed',
        priorTier: 2,
      },
    ],
  ])('%s still reads as recorded', (_name, entry) => {
    const { root } = home();
    write(root, entry);
    expect(readPluginTrustRecord(root, 'a')).toMatchObject({
      state: 'recorded',
    });
  });
});
