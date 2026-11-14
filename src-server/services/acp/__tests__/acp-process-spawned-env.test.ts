/**
 * `ACPProcess.spawnedEnvHas` reports what the engine child actually received
 * after every layer, managed pins last. The ACP adapter decides on it whether
 * an engine route that needs a credential is open (acp-reattach-identity.ts),
 * so a locked pin that empties a variable must read as "not set".
 *
 * The engine is Node running a script that exits at once: the spawn happens,
 * `initialize` is never answered, and no shebang is needed on any platform.
 */
import { writeFileSync } from 'node:fs';
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

function installAcpPin(environment: Record<string, string>) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { engines: { instances: { acp: { locked: true, environment } } } },
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
});
