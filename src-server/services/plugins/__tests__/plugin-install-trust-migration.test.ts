/**
 * #2998: the install trust migration's state machine against the real
 * EventStore journal and the real trust file. Plugin classification is
 * supplied directly so each case controls exactly what the migration sees.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../orchestration/event-store.js';
import { MAX_INSTALL_TRUST_MIGRATION_PENDING } from '../package-mcp-admission.js';
import {
  migrateGrandfatheredPluginTrust,
  type PluginTrustMigrationClassificationResult,
  type PluginTrustMigrationWitness,
  PluginTrustRecordsUnavailableError,
  pluginTrustMigrationWitness,
  pluginTrustRecordsPath,
  readPluginTrustRecord,
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

  test('a crash between the journal row and the file leaves the records unavailable, and a deleted file never re-grandfathers', async () => {
    const { root, journal, witness } = home();
    // The journal says the migration began; the file was never written.
    expect(
      journal.recordInstallTrustMigration!(
        { state: 'none' },
        { state: 'started', pending: [{ name: 'a', digest: digest('a') }] },
      ),
    ).toEqual({ state: 'applied' });
    expect(() => readPluginTrustRecord(root, 'a', witness)).toThrow(
      PluginTrustRecordsUnavailableError,
    );
    await expect(run(root, witness, { a: installed('a') })).rejects.toThrow(
      PluginTrustRecordsUnavailableError,
    );
    expect(() => readFileSync(pluginTrustRecordsPath(root))).toThrow();
  });

  test('deleting the file after completion re-grandfathers nothing', async () => {
    const { root, witness } = home();
    await run(root, witness, { a: installed('a') });
    for (const suffix of ['', '.previous'])
      rmSync(`${pluginTrustRecordsPath(root)}${suffix}`, { force: true });
    await expect(run(root, witness, { a: installed('a') })).rejects.toThrow(
      PluginTrustRecordsUnavailableError,
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
    };
    expect(
      journal.recordInstallTrustMigration!({ state: 'none' }, started),
    ).toEqual({ state: 'applied' });
    // A second first attempt read `none` too; it must not overwrite.
    expect(
      journal.recordInstallTrustMigration!(
        { state: 'none' },
        { state: 'started', pending: [] },
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
    expect(journal.installTrustMigration!()).toEqual({ state: 'completed' });
    for (const name of ['a', 'b'])
      expect(readPluginTrustRecord(root, name, witness)).toMatchObject({
        state: 'recorded',
        record: { decision: 'grandfathered' },
      });
  });

  test('more pending entries than the bound are refused when written, by the journal and by the migration', async () => {
    const { root, journal, witness } = home();
    const tooMany = Array.from(
      { length: MAX_INSTALL_TRUST_MIGRATION_PENDING + 1 },
      (_, index) => ({ name: `p${index}`, digest: digest('a') }),
    );
    expect(
      journal.recordInstallTrustMigration!(
        { state: 'none' },
        { state: 'started', pending: tooMany },
      ),
    ).toEqual({ state: 'too-many' });
    const world = Object.fromEntries(
      tooMany.map((entry) => [
        entry.name,
        { kind: 'transient', digest: entry.digest } as const,
      ]),
    );
    await expect(run(root, witness, world)).rejects.toThrow(
      `more than ${MAX_INSTALL_TRUST_MIGRATION_PENDING}`,
    );
    expect(journal.installTrustMigration!()).toEqual({ state: 'none' });
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
