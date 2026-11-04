/**
 * #4517: the CLI commands that write `config/app.json` without a server
 * apply the managed policy's locks themselves. Each runs as a real CLI child
 * process through the supported source bootstrap, with the policy injected
 * the way the server reads it (`STATION_MANAGED_POLICY_TEST_FILE`), and the
 * stored file is read back from disk.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_CONFIG_SEED } from '@kontourai/station-contracts/config';
import { STATION_HOME_SCHEMA_VERSION } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, test } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const makeTempDir = trackTempDirs();

const DENIAL =
  "Acme's policy manages this setting. For help, visit https://help.example/station";

function fixture(
  settings: Record<string, { value: unknown; locked: boolean }>,
) {
  const root = makeTempDir('station-managed-offline-');
  const home = join(root, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, '.station-home-schema.json'),
    JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
  );
  const appPath = join(home, 'config', 'app.json');
  writeFileSync(appPath, JSON.stringify({ defaultMaxTurns: 7 }, null, 2));
  const policyPath = join(root, 'policy.json');
  writeFileSync(
    policyPath,
    JSON.stringify({
      schemaVersion: 1,
      organization: 'Acme',
      supportUrl: 'https://help.example/station',
      settings,
    }),
  );
  const run = (...args: string[]) => {
    const result = spawnSyncBounded(
      process.execPath,
      ['--import', 'tsx', join(repoRoot, 'scripts/station-cli.ts'), ...args],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          STATION_HOME: home,
          STATION_ROOT: join(root, 'station-root'),
          STATION_MANAGED_POLICY_TEST_FILE: policyPath,
          // Offline: nothing may answer here.
          STATION_PORT: '9',
        },
      },
    );
    return {
      status: result.status,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  };
  return {
    run,
    root,
    home,
    writeApp: (value: Record<string, unknown>) =>
      writeFileSync(appPath, JSON.stringify(value, null, 2)),
    stored: () => JSON.parse(readFileSync(appPath, 'utf8')),
  };
}

/** A local catalog `station registry` can read without a network. */
function catalog(root: string, name: string, pluginId: string): string {
  const path = join(root, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      plugins: [{ id: pluginId, source: `./${pluginId}`, version: '1.0.0' }],
    }),
  );
  return path;
}

describe('offline CLI writes under a managed policy', () => {
  test('config set --offline refuses a locked setting and leaves the file as it was', () => {
    const f = fixture({ defaultMaxTurns: { value: 40, locked: true } });
    const refused = f.run('config', 'set', 'defaultMaxTurns', '9', '--offline');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(DENIAL);
    expect(f.stored().defaultMaxTurns).toBe(7);

    // The locked value itself writes nothing: no policy value in user files.
    const same = f.run('config', 'set', 'defaultMaxTurns', '40', '--offline');
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toContain('already that value (managed by policy)');
    expect(f.stored().defaultMaxTurns).toBe(7);

    // An unmanaged setting still saves.
    const other = f.run(
      'config',
      'set',
      'checkoutStaleAfterDays',
      '4',
      '--offline',
    );
    expect(other.status, other.stderr).toBe(0);
    expect(f.stored()).toMatchObject({
      defaultMaxTurns: 7,
      checkoutStaleAfterDays: 4,
    });
  }, 180_000);

  test('station registry <url> refuses a locked registryUrl', () => {
    const f = fixture({
      registryUrl: {
        value: 'https://registry.example/index.json',
        locked: true,
      },
    });
    const refused = f.run('registry', 'https://elsewhere.example/index.json');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(DENIAL);
    expect(f.stored()).not.toHaveProperty('registryUrl');
  }, 120_000);
});

describe('offline CLI reads under a managed policy', () => {
  test('station registry lists the locked registry, not the stored or legacy one', () => {
    const f = fixture({});
    const locked = catalog(f.root, 'locked', 'acme.locked-plugin');
    const storedCatalog = catalog(f.root, 'stored', 'user.stored-plugin');
    const legacy = catalog(f.root, 'legacy', 'user.legacy-plugin');
    writeFileSync(
      join(f.root, 'policy.json'),
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        settings: { registryUrl: { value: locked, locked: true } },
      }),
    );
    f.writeApp({ registryUrl: storedCatalog });
    const listed = f.run('registry');
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain(`Fetching registry from ${locked}`);
    expect(listed.stdout).toContain('acme.locked-plugin');
    expect(listed.stdout).not.toContain('user.stored-plugin');

    // With nothing stored, the legacy file is not migrated past the lock.
    f.writeApp({});
    writeFileSync(
      join(f.home, 'config.json'),
      JSON.stringify({ registryUrl: legacy }),
    );
    const again = f.run('registry');
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('acme.locked-plugin');
    expect(f.stored()).not.toHaveProperty('registryUrl');
  }, 180_000);

  test('a managed registry default applies only where the user set none', () => {
    const f = fixture({});
    const managedDefault = catalog(f.root, 'default', 'acme.default-plugin');
    const own = catalog(f.root, 'own', 'user.own-plugin');
    writeFileSync(
      join(f.root, 'policy.json'),
      JSON.stringify({
        schemaVersion: 1,
        organization: 'Acme',
        settings: { registryUrl: { value: managedDefault, locked: false } },
      }),
    );
    f.writeApp({});
    expect(f.run('registry').stdout).toContain('acme.default-plugin');
    f.writeApp({ registryUrl: own });
    const mine = f.run('registry');
    expect(mine.stdout).toContain('user.own-plugin');
    expect(mine.stdout).not.toContain('acme.default-plugin');
  }, 180_000);

  test('an installed policy startup would refuse refuses the catalog read', () => {
    const f = fixture({
      approvalGuardian: { value: { enabled: 'false' }, locked: true },
    });
    f.writeApp({ registryUrl: catalog(f.root, 'own', 'user.own-plugin') });
    const refused = f.run('registry');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('STATION_MANAGED_POLICY_INVALID');
    expect(refused.stdout).not.toContain('user.own-plugin');
  }, 120_000);

  test('config get --offline prints the locked value, not the stored one', () => {
    const f = fixture({ defaultMaxTurns: { value: 40, locked: true } });
    const read = f.run('config', 'get', 'defaultMaxTurns', '--offline');
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout).toContain('40');
    expect(read.stdout).not.toMatch(/\b7\b/);
    expect(f.stored().defaultMaxTurns).toBe(7);
  }, 120_000);

  // #4517 round 2: the offline reader decides "is there a Station decision"
  // with the server's predicate, so an explicit null and a loader-written
  // seed resolve the way the server resolves them.
  test('config get --offline keeps an explicit null over a managed default', () => {
    const f = fixture({
      builtinAgentEngineConnectionId: { value: 'codex', locked: false },
    });
    f.writeApp({ builtinAgentEngineConnectionId: null });
    const read = f.run(
      'config',
      'get',
      'builtinAgentEngineConnectionId',
      '--offline',
    );
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout.trim()).toBe('null');
    // With the key absent, the managed default applies.
    f.writeApp({});
    const unset = f.run(
      'config',
      'get',
      'builtinAgentEngineConnectionId',
      '--offline',
    );
    expect(unset.status, unset.stderr).toBe(0);
    expect(unset.stdout.trim()).toBe('codex');
    expect(f.stored()).toEqual({});
  }, 180_000);

  test('config get --offline applies a managed prompt over the factory seed', () => {
    const managedPrompt = 'You are the Acme assistant.';
    const f = fixture({
      systemPrompt: { value: managedPrompt, locked: false },
    });
    f.writeApp({ systemPrompt: APP_CONFIG_SEED.systemPrompt });
    const read = f.run('config', 'get', 'systemPrompt', '--offline');
    expect(read.status, read.stderr).toBe(0);
    expect(read.stdout.trim()).toBe(managedPrompt);
    // A prompt the user wrote is a decision and wins over the default.
    f.writeApp({ systemPrompt: 'My own prompt.' });
    const own = f.run('config', 'get', 'systemPrompt', '--offline');
    expect(own.status, own.stderr).toBe(0);
    expect(own.stdout.trim()).toBe('My own prompt.');
  }, 180_000);
});
