import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  computePluginContentDigest,
  PluginContentLockCycleError,
  pluginContentDigest,
  withPluginContentLock,
} from '../../../services/plugins/plugin-content-integrity.js';
import { installPluginDependency } from '../plugin-source.js';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-plugin-source-'));
  cleanupDirs.push(root);
  return root;
}

function writePluginSource(
  root: string,
  name: string,
  manifest: object,
): string {
  const sourceDir = join(root, name);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'plugin.json'), JSON.stringify(manifest));
  return sourceDir;
}

function deps() {
  return {
    buildPlugin: vi.fn(async () => undefined),
    getAgentRegistryProvider: vi.fn(() => ({
      install: vi.fn(async () => ({
        message: 'registry unavailable',
        success: false,
      })),
    })),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
      setLevel: vi.fn(),
      getLevel: vi.fn(() => 'info' as const),
    },
  };
}

describe('installPluginDependency', () => {
  test('rejects dependency ids that escape the plugin root without touching siblings', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const victimDir = join(root, 'victim');
    mkdirSync(victimDir, { recursive: true });
    writeFileSync(join(victimDir, 'keep.txt'), 'keep');
    const sourceDir = writePluginSource(root, 'escape-source', {
      name: '../victim',
      version: '1.0.0',
    });
    const { buildPlugin, getAgentRegistryProvider, logger } = deps();

    const result = await installPluginDependency(
      { id: '../victim', source: sourceDir },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(readFileSync(join(victimDir, 'keep.txt'), 'utf-8')).toBe('keep');
    expect(buildPlugin).not.toHaveBeenCalled();
  });

  test('does not promote a source dependency when a transitive dependency fails', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const sourceDir = writePluginSource(root, 'parent-dep-source', {
      dependencies: [{ id: '../escape' }],
      name: 'parent-dep',
      version: '1.0.0',
    });
    const { buildPlugin, getAgentRegistryProvider, logger } = deps();

    const result = await installPluginDependency(
      { id: 'parent-dep', source: sourceDir },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(existsSync(join(pluginsDir, 'parent-dep'))).toBe(false);
  });

  test('rejects a self-referential dependency cycle without promotion', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const sourceDir = writePluginSource(root, 'cycle-source', {
      dependencies: [{ id: 'cycle-dep', source: join(root, 'cycle-source') }],
      name: 'cycle-dep',
      version: '1.0.0',
    });
    const { buildPlugin, getAgentRegistryProvider, logger } = deps();

    const result = await installPluginDependency(
      { id: 'cycle-dep', source: sourceDir },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('cycle'),
    });
    expect(existsSync(join(pluginsDir, 'cycle-dep'))).toBe(false);
  });

  test('rejects a mutual dependency cycle without promoting either dependency', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const alphaSource = writePluginSource(root, 'alpha-source', {
      dependencies: [{ id: 'beta-dep', source: join(root, 'beta-source') }],
      name: 'alpha-dep',
      version: '1.0.0',
    });
    writePluginSource(root, 'beta-source', {
      dependencies: [{ id: 'alpha-dep', source: alphaSource }],
      name: 'beta-dep',
      version: '1.0.0',
    });
    const { buildPlugin, getAgentRegistryProvider, logger } = deps();

    const result = await installPluginDependency(
      { id: 'alpha-dep', source: alphaSource },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('cycle'),
    });
    expect(existsSync(join(pluginsDir, 'alpha-dep'))).toBe(false);
    expect(existsSync(join(pluginsDir, 'beta-dep'))).toBe(false);
  });

  test('rejects an installed dependency when the target is a symlink outside the plugin root', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const outsideDir = writePluginSource(root, 'outside-dep-source', {
      name: 'outside-dep',
      version: '1.0.0',
    });
    mkdirSync(pluginsDir, { recursive: true });
    symlinkSync(outsideDir, join(pluginsDir, 'outside-dep'), 'dir');
    const { buildPlugin, getAgentRegistryProvider, logger } = deps();

    const result = await installPluginDependency(
      { id: 'outside-dep' },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('escapes root');
    expect(buildPlugin).not.toHaveBeenCalled();
  });

  test('rejects registry success that does not materialize a valid dependency manifest', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { buildPlugin, logger } = deps();
    const getAgentRegistryProvider = vi.fn(() => ({
      install: vi.fn(async () => ({ message: 'ok', success: true })),
    }));

    const result = await installPluginDependency(
      { id: 'missing-dep' },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('did not materialize');
  });

  test('rejects registry success when the installed manifest name does not match the dependency id', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { buildPlugin, logger } = deps();
    const getAgentRegistryProvider = vi.fn(() => ({
      install: vi.fn(async () => {
        writePluginSource(pluginsDir, 'expected-dep', {
          name: 'other-dep',
          version: '1.0.0',
        });
        return { message: 'ok', success: true };
      }),
    }));

    const result = await installPluginDependency(
      { id: 'expected-dep' },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('manifest name does not match');
    expect(existsSync(join(pluginsDir, 'expected-dep'))).toBe(false);
  });

  test('rejects registry dependency success when an entrypoint dependency is not built', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { logger } = deps();
    const buildPlugin = vi.fn(async () => undefined);
    const getPluginRegistryProvider = vi.fn(() => ({
      install: vi.fn(async (id: string) => {
        writePluginSource(pluginsDir, id, {
          entrypoint: 'index.ts',
          name: id,
          version: '1.0.0',
        });
        return { message: 'ok', success: true };
      }),
    }));

    const result = await installPluginDependency(
      { id: 'needs-build' },
      pluginsDir,
      getPluginRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('did not produce dist/bundle.js');
    expect(buildPlugin).toHaveBeenCalledWith(
      join(pluginsDir, 'needs-build'),
      'needs-build',
    );
    expect(existsSync(join(pluginsDir, 'needs-build'))).toBe(false);
  });

  test('rejects source dependencies that require canonical lifecycle installation', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const sourceDir = writePluginSource(root, 'provider-dep-source', {
      name: 'provider-dep',
      providers: [{ module: './provider.js', type: 'model' }],
      version: '1.0.0',
    });
    const { buildPlugin, getAgentRegistryProvider, logger } = deps();

    const result = await installPluginDependency(
      { id: 'provider-dep', source: sourceDir },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('canonical install support');
    expect(buildPlugin).not.toHaveBeenCalled();
    expect(existsSync(join(pluginsDir, 'provider-dep'))).toBe(false);
  });

  test('rejects source dependencies that bundle integration definitions', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const sourceDir = writePluginSource(root, 'integration-dep-source', {
      name: 'integration-dep',
      version: '1.0.0',
    });
    mkdirSync(join(sourceDir, 'integrations', 'shell'), { recursive: true });
    writeFileSync(
      join(sourceDir, 'integrations', 'shell', 'integration.json'),
      JSON.stringify({ command: 'shell', transport: 'stdio' }),
    );
    const { buildPlugin, getAgentRegistryProvider, logger } = deps();

    const result = await installPluginDependency(
      { id: 'integration-dep', source: sourceDir },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('canonical install support');
    expect(buildPlugin).not.toHaveBeenCalled();
    expect(existsSync(join(pluginsDir, 'integration-dep'))).toBe(false);
  });

  test('rejects registry dependencies that require permissions instead of silently installing them', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { buildPlugin, logger } = deps();
    const getPluginRegistryProvider = vi.fn(() => ({
      install: vi.fn(async (id: string) => {
        writePluginSource(pluginsDir, id, {
          name: id,
          permissions: ['providers.register'],
          version: '1.0.0',
        });
        return { message: 'ok', success: true };
      }),
    }));

    const result = await installPluginDependency(
      { id: 'trusted-dep' },
      pluginsDir,
      getPluginRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('canonical install support');
    expect(buildPlugin).not.toHaveBeenCalled();
    expect(existsSync(join(pluginsDir, 'trusted-dep'))).toBe(false);
  });

  test('accepts registry entrypoint dependencies only after build output materializes', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { logger } = deps();
    const buildPlugin = vi.fn(async (pluginDir: string) => {
      mkdirSync(join(pluginDir, 'dist'), { recursive: true });
      writeFileSync(join(pluginDir, 'dist', 'bundle.js'), 'export default {};');
    });
    const getPluginRegistryProvider = vi.fn(() => ({
      install: vi.fn(async (id: string) => {
        writePluginSource(pluginsDir, id, {
          entrypoint: 'index.ts',
          name: id,
          version: '1.0.0',
        });
        return { message: 'ok', success: true };
      }),
    }));

    const result = await installPluginDependency(
      { id: 'built-dep' },
      pluginsDir,
      getPluginRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(true);
    expect(existsSync(join(pluginsDir, 'built-dep', 'dist', 'bundle.js'))).toBe(
      true,
    );
  });
});

/**
 * station#4288, review HIGH 3.
 *
 * `installPluginDependency` REBUILDS a dependency that is already installed:
 * `buildPlugin` runs `ensurePluginDeps` (an `npm install` inside
 * `<plugins>/<dependencyId>`) and writes `dist/bundle.js`. So installing
 * plugin A mutates already-installed plugin B's live tree, as a side effect
 * of installing something else. That has to happen under B's own content
 * lock, both because the memoized digest is only dropped when a lock
 * releases, and because a consent decision for B could otherwise revalidate
 * B's digest and commit a grant across the rebuild.
 */
describe('rebuilding an installed dependency (station#4288)', () => {
  function seedInstalledDependency(pluginsDir: string, id: string): string {
    const dir = join(pluginsDir, id);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        entrypoint: 'src/index.tsx',
        name: id,
        version: '1.0.0',
      }),
    );
    writeFileSync(join(dir, 'src', 'index.tsx'), 'export const v = 1;\n');
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'bundle v1\n');
    return dir;
  }

  test('the rebuild does not leave a stale memoized digest behind', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const dir = seedInstalledDependency(pluginsDir, 'shared-lib');
    // Something already read (and therefore memoized) the pre-rebuild digest.
    const before = pluginContentDigest(pluginsDir, 'shared-lib');
    expect(before).toBe(computePluginContentDigest(pluginsDir, 'shared-lib'));

    const { getAgentRegistryProvider, logger } = deps();
    const buildPlugin = vi.fn(async () => {
      writeFileSync(join(dir, 'dist', 'bundle.js'), 'bundle v2 — rebuilt\n');
    });

    const result = await installPluginDependency(
      { id: 'shared-lib' },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(true);
    expect(buildPlugin).toHaveBeenCalledWith(dir, 'shared-lib');
    // The tree moved, and so did what the memo answers with. Without the
    // lock the memo kept serving `before` until the next restart, so a
    // mutated tree read `bound` in-process and `changed` after a reboot.
    const truth = computePluginContentDigest(pluginsDir, 'shared-lib');
    expect(truth).not.toBe(before);
    expect(pluginContentDigest(pluginsDir, 'shared-lib')).toBe(truth);
  });

  test('the rebuild waits for whoever already holds that plugin’s content lock', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    seedInstalledDependency(pluginsDir, 'shared-lib');
    const order: string[] = [];
    let releaseHolder: () => void = () => {};
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = withPluginContentLock(pluginsDir, 'shared-lib', async () => {
      order.push('holder-enter');
      await holderGate;
      order.push('holder-exit');
    });

    const { getAgentRegistryProvider, logger } = deps();
    const buildPlugin = vi.fn(async () => {
      order.push('rebuild');
    });
    const rebuild = installPluginDependency(
      { id: 'shared-lib' },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(['holder-enter']);
    releaseHolder();
    await holder;
    expect(await rebuild).toEqual({ success: true });
    expect(order).toEqual(['holder-enter', 'holder-exit', 'rebuild']);
  });
});

/**
 * station#4309 follow-up, defect 1.
 *
 * `withPluginContentLock` refuses an acquisition that would deadlock by
 * throwing a typed `PluginContentLockCycleError` carrying the cycle. The
 * refusal fires from `buildDependencyIfNeeded`, inside a function that reports
 * failures as a RESULT — so the instance was destroyed at that boundary and
 * every caller above saw a sentence it could only answer 500 to.
 */
describe('a refused content lock survives the dependency result boundary', () => {
  function seedInstalledDependency(pluginsDir: string, id: string): string {
    const dir = join(pluginsDir, id);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({
        entrypoint: 'src/index.tsx',
        name: id,
        version: '1.0.0',
      }),
    );
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'bundle v1\n');
    return dir;
  }

  test('the failed result carries the PluginContentLockCycleError instance and both plugin names', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    seedInstalledDependency(pluginsDir, 'shared-lib');
    const { getAgentRegistryProvider, logger } = deps();
    const buildPlugin = vi.fn(async () => undefined);

    let appHeld!: () => void;
    const appHeldGate = new Promise<void>((resolve) => {
      appHeld = resolve;
    });

    // The sibling operation: it holds `shared-lib` and then queues for `app`,
    // which the install below is holding. That is the AB-BA the check refuses.
    const sibling = withPluginContentLock(
      pluginsDir,
      'shared-lib',
      async () => {
        await appHeldGate;
        await withPluginContentLock(pluginsDir, 'app', async () => undefined);
      },
    );

    // The install: holds `app` (as `installPluginFromSource` does) and then
    // rebuilds its already-installed dependency under that dependency's lock.
    const result = await withPluginContentLock(pluginsDir, 'app', async () => {
      appHeld();
      // Let the sibling's request for `app` register its wait-for edge, so the
      // cycle is visible to THIS side's acquire rather than the sibling's.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return await installPluginDependency(
        { id: 'shared-lib' },
        pluginsDir,
        getAgentRegistryProvider as any,
        buildPlugin,
        logger,
      );
    });
    await sibling;

    expect(result.success).toBe(false);
    expect(result.cause).toBeInstanceOf(PluginContentLockCycleError);
    expect((result.cause as PluginContentLockCycleError).plugins).toEqual([
      'app',
      'shared-lib',
    ]);
  });
});

/**
 * station#4309 follow-up, defect 2.
 *
 * The dependency rollback used to `rmSync` `<plugins>/<id>` from a catch that
 * sits OUTSIDE that plugin's content lock, and on failures that happened
 * before this operation had created anything there at all.
 */
describe('a dependency rollback only deletes a tree it created, under that plugin’s lock', () => {
  test('a failure before the tree is created leaves a concurrently installed tree alone', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const sourceDir = writePluginSource(root, 'shared-dep-source', {
      dependencies: [{ id: '../escape' }],
      name: 'shared-dep',
      version: '1.0.0',
    });
    const { getAgentRegistryProvider, logger } = deps();
    // Building the fetched copy is where a CONCURRENT operation lands the same
    // dependency: by the time this install fails on its transitive dependency,
    // `<plugins>/shared-dep` exists and belongs to whoever created it.
    const buildPlugin = vi.fn(async () => {
      const landed = join(pluginsDir, 'shared-dep');
      mkdirSync(landed, { recursive: true });
      writeFileSync(
        join(landed, 'plugin.json'),
        JSON.stringify({ name: 'shared-dep', version: '2.0.0' }),
      );
      writeFileSync(
        join(landed, 'marker.txt'),
        'installed by the other operation',
      );
    });

    const result = await installPluginDependency(
      { id: 'shared-dep', source: sourceDir },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    expect(result.success).toBe(false);
    expect(existsSync(join(pluginsDir, 'shared-dep', 'marker.txt'))).toBe(true);
    expect(
      readFileSync(join(pluginsDir, 'shared-dep', 'marker.txt'), 'utf-8'),
    ).toBe('installed by the other operation');
  });

  test('the tree is created and rolled back inside the dependency content lock', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const sourceDir = writePluginSource(root, 'entry-dep-source', {
      entrypoint: 'index.ts',
      name: 'entry-dep',
      version: '1.0.0',
    });
    const { getAgentRegistryProvider, logger } = deps();
    // Never emits dist/bundle.js, so the install fails AFTER the copy — the
    // one failure that legitimately has something of ours to roll back.
    // It is also the test's ordering hook: the source branch calls it on the
    // FETCHED copy immediately before requesting the lock, so once it has been
    // called the install is at the lock's door.
    let installAtTheDoor!: () => void;
    const installAtTheDoorGate = new Promise<void>((resolve) => {
      installAtTheDoor = resolve;
    });
    const buildPlugin = vi.fn(async () => {
      installAtTheDoor();
    });

    let releaseHolder: () => void = () => {};
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    // The absence check lives INSIDE the holder's span, so it is guaranteed by
    // the lock rather than by having waited long enough: for the whole time
    // this body runs, no other context can be inside `entry-dep`'s lock, and
    // the copy that creates the tree only happens in there.
    let observedWhileHeld: boolean | null = null;
    const holder = withPluginContentLock(pluginsDir, 'entry-dep', async () => {
      await installAtTheDoorGate;
      observedWhileHeld = existsSync(join(pluginsDir, 'entry-dep'));
      await holderGate;
    });

    const install = installPluginDependency(
      { id: 'entry-dep', source: sourceDir },
      pluginsDir,
      getAgentRegistryProvider as any,
      buildPlugin,
      logger,
    );

    await installAtTheDoorGate;
    releaseHolder();
    await holder;
    const result = await install;

    // Nothing appeared at `<plugins>/entry-dep` while another operation held
    // its lock: the copy that creates it waits for the lock instead of racing
    // beside it.
    expect(observedWhileHeld).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('did not produce dist/bundle.js');
    expect(existsSync(join(pluginsDir, 'entry-dep'))).toBe(false);
  });

  test('a tree another operation created is adopted, never handed to the registry provider', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { buildPlugin, logger } = deps();
    mkdirSync(pluginsDir, { recursive: true });

    // The concurrent operation: it holds `prior-dep`'s content lock and lands
    // the tree while this install is already queued behind it. `<plugins>/
    // prior-dep` therefore does NOT exist when this install starts — which is
    // the only way to reach the registry branch at all — but does by the time
    // the lock is granted. That is the tree the provider must never be called
    // over: `JsonManifestRegistryProvider.install` is `rmSync(targetDir)` +
    // `cpSync(staged, targetDir)` once an alias it owns names this plugin, so
    // a provider call here deletes the concurrent operation's tree from inside
    // the provider — and the caller cannot roll THAT back, because it did not
    // create it (station#4309 follow-up review, MEDIUM 1).
    let releaseHolder: () => void = () => {};
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderHasLock!: () => void;
    const holderHasLockGate = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    const holder = withPluginContentLock(pluginsDir, 'prior-dep', async () => {
      holderHasLock();
      await holderGate;
      writePluginSource(pluginsDir, 'prior-dep', {
        name: 'other-dep',
        version: '1.0.0',
      });
      writeFileSync(join(pluginsDir, 'prior-dep', 'marker.txt'), 'not ours');
    });
    await holderHasLockGate;

    // Stands in for the real provider's replace-in-place: if this call is
    // reached at all, the concurrent operation's tree is gone.
    const providerInstall = vi.fn(async () => {
      rmSync(join(pluginsDir, 'prior-dep'), { recursive: true, force: true });
      writePluginSource(pluginsDir, 'prior-dep', {
        name: 'prior-dep',
        version: '9.9.9',
      });
      return { message: 'ok', success: true };
    });
    const getPluginRegistryProvider = vi.fn(() => ({
      install: providerInstall,
    }));
    const install = installPluginDependency(
      { id: 'prior-dep' },
      pluginsDir,
      getPluginRegistryProvider as any,
      buildPlugin,
      logger,
    );

    // `installPluginDependency`'s pre-lock `existsSync` runs in its
    // SYNCHRONOUS prefix, so by the time the call above has returned a promise
    // it has already observed an empty `<plugins>/prior-dep` — the premise
    // that puts it on the registry branch, established by construction rather
    // than by waiting.
    releaseHolder();
    await holder;
    const result = await install;

    expect(providerInstall).not.toHaveBeenCalled();
    // Adopted and validated instead — and this tree fails validation, which is
    // reported without deleting anything.
    expect(result.success).toBe(false);
    expect(result.error).toContain('manifest name does not match');
    expect(existsSync(join(pluginsDir, 'prior-dep', 'marker.txt'))).toBe(true);
    expect(
      readFileSync(join(pluginsDir, 'prior-dep', 'marker.txt'), 'utf-8'),
    ).toBe('not ours');
  });

  test('the registry provider is told which installed plugin name this call is committed to', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { buildPlugin, logger } = deps();
    mkdirSync(pluginsDir, { recursive: true });

    // The provider picks its write target from the manifest IT fetched, while
    // this call has already taken `<plugins>/registry-dep`'s content lock and
    // will validate that path. The expected name is the assertion that keeps
    // the two in step; without it a provider resolving a different name
    // rewrites another plugin's tree under this plugin's lock, and neither
    // rollback branch fires (station#4309 follow-up review, MEDIUM 3).
    const providerInstall = vi.fn(
      async (
        _id: string,
        options?: { expectedInstalledPluginName?: string },
      ) => {
        if (options?.expectedInstalledPluginName !== 'registry-dep') {
          // What the real provider does NOT do when it is told: write to the
          // name it resolved rather than the one the caller is holding.
          writePluginSource(pluginsDir, 'someone-else', {
            name: 'someone-else',
            version: '1.0.0',
          });
        }
        return { message: 'ok', success: true };
      },
    );
    const result = await installPluginDependency(
      { id: 'registry-dep' },
      pluginsDir,
      (() => ({ install: providerInstall })) as any,
      buildPlugin,
      logger,
    );

    expect(providerInstall).toHaveBeenCalledWith('registry-dep', {
      expectedInstalledPluginName: 'registry-dep',
    });
    expect(existsSync(join(pluginsDir, 'someone-else'))).toBe(false);
    // Nothing landed at the committed path, so the call reports that rather
    // than deleting whatever the provider did write.
    expect(result.success).toBe(false);
    expect(result.error).toContain('did not materialize after install');
  });
});

/**
 * station#4309 follow-up review, HIGH 1.
 *
 * A caller that has to undo a partial install needs the IDENTITY of the trees
 * this install created. The frames that create them are the only ones that
 * know, so they report it out.
 */
describe('installPluginDependency reports the trees it created', () => {
  test('a created tree is reported, and one another operation already had is not', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { buildPlugin, logger } = deps();
    const sourceDir = writePluginSource(root, 'fresh-dep-source', {
      name: 'fresh-dep',
      version: '1.0.0',
    });

    const created = new Set<string>();
    const fresh = await installPluginDependency(
      { id: 'fresh-dep', source: sourceDir },
      pluginsDir,
      (() => ({ install: vi.fn() })) as any,
      buildPlugin,
      logger,
      undefined,
      created,
    );
    expect(fresh.success).toBe(true);
    expect([...created]).toEqual(['fresh-dep']);

    // A second install of the same dependency finds it already there. It did
    // not create it, so it must not report it — that report is what authorises
    // a delete.
    const adopting = new Set<string>();
    const again = await installPluginDependency(
      { id: 'fresh-dep', source: sourceDir },
      pluginsDir,
      (() => ({ install: vi.fn() })) as any,
      buildPlugin,
      logger,
      undefined,
      adopting,
    );
    expect(again.success).toBe(true);
    expect([...adopting]).toEqual([]);
  });

  test('a transitive dependency installed before the failure is reported to the caller', async () => {
    const root = createRoot();
    const pluginsDir = join(root, 'plugins');
    const { buildPlugin, logger } = deps();
    writePluginSource(root, 'leaf-source', {
      name: 'leaf-dep',
      version: '1.0.0',
    });
    const parentSource = writePluginSource(root, 'parent-source', {
      dependencies: [
        { id: 'leaf-dep', source: join(root, 'leaf-source') },
        { id: 'missing-dep' },
      ],
      name: 'parent-dep',
      version: '1.0.0',
    });

    const created = new Set<string>();
    const result = await installPluginDependency(
      { id: 'parent-dep', source: parentSource },
      pluginsDir,
      (() => ({
        install: vi.fn(async () => ({
          message: 'no such plugin',
          success: false,
        })),
      })) as any,
      buildPlugin,
      logger,
      undefined,
      created,
    );

    expect(result.success).toBe(false);
    // `parent-dep`'s own tree was never created (its transitive loop runs
    // first), but `leaf-dep`'s was, and it is still on disk — so the caller
    // is the one that has to decide about it, and it can only decide if it is
    // told.
    expect([...created]).toEqual(['leaf-dep']);
    expect(existsSync(join(pluginsDir, 'leaf-dep', 'plugin.json'))).toBe(true);
    expect(existsSync(join(pluginsDir, 'parent-dep'))).toBe(false);
  });
});
