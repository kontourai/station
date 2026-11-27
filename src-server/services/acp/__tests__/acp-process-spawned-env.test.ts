/**
 * `ACPProcess.spawnedEnvHas` reports what the engine child actually received
 * after every layer, managed pins last. The ACP adapter decides on it whether
 * an engine route that needs a credential is open (acp-reattach-identity.ts),
 * so a locked pin that empties a variable must read as "not set".
 *
 * The engine is Node running a script that exits at once: the spawn happens,
 * `initialize` is never answered, and no shebang is needed on any platform.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { installManagedEngineLimits } from '../../../security/managed-engine-limits.js';
import { ACPProcess } from '../acp-process.js';

const makeTempDir = trackTempDirs();

afterEach(() => {
  installManagedEngineLimits(null);
  vi.unstubAllEnvs();
});

function installAcpPin(
  environment: Record<string, string>,
  launchArgs?: string[],
) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: {
      engines: {
        instances: {
          acp: {
            locked: true,
            environment,
            ...(launchArgs ? { launchArgs } : {}),
          },
        },
      },
    },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

/** Spawns the exiting script with the connection's stored credential. */
async function spawnWithStoredKey(): Promise<ACPProcess> {
  const dir = makeTempDir('station-acp-spawned-env-');
  const script = join(dir, 'engine.js');
  writeFileSync(script, 'process.exit(0);\n');
  const acp = new ACPProcess({
    command: process.execPath,
    args: [script],
    cwd: dir,
    createClient: () => ({}) as never,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    credentialEnv: () => ({ GEMINI_API_KEY: 'stored-gemini-key' }),
  });
  // The script exits instead of answering `initialize`.
  await expect(acp.start()).rejects.toThrow();
  await acp.destroy();
  return acp;
}

describe('ACPProcess.spawnedEnvHas', () => {
  test('a stored credential the engine received reads as set', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    const acp = await spawnWithStoredKey();
    expect(acp.spawnedEnvHas('GEMINI_API_KEY')).toBe(true);
  });

  test('a locked managed pin that empties the variable reads as not set', async () => {
    installAcpPin({ GEMINI_API_KEY: '' });
    const acp = await spawnWithStoredKey();
    expect(acp.spawnedEnvHas('GEMINI_API_KEY')).toBe(false);
  });

  test('nothing reads as set before the engine is spawned', () => {
    const acp = new ACPProcess({
      command: process.execPath,
      args: [],
      cwd: makeTempDir('station-acp-spawned-env-'),
      createClient: () => ({}) as never,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      credentialEnv: () => ({ GEMINI_API_KEY: 'stored-gemini-key' }),
    });
    expect(acp.spawnedEnvHas('GEMINI_API_KEY')).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'a locked argument pin keeps the opted-in profile from adding arguments',
    async () => {
      const home = makeTempDir('station-acp-pinned-profile-');
      const profile = join(home, 'engine-profiles', 'antigravity');
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      vi.stubEnv('STATION_HOME', home);
      vi.stubEnv('GEMINI_HOME', profile);
      const args = ['acp', '--process-per-session'];
      installAcpPin({}, args);
      const createClient = vi.fn(() => ({}) as never);
      const acp = new ACPProcess({
        command: 'agy',
        args,
        cwd: home,
        createClient,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        resolveCommand: async () => process.execPath,
      });
      try {
        await expect(acp.start()).rejects.toThrow(
          'Managed engine policy prevents launching the dedicated Antigravity profile.',
        );
        expect(createClient).not.toHaveBeenCalled();
      } finally {
        await acp.destroy();
      }
    },
  );
});
