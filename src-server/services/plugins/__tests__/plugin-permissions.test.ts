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
import {
  corruptFile,
  danglingSymlink,
  interleaveOnceOnLockAcquire,
  reservedKeyShapes,
  skipIfCannotChmod,
  truncatePrimaryKeepPrevious,
  withUnreadable,
} from '../../infra/__tests__/helpers/store-faults.js';
import {
  GrantsFileStore,
  GrantsStoreReservedKeyError,
  GrantsStoreUnavailableError,
} from '../grants-file-store.js';
import {
  computePluginContentDigest,
  withPluginContentLock,
} from '../plugin-content-integrity.js';
import {
  copyPluginDependencyOwnership,
  getPermissionTier,
  getPluginGrants,
  grantPermissions,
  hasGrant,
  hasGrantOrThrow,
  needsConsent,
  PluginContentUnavailableError,
  PluginGrantsUnavailableError,
  processInstallPermissions,
  readPluginDependencyOwnership,
  readPluginGrantRecord,
  readPluginGrantState,
  rebindGrantsAfterContentChange,
  recordPluginDependencyOwnership,
  removePluginHostRecord,
  requiredPermissionsForManifest,
  revokeAllGrants,
  revokeGrants,
} from '../plugin-permissions.js';

/**
 * archive#4288: a grant is bound to the plugin's installed bytes, so every
 * consent write refuses when the tree cannot be digested. Fixtures therefore
 * need a real tree — which matches production, where every grant surface
 * checks `plugin.json` before recording anything.
 */
function seedPluginTrees(homeDir: string, ...names: string[]): void {
  for (const name of names) {
    const root = join(homeDir, 'plugins', name);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0' }),
    );
  }
}

/**
 * Replaces a byte of a plugin's tree the way Station itself does — inside the
 * per-plugin content lock — so the digest memo is invalidated by the same
 * mechanism production relies on rather than by a test-only escape hatch.
 */
async function mutatePluginTree(
  homeDir: string,
  name: string,
  contents: string,
): Promise<void> {
  const pluginsDir = join(homeDir, 'plugins');
  await withPluginContentLock(pluginsDir, name, async () => {
    writeFileSync(join(pluginsDir, name, 'server.mjs'), contents);
  });
}

describe('durable dependency ownership handoff', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0))
      rmSync(home, { recursive: true, force: true });
  });
  async function setupHandoff() {
    const home = mkdtempSync(join(tmpdir(), 'station-ownership-handoff-'));
    homes.push(home);
    seedPluginTrees(
      home,
      'creator',
      'consumer',
      'dependency',
      'other-creator',
      'other-dependency',
    );
    const plugins = join(home, 'plugins');
    const entry = {
      id: 'dependency',
      contentDigest: computePluginContentDigest(plugins, 'dependency')!,
    };
    await recordPluginDependencyOwnership(home, 'creator', [entry]);
    return {
      home,
      plugins,
      entry,
      recipientDigest: computePluginContentDigest(plugins, 'consumer')!,
    };
  }

  test('a matching digest without a source host claim cannot mint cleanup authority', async () => {
    const { home, entry, recipientDigest } = await setupHandoff();
    await expect(
      copyPluginDependencyOwnership(
        home,
        'other-creator',
        'consumer',
        entry,
        recipientDigest,
      ),
    ).rejects.toThrow('no matching host-owned source claim');
    expect(readPluginDependencyOwnership(home, 'consumer')).toEqual([]);
  });

  test('rollback restores authority only and preserves grants committed after handoff', async () => {
    const { home, entry, recipientDigest } = await setupHandoff();
    await grantPermissions(home, 'consumer', ['network.fetch']);
    const copied = await copyPluginDependencyOwnership(
      home,
      'creator',
      'consumer',
      entry,
      recipientDigest,
    );
    expect(copied.kind).toBe('copied');
    if (copied.kind !== 'copied') throw new Error('missing handoff');
    expect(getPluginGrants(home, 'consumer')).toEqual(['network.fetch']);
    await grantPermissions(home, 'consumer', ['ui.confirm']);
    await copied.handoff.rollback();
    await copied.handoff.rollback();
    expect(readPluginDependencyOwnership(home, 'consumer')).toEqual([]);
    expect(getPluginGrants(home, 'consumer')).toEqual(
      expect.arrayContaining(['network.fetch', 'ui.confirm']),
    );
    expect(readPluginDependencyOwnership(home, 'creator')).toEqual([entry]);
  });

  test('a later legitimate handoff blocks stale rollback, while reverse rollback remains possible', async () => {
    const { home, plugins, entry, recipientDigest } = await setupHandoff();
    const other = {
      id: 'other-dependency',
      contentDigest: computePluginContentDigest(plugins, 'other-dependency')!,
    };
    await recordPluginDependencyOwnership(home, 'other-creator', [other]);
    const first = await copyPluginDependencyOwnership(
      home,
      'creator',
      'consumer',
      entry,
      recipientDigest,
    );
    const second = await copyPluginDependencyOwnership(
      home,
      'other-creator',
      'consumer',
      other,
      recipientDigest,
    );
    if (first.kind !== 'copied' || second.kind !== 'copied')
      throw new Error('missing handoff');
    await expect(first.handoff.rollback()).rejects.toThrow(
      'changed after handoff',
    );
    expect(readPluginDependencyOwnership(home, 'consumer')).toEqual([
      entry,
      other,
    ]);
    await second.handoff.rollback();
    await first.handoff.rollback();
    expect(readPluginDependencyOwnership(home, 'consumer')).toEqual([]);
  });

  test('rollback cannot discard the last claim before the creator is restored', async () => {
    const { home, entry, recipientDigest } = await setupHandoff();
    const copied = await copyPluginDependencyOwnership(
      home,
      'creator',
      'consumer',
      entry,
      recipientDigest,
    );
    if (copied.kind !== 'copied') throw new Error('missing handoff');
    await removePluginHostRecord(home, 'creator');
    await expect(copied.handoff.rollback()).rejects.toThrow(
      'Original dependency custody must be restored',
    );
    expect(readPluginDependencyOwnership(home, 'consumer')).toEqual([entry]);
  });

  test('legacy unbound recipient grants are never rebound by a custody transfer', async () => {
    const { home, entry, recipientDigest } = await setupHandoff();
    const path = join(home, 'plugin-grants.json');
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.consumer = ['network.fetch'];
    writeFileSync(path, JSON.stringify(stored));
    await expect(
      copyPluginDependencyOwnership(
        home,
        'creator',
        'consumer',
        entry,
        recipientDigest,
      ),
    ).resolves.toEqual({ kind: 'ineligible' });
    expect(JSON.parse(readFileSync(path, 'utf8')).consumer).toEqual([
      'network.fetch',
    ]);
    expect(readPluginDependencyOwnership(home, 'creator')).toEqual([entry]);
  });

  test('managed recipients and exhausted ownership capacity cannot silently absorb claims', async () => {
    const { home, plugins, entry, recipientDigest } = await setupHandoff();
    await recordPluginDependencyOwnership(home, 'other-creator', [
      { id: 'consumer', contentDigest: recipientDigest },
    ]);
    await expect(
      copyPluginDependencyOwnership(
        home,
        'creator',
        'consumer',
        entry,
        recipientDigest,
      ),
    ).resolves.toEqual({ kind: 'ineligible' });
    await removePluginHostRecord(home, 'other-creator');
    const full = Array.from({ length: 256 }, (_, index) => ({
      id: `held-${index}`,
      contentDigest: computePluginContentDigest(plugins, 'other-dependency')!,
    }));
    await recordPluginDependencyOwnership(home, 'consumer', full);
    await expect(
      copyPluginDependencyOwnership(
        home,
        'creator',
        'consumer',
        entry,
        recipientDigest,
      ),
    ).resolves.toEqual({ kind: 'ineligible' });
    expect(readPluginDependencyOwnership(home, 'consumer')).toEqual(full);
    expect(readPluginDependencyOwnership(home, 'creator')).toEqual([entry]);
  });

  test('recipient mutation before its lock is acquired invalidates the proposed handoff', async () => {
    const { home, plugins, entry, recipientDigest } = await setupHandoff();
    let release!: () => void;
    let held = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutating = withPluginContentLock(plugins, 'consumer', async () => {
      held = true;
      await gate;
      writeFileSync(
        join(plugins, 'consumer', 'plugin.json'),
        JSON.stringify({ name: 'consumer', version: '2.0.0' }),
      );
    });
    await vi.waitFor(() => expect(held).toBe(true));
    const copying = copyPluginDependencyOwnership(
      home,
      'creator',
      'consumer',
      entry,
      recipientDigest,
    );
    try {
      await Promise.resolve();
      expect(readPluginDependencyOwnership(home, 'consumer')).toEqual([]);
    } finally {
      release();
      await mutating;
    }
    await expect(copying).resolves.toEqual({ kind: 'ineligible' });
    expect(readPluginDependencyOwnership(home, 'consumer')).toEqual([]);
  });
});

/** Every plugin name any fixture below records a grant for. */
const FIXTURE_PLUGINS = [
  'my-plugin',
  'p',
  'q',
  'other',
  'keeper',
  'a',
  'b',
  'first',
  'second',
  'real-plugin',
  'test-plugin',
];

// Wraps the REAL cross-process lock so tests can observe/act at acquire time
// (proving the read happens INSIDE the lock); every other behavior is real.
let onLockAcquire: ((lock: string) => void) | undefined;
vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLockAsync: async (
        lock: string,
        options?: Parameters<typeof actual.acquireFileMutationLockAsync>[1],
      ) => {
        const release = await actual.acquireFileMutationLockAsync(
          lock,
          options,
        );
        onLockAcquire?.(lock);
        return release;
      },
    };
  },
);

describe('permission tiers', () => {
  test('passive permissions', () => {
    expect(getPermissionTier('navigation.dock')).toBe('passive');
  });

  test('active permissions', () => {
    expect(getPermissionTier('network.fetch')).toBe('active');
  });

  test('trusted permissions', () => {
    expect(getPermissionTier('system.config')).toBe('trusted');
    expect(getPermissionTier('events.subscribe')).toBe('trusted');
    expect(getPermissionTier('events.read-payload')).toBe('trusted');
  });

  test('derives event subscription permissions from effective projection', () => {
    expect(
      requiredPermissionsForManifest({
        serverModule: 'server.mjs',
        operationalEventSubscriptions: [
          {
            id: 'metadata',
            version: '1.0.0',
            eventTypes: ['station.runtime.lifecycle/v1'],
            projection: 'metadata',
          },
        ],
      }),
    ).toEqual(expect.arrayContaining(['plugin.server', 'events.subscribe']));
    expect(
      requiredPermissionsForManifest({
        serverModule: 'server.mjs',
        operationalEventSubscriptions: [
          {
            id: 'payload',
            version: '1.0.0',
            eventTypes: ['station.runtime.lifecycle/v1'],
            projection: 'envelope',
          },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        'plugin.server',
        'events.subscribe',
        'events.read-payload',
      ]),
    );
  });

  test('unknown defaults to trusted', () => {
    expect(getPermissionTier('unknown.perm')).toBe('trusted');
  });

  test('needsConsent false for passive', () => {
    expect(needsConsent('navigation.dock')).toBe(false);
  });

  test('needsConsent true for active/trusted', () => {
    expect(needsConsent('network.fetch')).toBe(true);
    expect(needsConsent('system.config')).toBe(true);
  });
});

describe('grants storage', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perm-test-'));
    seedPluginTrees(dir, ...FIXTURE_PLUGINS);
  });

  afterEach(() => {
    onLockAcquire = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test('getPluginGrants returns empty for unknown plugin', () => {
    expect(getPluginGrants(dir, 'unknown')).toEqual([]);
  });

  test('grantPermissions and hasGrant round-trip', async () => {
    await grantPermissions(dir, 'my-plugin', [
      'navigation.dock',
      'network.fetch',
    ]);
    expect(hasGrant(dir, 'my-plugin', 'navigation.dock')).toBe(true);
    expect(hasGrant(dir, 'my-plugin', 'network.fetch')).toBe(true);
    expect(hasGrant(dir, 'my-plugin', 'system.config')).toBe(false);
  });

  test('station#3815: revokeGrants withdraws exactly what was named and leaves the rest', async () => {
    await grantPermissions(dir, 'my-plugin', [
      'navigation.dock',
      'network.fetch',
      'plugin.server',
    ]);

    await revokeGrants(dir, 'my-plugin', ['network.fetch']);
    expect(hasGrant(dir, 'my-plugin', 'network.fetch')).toBe(false);
    expect(hasGrant(dir, 'my-plugin', 'navigation.dock')).toBe(true);
    // Every tier can be withdrawn here, `trusted` included: granting
    // plugin.server needs the isolated review channel, but taking it back
    // only narrows what the plugin may do.
    await revokeGrants(dir, 'my-plugin', ['plugin.server']);
    expect(hasGrant(dir, 'my-plugin', 'plugin.server')).toBe(false);
    expect(getPluginGrants(dir, 'my-plugin')).toEqual(['navigation.dock']);
  });

  test('station#3815: revoking is idempotent, and revoking the last grant leaves the same shape as revokeAllGrants', async () => {
    await grantPermissions(dir, 'p', ['a']);
    await revokeGrants(dir, 'p', ['a']);
    // Asking twice, and asking for something never granted, both leave the
    // caller's intent satisfied rather than erroring.
    await revokeGrants(dir, 'p', ['a']);
    await revokeGrants(dir, 'p', ['never-granted']);
    expect(getPluginGrants(dir, 'p')).toEqual([]);

    await grantPermissions(dir, 'q', ['a']);
    await revokeAllGrants(dir, 'q');
    expect(getPluginGrants(dir, 'q')).toEqual([]);
  });

  test('station#3815: an empty revoke list is a no-op that does not touch other plugins', async () => {
    await grantPermissions(dir, 'p', ['a']);
    await grantPermissions(dir, 'other', ['b']);
    await revokeGrants(dir, 'p', []);
    expect(getPluginGrants(dir, 'p')).toEqual(['a']);
    expect(getPluginGrants(dir, 'other')).toEqual(['b']);
  });

  test('grantPermissions is additive', async () => {
    await grantPermissions(dir, 'p', ['a']);
    await grantPermissions(dir, 'p', ['b']);
    expect(getPluginGrants(dir, 'p')).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
  });

  test('revokeAllGrants removes all', async () => {
    await grantPermissions(dir, 'p', ['a', 'b']);
    await revokeAllGrants(dir, 'p');
    expect(getPluginGrants(dir, 'p')).toEqual([]);
  });
});

describe('fail-closed grants storage (#1835)', () => {
  let dir: string;
  let grantsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perm-fc-test-'));
    seedPluginTrees(dir, ...FIXTURE_PLUGINS);
    grantsFile = join(dir, 'plugin-grants.json');
  });

  afterEach(() => {
    onLockAcquire = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test('a missing store still reads as empty — absence is not an error', () => {
    expect(getPluginGrants(dir, 'anything')).toEqual([]);
    expect(hasGrant(dir, 'anything', 'navigation.dock')).toBe(false);
    expect(hasGrantOrThrow(dir, 'anything', 'navigation.dock')).toBe(false);
  });

  test('corrupt store: grantPermissions throws and leaves the on-disk bytes unchanged; restoring the file restores the grants', async () => {
    await grantPermissions(dir, 'keeper', ['navigation.dock']);
    const validBytes = readFileSync(grantsFile);
    corruptFile(grantsFile);

    await expect(
      grantPermissions(dir, 'other', ['navigation.dock']),
    ).rejects.toThrow(PluginGrantsUnavailableError);
    // The corrupt bytes were not overwritten (and not renamed away: with no
    // valid `.previous`, the primary stays in place so reads keep failing
    // closed instead of degrading to the empty default).
    expect(readFileSync(grantsFile, 'utf-8')).toBe('not json');

    writeFileSync(grantsFile, validBytes);
    expect(getPluginGrants(dir, 'keeper')).toEqual(['navigation.dock']);
  });

  test('corrupt store: revokeAllGrants throws instead of writing a total consent wipe', async () => {
    await grantPermissions(dir, 'keeper', ['navigation.dock']);
    corruptFile(grantsFile, '{ definitely not json');

    await expect(revokeAllGrants(dir, 'keeper')).rejects.toThrow(
      PluginGrantsUnavailableError,
    );
    expect(readFileSync(grantsFile, 'utf-8')).toBe('{ definitely not json');
  });

  test.each(
    reservedKeyShapes()
      .filter(({ label }) =>
        ['null literal', 'array', 'string', 'string-valued entry'].includes(
          label,
        ),
      )
      .map(({ label, content }) => [label, content]),
  )('ill-shaped store (%s) throws instead of coercing', (_label, content) => {
    writeFileSync(grantsFile, content);
    expect(() => getPluginGrants(dir, 'p')).toThrow(
      PluginGrantsUnavailableError,
    );
  });

  test('a string-valued entry can not substring-match into a grant: hasGrant denies with an error log', () => {
    // Pre-fix, {"p": "providers.register"} made hasGrant('p',
    // 'providers.register') true via String.prototype.includes.
    writeFileSync(grantsFile, '{"p":"providers.register"}');
    const deniedLogger = { error: vi.fn() };

    expect(hasGrant(dir, 'p', 'providers.register', deniedLogger)).toBe(false);
    expect(deniedLogger.error).toHaveBeenCalledWith(
      'Plugin grants store unavailable; denying permission check',
      expect.objectContaining({
        path: grantsFile,
        plugin: 'p',
        permission: 'providers.register',
      }),
    );
    expect(() => hasGrantOrThrow(dir, 'p', 'providers.register')).toThrow(
      PluginGrantsUnavailableError,
    );
  });

  test('torn write: reads keep failing closed; `.previous` is forensic material for EXPLICIT recovery only', async () => {
    await grantPermissions(dir, 'a', ['navigation.dock']);
    await grantPermissions(dir, 'b', ['network.fetch']); // second write retains `.previous`
    const { truncated } = truncatePrimaryKeepPrevious(grantsFile);

    // Every read fails closed — repeatedly. Nothing is quarantined and
    // `.previous` is never auto-consumed (it is one write out of date and may
    // hold since-revoked consent).
    expect(() => getPluginGrants(dir, 'a')).toThrow(
      PluginGrantsUnavailableError,
    );
    expect(() => getPluginGrants(dir, 'a')).toThrow(
      PluginGrantsUnavailableError,
    );
    expect(
      readdirSync(dir).filter((name) => name.includes('quarantine')),
    ).toEqual([]);
    // The corrupt bytes stay in place for inspection, and `.previous` holds
    // the last complete value (the state before write #2) for the operator.
    expect(readFileSync(grantsFile, 'utf-8')).toBe(truncated);
    expect(
      JSON.parse(readFileSync(`${grantsFile}.previous`, 'utf-8')).a.permissions,
    ).toEqual(['navigation.dock']);
    // Explicit operator recovery (a human copies `.previous` into place after
    // review) restores service.
    writeFileSync(grantsFile, readFileSync(`${grantsFile}.previous`));
    expect(getPluginGrants(dir, 'a')).toEqual(['navigation.dock']);
  });

  test('a corrupt primary never resurrects consent revoked after the `.previous` write (#1835 review finding 1)', async () => {
    await grantPermissions(dir, 'p', ['providers.register']);
    await grantPermissions(dir, 'other', ['navigation.dock']);
    await revokeAllGrants(dir, 'p'); // `.previous` now holds p's GRANTED version
    expect(
      JSON.parse(readFileSync(`${grantsFile}.previous`, 'utf-8')).p.permissions,
    ).toEqual(['providers.register']);
    corruptFile(grantsFile);

    // Reads must fail closed forever — auto-consuming `.previous` here would
    // hand 'p' back its revoked providers.register grant.
    expect(() => getPluginGrants(dir, 'p')).toThrow(
      PluginGrantsUnavailableError,
    );
    expect(hasGrant(dir, 'p', 'providers.register', { error: vi.fn() })).toBe(
      false,
    );
    expect(hasGrant(dir, 'p', 'providers.register', { error: vi.fn() })).toBe(
      false,
    );
    expect(
      readdirSync(dir).filter((name) => name.includes('quarantine')),
    ).toEqual([]);
  });

  test('primary missing while `.previous` exists is a torn state, not absence (#1835 review finding 1)', async () => {
    await grantPermissions(dir, 'p', ['providers.register']);
    await grantPermissions(dir, 'p', ['navigation.dock']); // second write retains `.previous`
    rmSync(grantsFile);

    // Neither the empty default nor `.previous` content may be served.
    expect(() => getPluginGrants(dir, 'p')).toThrow(
      PluginGrantsUnavailableError,
    );
    expect(hasGrant(dir, 'p', 'providers.register', { error: vi.fn() })).toBe(
      false,
    );
  });

  test.skipIf(process.platform === 'win32')(
    'a dangling symlink where the primary should be fails closed, not empty (#1835 review finding 4)',
    () => {
      danglingSymlink(grantsFile);
      expect(() => getPluginGrants(dir, 'p')).toThrow(
        PluginGrantsUnavailableError,
      );
    },
  );

  test.each(
    reservedKeyShapes()
      .filter(({ label }) => label.endsWith(' key'))
      .map(({ label }) => label.replace(' key', '')),
  )(
    'reserved key %s is rejected as a mutation target with nothing written (#1835 review finding 3)',
    async (key) => {
      await expect(
        grantPermissions(dir, key, ['navigation.dock']),
      ).rejects.toThrow(GrantsStoreReservedKeyError);
      expect(existsSync(grantsFile)).toBe(false);
    },
  );

  test('Object.prototype member names read as absent entries, not inherited values (#1835 review finding 3)', async () => {
    await grantPermissions(dir, 'real-plugin', ['navigation.dock']);
    // Pre-fix, grants['constructor'] answered Object.prototype.constructor
    // and `new Set(<that>)` threw a TypeError (availability failure).
    expect(getPluginGrants(dir, 'constructor')).toEqual([]);
    expect(hasGrant(dir, 'constructor', 'navigation.dock')).toBe(false);
    expect(getPluginGrants(dir, 'toString')).toEqual([]);
  });

  test('stored content containing a reserved key fails closed (#1835 review finding 3)', () => {
    corruptFile(
      grantsFile,
      reservedKeyShapes().find(({ label }) => label === '__proto__ key')!
        .content,
    );
    expect(() => getPluginGrants(dir, 'anything')).toThrow(
      PluginGrantsUnavailableError,
    );
  });

  test.skipIf(skipIfCannotChmod)(
    'unreadable store file (chmod 000): reads throw, hasGrant denies loudly, file is preserved',
    async () => {
      await grantPermissions(dir, 'keeper', ['navigation.dock']);
      const validBytes = readFileSync(grantsFile, 'utf-8');
      await withUnreadable(grantsFile, () => {
        const deniedLogger = { error: vi.fn() };
        expect(() => getPluginGrants(dir, 'keeper')).toThrow(
          PluginGrantsUnavailableError,
        );
        expect(hasGrant(dir, 'keeper', 'navigation.dock', deniedLogger)).toBe(
          false,
        );
        expect(deniedLogger.error).toHaveBeenCalled();
      });
      expect(readFileSync(grantsFile, 'utf-8')).toBe(validBytes);
      expect(getPluginGrants(dir, 'keeper')).toEqual(['navigation.dock']);
    },
  );

  test.skipIf(skipIfCannotChmod)(
    'unreadable parent directory (chmod 000): reads throw instead of reading as empty',
    async () => {
      // Pre-fix, existsSync() swallowed the EACCES and the store read as {}.
      await grantPermissions(dir, 'keeper', ['navigation.dock']);
      await withUnreadable(dir, async () => {
        expect(() => getPluginGrants(dir, 'keeper')).toThrow(
          PluginGrantsUnavailableError,
        );
        expect(
          hasGrant(dir, 'keeper', 'navigation.dock', { error: vi.fn() }),
        ).toBe(false);
        // The MUTATE path's infrastructure failures (lock file creation under
        // an unreadable parent) surface as the SAME typed error the call
        // sites catch — never a raw EACCES (archive#1835 review finding 5).
        await expect(
          grantPermissions(dir, 'keeper', ['tools.invoke']),
        ).rejects.toThrow(PluginGrantsUnavailableError);
      });
      expect(getPluginGrants(dir, 'keeper')).toEqual(['navigation.dock']);
    },
  );

  test('read-modify-write is serialized: a write committed just before the lock is acquired survives', async () => {
    await grantPermissions(dir, 'first', ['navigation.dock']);
    // Simulate another process committing between our call and our lock
    // acquisition. Because the read happens INSIDE the lock, the concurrent
    // entry must survive our write.
    const wasInterleaved = interleaveOnceOnLockAcquire(
      (hook) => {
        onLockAcquire = hook;
      },
      () => {
        const current = JSON.parse(readFileSync(grantsFile, 'utf-8'));
        current.sneaky = ['tools.invoke'];
        writeFileSync(grantsFile, JSON.stringify(current, null, 2));
      },
    );

    await grantPermissions(dir, 'second', ['network.fetch']);

    expect(wasInterleaved()).toBe(true);
    const final = JSON.parse(readFileSync(grantsFile, 'utf-8'));
    expect(Object.keys(final).sort()).toEqual(['first', 'second', 'sneaky']);
    expect(final.first.permissions).toEqual(['navigation.dock']);
    expect(final.second.permissions).toEqual(['network.fetch']);
    // The concurrently-written LEGACY-shaped entry survives verbatim: a
    // read-modify-write must not rewrite rows it is not about (archive#4288
    // keeps archive#1835's invariant true across the shape change).
    expect(final.sneaky).toEqual(['tools.invoke']);
  });

  test('write invariant: a mutation may not drop entries other than its own key', async () => {
    const store = new GrantsFileStore<Record<string, unknown>>({
      filePath: join(dir, 'invariant.json'),
      storeLabel: 'test-invariant',
      shapeProblems: () => [],
      makeUnavailableError: (storePath, detail, cause) =>
        new GrantsStoreUnavailableError(storePath, detail, { cause }),
      emptyValue: {},
    });
    await store.mutate('a', (value) => ({ ...value, a: 1 }));
    await store.mutate('b', (value) => ({ ...value, b: 2 }));

    await expect(store.mutate('a', () => ({ a: 3 }))).rejects.toThrow(
      /would drop unrelated entries \[b\]/,
    );
    // Nothing was written by the refused mutation.
    expect(store.read()).toEqual({ a: 1, b: 2 });
  });

  test('write invariant uses own-key semantics: a row named after an Object.prototype member cannot vanish undetected (#1835 review finding 8)', async () => {
    const store = new GrantsFileStore<Record<string, unknown>>({
      filePath: join(dir, 'invariant-own.json'),
      storeLabel: 'test-invariant-own',
      shapeProblems: () => [],
      makeUnavailableError: (storePath, detail, cause) =>
        new GrantsStoreUnavailableError(storePath, detail, { cause }),
      emptyValue: {},
    });
    await store.mutate('toString', (value) => ({ ...value, toString: ['x'] }));
    await store.mutate('a', (value) => ({ ...value, a: 1 }));

    // Pre-fix (`key in next`), the inherited Object.prototype.toString made
    // the dropped own row invisible to the invariant.
    await expect(store.mutate('a', () => ({ a: 2 }))).rejects.toThrow(
      /would drop unrelated entries \[toString\]/,
    );
    expect(store.read()).toEqual({ toString: ['x'], a: 1 });
  });
});

describe('processInstallPermissions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'install-perm-test-'));
    seedPluginTrees(dir, ...FIXTURE_PLUGINS);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('auto-grants passive, returns active/trusted as pending', async () => {
    const result = await processInstallPermissions(dir, 'test-plugin', [
      'navigation.dock',
      'network.fetch',
      'system.config',
    ]);
    expect(result.autoGranted).toEqual(['navigation.dock']);
    expect(result.pendingConsent).toEqual([
      { permission: 'network.fetch', tier: 'active' },
      { permission: 'system.config', tier: 'trusted' },
    ]);
    expect(hasGrant(dir, 'test-plugin', 'navigation.dock')).toBe(true);
    expect(hasGrant(dir, 'test-plugin', 'network.fetch')).toBe(false);
  });

  test('a corrupt store fails the passive auto-grant instead of proceeding', async () => {
    corruptFile(join(dir, 'plugin-grants.json'));
    await expect(
      processInstallPermissions(dir, 'test-plugin', ['navigation.dock']),
    ).rejects.toThrow(PluginGrantsUnavailableError);
  });
});

/**
 * archive#4288 — an update must not inherit the consent given to the code it
 * replaces.
 *
 * The defect: `POST /:name/update` replaced a plugin's code, agents,
 * integrations and providers, and the grants recorded against the reviewed
 * bytes carried over to bytes nobody reviewed. Consent was attached to a
 * permission NAME; these tests pin it to CONTENT.
 */
describe('grants are bound to plugin content (station#4288)', () => {
  let dir: string;
  let grantsFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perm-digest-test-'));
    seedPluginTrees(dir, 'bound-plugin', 'legacy-plugin');
    grantsFile = join(dir, 'plugin-grants.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('acceptance 1: a grant records the content digest it was granted against', async () => {
    await grantPermissions(dir, 'bound-plugin', [
      'network.fetch',
      'navigation.dock',
    ]);

    const stored = JSON.parse(readFileSync(grantsFile, 'utf-8'));
    expect(stored['bound-plugin'].permissions).toEqual(
      expect.arrayContaining(['network.fetch', 'navigation.dock']),
    );
    expect(stored['bound-plugin'].contentDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );

    const state = readPluginGrantState(dir, 'bound-plugin');
    expect(state.binding).toBe('bound');
    expect(state.recordedDigest).toBe(state.currentDigest);
    expect(state.withheld).toEqual([]);
    expect(state.granted).toEqual(
      expect.arrayContaining(['network.fetch', 'navigation.dock']),
    );
  });

  test('permission revocation preserves host-owned dependency authority until uninstall completes', async () => {
    seedPluginTrees(dir, 'owned-dependency');
    const dependencyDigest = computePluginContentDigest(
      join(dir, 'plugins'),
      'owned-dependency',
    );
    expect(dependencyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    if (!dependencyDigest) throw new Error('fixture dependency was unreadable');
    await grantPermissions(dir, 'bound-plugin', ['navigation.dock']);
    await recordPluginDependencyOwnership(dir, 'bound-plugin', [
      {
        id: 'owned-dependency',
        contentDigest: dependencyDigest,
      },
    ]);

    await revokeAllGrants(dir, 'bound-plugin');

    expect(getPluginGrants(dir, 'bound-plugin')).toEqual([]);
    expect(readPluginDependencyOwnership(dir, 'bound-plugin')).toEqual([
      { id: 'owned-dependency', contentDigest: dependencyDigest },
    ]);

    await removePluginHostRecord(dir, 'bound-plugin');
    expect(readPluginDependencyOwnership(dir, 'bound-plugin')).toEqual([]);
  });

  test('acceptance 2: a tree that changed under a grant is detected, and EVERY permission stops applying', async () => {
    await grantPermissions(dir, 'bound-plugin', [
      'network.fetch',
      'plugin.server',
      'navigation.dock',
    ]);
    expect(hasGrant(dir, 'bound-plugin', 'plugin.server')).toBe(true);

    // The replacement happens through the same per-plugin content lock the
    // update and uninstall routes take, which is what production does.
    await mutatePluginTree(dir, 'bound-plugin', 'export const evil = 1;\n');

    const state = readPluginGrantState(dir, 'bound-plugin');
    expect(state.binding).toBe('changed');
    expect(state.currentDigest).not.toBe(state.recordedDigest);
    // Everything that ever needed consent is withheld...
    expect(hasGrant(dir, 'bound-plugin', 'plugin.server')).toBe(false);
    expect(hasGrantOrThrow(dir, 'bound-plugin', 'network.fetch')).toBe(false);
    // ...and so is the PASSIVE one. `changed` is positive evidence that the
    // bytes the record attests to are gone, and that is true of every name in
    // the record regardless of what any particular caller could spend it on.
    // (The rebuttal this comment used to carry — the isolated frame's
    // `api-request` bridge turning any surviving name into a credentialed
    // `/api/` call — named a bridge archive#4300 deleted.)
    expect(hasGrant(dir, 'bound-plugin', 'navigation.dock')).toBe(false);
    expect(state.granted).toEqual([]);
    expect(state.withheld.sort()).toEqual([
      'navigation.dock',
      'network.fetch',
      'plugin.server',
    ]);
    // The RECORD is untouched — a read path withholds, it does not revoke.
    expect(state.recorded.sort()).toEqual([
      'navigation.dock',
      'network.fetch',
      'plugin.server',
    ]);
  });

  test('review HIGH 1: granting one permission does not re-bless everything the changed tree withheld', async () => {
    // The plugin holds a trusted permission and an active one, both approved
    // for v1's bytes.
    await grantPermissions(dir, 'bound-plugin', [
      'plugin.server',
      'ui.confirm',
    ]);
    await mutatePluginTree(dir, 'bound-plugin', 'export const evil = 1;\n');
    expect(readPluginGrantState(dir, 'bound-plugin').binding).toBe('changed');
    expect(getPluginGrants(dir, 'bound-plugin')).toEqual([]);

    // The operator approves ONE ordinary permission for the new code. This is
    // the only thing `POST /:name/grant` can do — it 403s trusted permissions
    // outright ("Trusted plugin permissions require an isolated host approval
    // channel").
    await grantPermissions(dir, 'bound-plugin', ['ui.confirm']);

    const state = readPluginGrantState(dir, 'bound-plugin');
    expect(state.binding).toBe('bound');
    // Only what was consented to now. Re-stamping the whole record with the
    // new digest would have handed `plugin.server` back against bytes nobody
    // reviewed, through a route that is not allowed to grant it at all.
    expect(state.granted).toEqual(['ui.confirm']);
    expect(state.recorded).not.toContain('plugin.server');
    expect(hasGrant(dir, 'bound-plugin', 'plugin.server')).toBe(false);
  });

  test.each(['bound', 'unverified'] as const)(
    'review HIGH 1: from %s, granting still ADDS to what is already held',
    async (binding) => {
      if (binding === 'unverified') {
        writeFileSync(
          grantsFile,
          JSON.stringify({ 'bound-plugin': ['plugin.server'] }),
        );
      } else {
        await grantPermissions(dir, 'bound-plugin', ['plugin.server']);
      }
      expect(readPluginGrantState(dir, 'bound-plugin').binding).toBe(binding);

      await grantPermissions(dir, 'bound-plugin', ['ui.confirm']);

      // Withdrawing on a grant is the `changed` case ONLY. Absence of a
      // mismatch is not evidence of one.
      expect(getPluginGrants(dir, 'bound-plugin').sort()).toEqual([
        'plugin.server',
        'ui.confirm',
      ]);
    },
  );

  test('acceptance 2: a tree that cannot be digested at all is `changed`, never `bound`', async () => {
    await grantPermissions(dir, 'bound-plugin', ['plugin.server']);
    await withPluginContentLock(
      join(dir, 'plugins'),
      'bound-plugin',
      async () => {
        rmSync(join(dir, 'plugins', 'bound-plugin'), {
          recursive: true,
          force: true,
        });
      },
    );

    const state = readPluginGrantState(dir, 'bound-plugin');
    expect(state.currentDigest).toBeNull();
    expect(state.binding).toBe('changed');
    expect(hasGrant(dir, 'bound-plugin', 'plugin.server')).toBe(false);
  });

  /**
   * The invariant the permissions panel depends on (archive#4288, delta
   * review LOW 2). `changed` is only reachable for a plugin that HAS recorded
   * permissions, and it withholds all of them, so `changed` with an empty
   * `withheld` is a state the derivation cannot produce. That is what makes
   * a "nothing needed re-approval" fallback in the UI both dead AND a verdict
   * the server never computed — the panel renders the withheld names with no
   * fallback branch at all.
   */
  test('station#4288: `changed` always carries a non-empty `withheld`; an empty record is `none`, never `changed`', async () => {
    // Nothing recorded, and a tree that cannot be digested at all — the most
    // `changed`-looking input there is.
    rmSync(join(dir, 'plugins', 'legacy-plugin'), {
      recursive: true,
      force: true,
    });
    const unrecorded = readPluginGrantState(dir, 'legacy-plugin');
    expect(unrecorded.binding).toBe('none');
    expect(unrecorded.withheld).toEqual([]);

    await grantPermissions(dir, 'bound-plugin', [
      'navigation.dock',
      'plugin.server',
    ]);
    await withPluginContentLock(
      join(dir, 'plugins'),
      'bound-plugin',
      async () => {
        writeFileSync(
          join(dir, 'plugins', 'bound-plugin', 'server.mjs'),
          'export const x = 9;\n',
        );
      },
    );
    const changed = readPluginGrantState(dir, 'bound-plugin');
    expect(changed.binding).toBe('changed');
    expect(changed.withheld.sort()).toEqual([
      'navigation.dock',
      'plugin.server',
    ]);
    expect(changed.withheld).toEqual(changed.recorded);
  });

  test('acceptance 3: an update that newly derives a permission does not inherit consent for it', async () => {
    // v1 declares no serverModule; the operator approved providers.register.
    await grantPermissions(dir, 'bound-plugin', [
      'providers.register',
      'navigation.dock',
    ]);

    // v2 replaces the code AND contributes a serverModule for the first time.
    await mutatePluginTree(
      dir,
      'bound-plugin',
      'export function register() {}',
    );
    const v2 = {
      permissions: ['navigation.dock'],
      providers: [{ type: 'model', module: 'p.mjs' }],
      serverModule: 'server.mjs',
    };
    expect(requiredPermissionsForManifest(v2)).toEqual(
      expect.arrayContaining(['plugin.server', 'providers.register']),
    );

    const outcome = await rebindGrantsAfterContentChange(
      dir,
      'bound-plugin',
      v2,
    );

    // The newly-derived permission was never granted for this code...
    expect(outcome.retained).not.toContain('plugin.server');
    expect(getPluginGrants(dir, 'bound-plugin')).not.toContain('plugin.server');
    // ...and the trusted permission granted for the OLD code did not survive
    // the replacement either.
    expect(outcome.withdrawn).toContain('providers.register');
    expect(getPluginGrants(dir, 'bound-plugin')).toEqual(['navigation.dock']);
    // The record is now bound to the NEW bytes, so nothing reads `changed`.
    expect(readPluginGrantState(dir, 'bound-plugin').binding).toBe('bound');
  });

  test('acceptance 3: rebinding drops a passive permission the new manifest no longer declares', async () => {
    // Passive is the interesting case: it is auto-granted with no prompt, so
    // "the operator already said yes once" is the weakest possible reason to
    // keep it across a content change the new manifest no longer justifies.
    // Written with a single grant since archive#4301 retired `storage.read`,
    // leaving `navigation.dock` as the only passive permission in the
    // vocabulary. The retained-non-empty path is covered by the preceding
    // acceptance, which keeps `navigation.dock` because v2 still declares it.
    await grantPermissions(dir, 'bound-plugin', ['navigation.dock']);
    await mutatePluginTree(dir, 'bound-plugin', 'export const v = 2;\n');

    const outcome = await rebindGrantsAfterContentChange(dir, 'bound-plugin', {
      permissions: [],
    });

    expect(outcome.retained).toEqual([]);
    expect(outcome.withdrawn).toEqual(['navigation.dock']);
    expect(getPluginGrants(dir, 'bound-plugin')).toEqual([]);
  });

  test('acceptance 4: a pre-existing grant with no digest keeps working, and says so', () => {
    // Exactly what an upgrade finds on disk: the legacy array shape.
    writeFileSync(
      grantsFile,
      JSON.stringify({ 'legacy-plugin': ['plugin.server', 'network.fetch'] }),
    );

    const state = readPluginGrantState(dir, 'legacy-plugin');
    // The migration decision: absence of evidence is not evidence of
    // tampering, so the grant stands...
    expect(state.binding).toBe('unverified');
    expect(state.recordedDigest).toBeNull();
    expect(state.withheld).toEqual([]);
    expect(state.granted.sort()).toEqual(['network.fetch', 'plugin.server']);
    expect(hasGrant(dir, 'legacy-plugin', 'plugin.server')).toBe(true);
    // ...and `unverified` is a state a person can see, not an internal one.
    expect(state.binding).not.toBe('bound');
  });

  test('acceptance 4: an unverified grant becomes bound on the next consent write for that plugin', async () => {
    writeFileSync(
      grantsFile,
      JSON.stringify({ 'legacy-plugin': ['navigation.dock'] }),
    );
    expect(readPluginGrantState(dir, 'legacy-plugin').binding).toBe(
      'unverified',
    );

    await grantPermissions(dir, 'legacy-plugin', ['network.fetch']);

    const state = readPluginGrantState(dir, 'legacy-plugin');
    expect(state.binding).toBe('bound');
    expect(state.recordedDigest).toBe(state.currentDigest);
    expect(state.granted.sort()).toEqual(['navigation.dock', 'network.fetch']);
  });

  test('acceptance 4: revoking does NOT silently re-bind an unverified grant', async () => {
    writeFileSync(
      grantsFile,
      JSON.stringify({
        'legacy-plugin': ['navigation.dock', 'network.fetch'],
      }),
    );

    await revokeGrants(dir, 'legacy-plugin', ['network.fetch']);

    // Withdrawing a permission says nothing about the bytes the survivors
    // were granted against; claiming otherwise would be a digest nobody
    // consented to.
    const record = readPluginGrantRecord(dir, 'legacy-plugin');
    expect(record.permissions).toEqual(['navigation.dock']);
    expect(record.contentDigest).toBeNull();
    expect(readPluginGrantState(dir, 'legacy-plugin').binding).toBe(
      'unverified',
    );
  });

  test.each([
    [
      'record with no digest field',
      '{"bound-plugin":{"permissions":["plugin.server"]}}',
    ],
    [
      'non-string digest',
      '{"bound-plugin":{"permissions":["plugin.server"],"contentDigest":42}}',
    ],
    [
      'empty digest',
      '{"bound-plugin":{"permissions":["plugin.server"],"contentDigest":""}}',
    ],
    [
      'digest without permissions',
      '{"bound-plugin":{"contentDigest":"sha256:aa"}}',
    ],
    [
      'non-string permission inside a bound record',
      '{"bound-plugin":{"permissions":[1],"contentDigest":"sha256:aa"}}',
    ],
    ['record nested one level too deep', '{"bound-plugin":{"grants":["a"]}}'],
  ])(
    'acceptance 5: an ill-shaped bound record (%s) fails closed rather than reading as a grant',
    (_label, content) => {
      writeFileSync(grantsFile, content);

      expect(() => readPluginGrantState(dir, 'bound-plugin')).toThrow(
        PluginGrantsUnavailableError,
      );
      expect(() => getPluginGrants(dir, 'bound-plugin')).toThrow(
        PluginGrantsUnavailableError,
      );
      // The non-throwing enforcement predicate denies rather than allowing.
      expect(
        hasGrant(dir, 'bound-plugin', 'plugin.server', { error: vi.fn() }),
      ).toBe(false);
    },
  );

  test('acceptance 5: a grant is refused outright when the tree cannot be digested — never stored unbound', async () => {
    await expect(
      grantPermissions(dir, 'never-installed', ['network.fetch']),
    ).rejects.toThrow(PluginContentUnavailableError);
    expect(existsSync(grantsFile)).toBe(false);
  });

  test('a plugin with no recorded grants never walks its tree', () => {
    const state = readPluginGrantState(dir, 'bound-plugin');
    expect(state.binding).toBe('none');
    expect(state.currentDigest).toBeNull();
    expect(state.granted).toEqual([]);
  });

  test('the binding is per plugin: one changed tree does not withhold another plugin’s grants', async () => {
    await grantPermissions(dir, 'bound-plugin', ['network.fetch']);
    await grantPermissions(dir, 'legacy-plugin', ['network.fetch']);

    await mutatePluginTree(dir, 'bound-plugin', 'export const v = 3;\n');

    expect(hasGrant(dir, 'bound-plugin', 'network.fetch')).toBe(false);
    expect(hasGrant(dir, 'legacy-plugin', 'network.fetch')).toBe(true);
  });
});
