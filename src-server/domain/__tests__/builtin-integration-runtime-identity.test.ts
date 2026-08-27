/**
 * station#3063 — cross-process reload ping-pong.
 *
 * Two servers sharing one `~/.station` home (desktop app + launchd service)
 * used to rewrite `integrations/station-control/integration.json` (and
 * station-docs) on every `reloadAgents()`, each baking in its OWN dist path
 * and port. `integrations/` is a watched config root, so each write fired
 * the other process's watcher → reload → rewrite, ~1/s forever, and the
 * #1588 byte-identical save skip could never converge because the two
 * writers' bytes legitimately disagreed.
 *
 * These tests pin the structural fix at the ConfigLoader seam, against real
 * files in a real temp home:
 *   1. the persisted built-in files are instance-INDEPENDENT (two loaders
 *      registered with different instance identities produce byte-identical
 *      files, and re-materialization performs zero writes);
 *   2. the running instance's spawn identity is overlaid at LOAD time, so
 *      every spawn/delivery gate still sees command/args/env for THIS
 *      instance;
 *   3. no write path can leak the overlay identity back into the file
 *      (load-modify-save round trips stay instance-independent);
 *   4. a home carrying the pre-#3063 identity-baked schema converges to the
 *      stable bytes in ONE write and then goes quiet.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createRuntimeSelfIntegration,
  materializeBuiltinIntegrations,
} from '../../runtime/agents/runtime-default-agent.js';
import {
  builtinStationControlServerPath,
  isBuiltinStationControl,
  isBuiltinStationDocs,
  stationControlRuntimeIdentity,
  stationDocsRuntimeIdentity,
} from '../../runtime/bootstrap/station-control-runtime-env.js';
import { ConfigLoader } from '../config-loader.js';

const CONTROL_PATH = ['integrations', 'station-control', 'integration.json'];
const DOCS_PATH = ['integrations', 'station-docs', 'integration.json'];

/** A file's write identity: the atomic-rename publish always changes inode. */
function writeStamp(path: string): { ino: number; mtimeMs: number } {
  const stat = statSync(path);
  return { ino: stat.ino, mtimeMs: stat.mtimeMs };
}

function newLoaderWithIdentity(homeDir: string, port: number): ConfigLoader {
  const loader = new ConfigLoader({ projectHomeDir: homeDir });
  loader.registerBuiltinIntegrationRuntimeIdentity('station-control', () =>
    stationControlRuntimeIdentity(port),
  );
  loader.registerBuiltinIntegrationRuntimeIdentity('station-docs', () =>
    stationDocsRuntimeIdentity(),
  );
  return loader;
}

describe('builtin integration runtime identity (station#3063)', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'station-3063-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('two materializations under DIFFERENT instance identities produce byte-identical files and the second performs zero writes', async () => {
    // Instance A: the launchd service on port 3141.
    const loaderA = newLoaderWithIdentity(homeDir, 3141);
    await materializeBuiltinIntegrations(loaderA);
    const controlPath = join(homeDir, ...CONTROL_PATH);
    const docsPath = join(homeDir, ...DOCS_PATH);
    const controlBytesA = await readFile(controlPath, 'utf8');
    const docsBytesA = await readFile(docsPath, 'utf8');
    const controlStampA = writeStamp(controlPath);
    const docsStampA = writeStamp(docsPath);

    // Instance B: the desktop app's embedded server on port 38141 — the
    // exact co-homed arrangement that used to ping-pong.
    const loaderB = newLoaderWithIdentity(homeDir, 38141);
    await materializeBuiltinIntegrations(loaderB);

    // Byte-identical AND untouched: B's save was skipped entirely (no new
    // inode, no new mtime), so B's boot emitted no watcher event for A.
    expect(await readFile(controlPath, 'utf8')).toBe(controlBytesA);
    expect(await readFile(docsPath, 'utf8')).toBe(docsBytesA);
    expect(writeStamp(controlPath)).toEqual(controlStampA);
    expect(writeStamp(docsPath)).toEqual(docsStampA);

    // And the persisted bytes contain neither instance's identity.
    for (const bytes of [controlBytesA, docsBytesA]) {
      const parsed = JSON.parse(bytes);
      expect(parsed).not.toHaveProperty('command');
      expect(parsed).not.toHaveProperty('args');
      expect(parsed).not.toHaveProperty('env');
    }
  });

  test('the reload path (onlyIfMissing) performs ZERO writes against a materialized home', async () => {
    const loader = newLoaderWithIdentity(homeDir, 3141);
    await materializeBuiltinIntegrations(loader);
    const controlPath = join(homeDir, ...CONTROL_PATH);
    const docsPath = join(homeDir, ...DOCS_PATH);
    const controlStamp = writeStamp(controlPath);
    const docsStamp = writeStamp(docsPath);
    const controlBytes = await readFile(controlPath, 'utf8');
    const docsBytes = await readFile(docsPath, 'utf8');

    // What every reloadAgents() now runs (bootstrapRuntimeDefaultAgent).
    await materializeBuiltinIntegrations(loader, { onlyIfMissing: true });
    // A second co-homed instance's reload against the same files.
    await materializeBuiltinIntegrations(
      newLoaderWithIdentity(homeDir, 38141),
      {
        onlyIfMissing: true,
      },
    );

    expect(writeStamp(controlPath)).toEqual(controlStamp);
    expect(writeStamp(docsPath)).toEqual(docsStamp);
    expect(await readFile(controlPath, 'utf8')).toBe(controlBytes);
    expect(await readFile(docsPath, 'utf8')).toBe(docsBytes);
  });

  test("loadIntegration overlays THIS instance's spawn identity — command/args/env resolve per running process, not from the file", async () => {
    await materializeBuiltinIntegrations(newLoaderWithIdentity(homeDir, 3141));

    const loaderA = newLoaderWithIdentity(homeDir, 3141);
    const loaderB = newLoaderWithIdentity(homeDir, 38141);

    const controlA = await loaderA.loadIntegration('station-control');
    const controlB = await loaderB.loadIntegration('station-control');

    // Same file, two instances, each sees ITS OWN identity.
    expect(controlA.env).toEqual({
      STATION_API_BASE: 'http://127.0.0.1:3141',
      STATION_PORT: '3141',
    });
    expect(controlB.env).toEqual({
      STATION_API_BASE: 'http://127.0.0.1:38141',
      STATION_PORT: '38141',
    });
    // Both satisfy the spoof-resistant built-in identity gate that decides
    // token injection and engine delivery — pre-#3063, whichever instance
    // wrote LAST broke this check for the other instance.
    expect(isBuiltinStationControl('station-control', controlA)).toBe(true);
    expect(isBuiltinStationControl('station-control', controlB)).toBe(true);
    expect(controlA.args?.[0]).toBe(builtinStationControlServerPath());

    const docs = await loaderA.loadIntegration('station-docs');
    expect(isBuiltinStationDocs('station-docs', docs)).toBe(true);
    // station#1547: the loaded docs shape stays env-free.
    expect(docs.env).toBeUndefined();
  });

  test('a load-modify-save round trip (e.g. disabling the integration) cannot leak the overlay identity into the file', async () => {
    const loader = newLoaderWithIdentity(homeDir, 3141);
    await materializeBuiltinIntegrations(loader);

    // MCPService.setEnabled's exact shape: load (overlay-bearing), flip a
    // field, save the whole def back.
    const loaded = await loader.loadIntegration('station-control');
    expect(loaded.command).toBe('node'); // the overlay is present in memory
    await loader.saveIntegration('station-control', {
      ...loaded,
      enabled: false,
    });

    const persisted = JSON.parse(
      await readFile(join(homeDir, ...CONTROL_PATH), 'utf8'),
    );
    expect(persisted.enabled).toBe(false); // the edit landed
    expect(persisted).not.toHaveProperty('command');
    expect(persisted).not.toHaveProperty('args');
    expect(persisted).not.toHaveProperty('env');

    // And the loaded view still carries the running identity plus the edit.
    const reloaded = await loader.loadIntegration('station-control');
    expect(reloaded.enabled).toBe(false);
    expect(isBuiltinStationControl('station-control', reloaded)).toBe(true);
  });

  test('BACK-COMPAT: a home with the OLD identity-baked schema converges to the stable bytes in one write, then goes quiet', async () => {
    // The pre-#3063 on-disk shape, as written by a DIFFERENT instance (an
    // app-bundle dist path and its port) — the oscillating state observed
    // live on the dogfood machine.
    const controlDir = join(homeDir, 'integrations', 'station-control');
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(
      join(controlDir, 'integration.json'),
      JSON.stringify(
        {
          id: 'station-control',
          displayName: 'Station Control',
          description:
            'Manage agents, skills, integrations, and jobs via natural language',
          kind: 'mcp',
          transport: 'stdio',
          command: 'node',
          args: [
            '/Applications/Station Nightly.app/Contents/Resources/dist-server/station-control.js',
          ],
          env: {
            STATION_API_BASE: 'http://127.0.0.1:38141',
            STATION_PORT: '38141',
          },
        },
        null,
        2,
      ),
    );

    const loader = newLoaderWithIdentity(homeDir, 3141);
    await materializeBuiltinIntegrations(loader);

    const controlPath = join(homeDir, ...CONTROL_PATH);
    const converged = JSON.parse(await readFile(controlPath, 'utf8'));
    expect(converged).not.toHaveProperty('command');
    expect(converged).not.toHaveProperty('args');
    expect(converged).not.toHaveProperty('env');

    // Quiet from here on: boots of BOTH instances stop writing.
    const stamp = writeStamp(controlPath);
    await materializeBuiltinIntegrations(loader);
    await materializeBuiltinIntegrations(newLoaderWithIdentity(homeDir, 38141));
    expect(writeStamp(controlPath)).toEqual(stamp);
  });

  test('listIntegrations projects the built-ins from the runtime overlay — station-control still lists as env-requiring', async () => {
    const loader = newLoaderWithIdentity(homeDir, 3141);
    await materializeBuiltinIntegrations(loader);

    const listed = await loader.listIntegrations();
    const control = listed.find((entry) => entry.id === 'station-control');
    const docs = listed.find((entry) => entry.id === 'station-docs');

    // The file no longer carries env, but the LOADED shape does — the
    // listing must not start advertising the control server as secret-free
    // (the ACP tool-server picker keys on this flag).
    expect(control?.requiresEnvSecrets).toBe(true);
    expect(control?.source).toBe('node');
    expect(docs?.requiresEnvSecrets).toBe(false);
  });

  test('LOW-1: a storedEnvNames marker on a built-in id never persists — the projected bytes match the file, so the save is a zero-write skip', async () => {
    const loader = newLoaderWithIdentity(homeDir, 3141);
    await materializeBuiltinIntegrations(loader);
    const controlPath = join(homeDir, ...CONTROL_PATH);
    const bytesBefore = await readFile(controlPath, 'utf8');
    const stampBefore = writeStamp(controlPath);

    // A client echoing state back with a stale credential marker attached.
    await loader.saveIntegration('station-control', {
      ...createRuntimeSelfIntegration().selfIntegration,
      storedEnvNames: ['API_KEY'],
    } as ToolDef);

    // Stripped BEFORE the byte comparison: the projected def equals the
    // materialized file, so nothing was written at all — no marker on disk,
    // no once-per-boot rewrite, no sibling watcher echo.
    expect(await readFile(controlPath, 'utf8')).toBe(bytesBefore);
    expect(writeStamp(controlPath)).toEqual(stampBefore);
    expect(JSON.parse(bytesBefore)).not.toHaveProperty('storedEnvNames');

    // And re-materialization stays quiet afterwards.
    await materializeBuiltinIntegrations(loader);
    expect(writeStamp(controlPath)).toEqual(stampBefore);
  });

  test('LOW-1: credential writes to a built-in id fail closed with a clear error (the overlay makes them silently dead otherwise)', async () => {
    const loader = newLoaderWithIdentity(homeDir, 3141);
    await materializeBuiltinIntegrations(loader);

    // The tools route converts inbound env edits into `secretEnv` — this is
    // the exact shape a UI credential write arrives in.
    await expect(
      loader.saveIntegration('station-control', {
        ...createRuntimeSelfIntegration().selfIntegration,
        secretEnv: { API_KEY: 'shh' },
      } as ToolDef),
    ).rejects.toThrow(/cannot store credentials/);

    await expect(
      loader.updateIntegration('station-control', (current) => ({
        ...current,
        removeSecretEnvKeys: ['API_KEY'],
      })),
    ).rejects.toThrow(/cannot store credentials/);

    // The refusal changed nothing on disk.
    const persisted = JSON.parse(
      await readFile(join(homeDir, ...CONTROL_PATH), 'utf8'),
    );
    expect(persisted).not.toHaveProperty('storedEnvNames');

    // Non-regression: a third-party id still takes the credential-store
    // path — material lands in the store, the marker persists, and the
    // secret value itself never reaches the file.
    await loader.saveIntegration('github', {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'npx',
      secretEnv: { GITHUB_TOKEN: 'secret-value' },
    } as ToolDef);
    const github = JSON.parse(
      await readFile(
        join(homeDir, 'integrations', 'github', 'integration.json'),
        'utf8',
      ),
    );
    expect(github.storedEnvNames).toEqual(['GITHUB_TOKEN']);
    expect(JSON.stringify(github)).not.toContain('secret-value');
  });

  test('non-registered integrations are untouched: a third-party server keeps its authored command/args/env', async () => {
    const loader = newLoaderWithIdentity(homeDir, 3141);
    const thirdParty: ToolDef = {
      id: 'docs-server',
      kind: 'mcp',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp-server'],
      env: { SOME_FLAG: '1' },
    };
    await loader.saveIntegration('docs-server', thirdParty);

    const persisted = JSON.parse(
      await readFile(
        join(homeDir, 'integrations', 'docs-server', 'integration.json'),
        'utf8',
      ),
    );
    expect(persisted.command).toBe('npx');
    expect(persisted.args).toEqual(['-y', 'some-mcp-server']);
    expect(persisted.env).toEqual({ SOME_FLAG: '1' });

    const loaded = await loader.loadIntegration('docs-server');
    expect(loaded.command).toBe('npx');
    expect(loaded.env).toEqual({ SOME_FLAG: '1' });
  });
});
