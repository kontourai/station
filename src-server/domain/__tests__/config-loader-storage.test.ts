// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { toolServerIntegrationMutationLockPath } from '../../services/plugins/tool-server-credential-store.js';

import {
  deleteIntegrationConfig,
  deleteSkillConfig,
  listIntegrationMetadata,
  loadACPConfigFile,
  loadIntegrationConfig,
  loadSkillConfig,
  saveACPConfigFile,
  saveIntegrationConfig,
  saveSkillConfig,
  skillConfigExists,
  wasIntegrationEnabledExplicit,
} from '../config-loader-storage.js';

describe('skill config storage resolves names through the shared seam', () => {
  test('every name-to-path entry point refuses an unsafe name', async () => {
    const root = createTempDir();
    try {
      for (const name of ['../escaped', 'a/b', '__proto__', '..']) {
        await expect(
          saveSkillConfig(root, name, {
            name,
            source: 'local',
            installedAt: '',
            path: 'x',
          }),
          name,
        ).rejects.toThrow(/Invalid skill name/);
        await expect(loadSkillConfig(root, name), name).rejects.toThrow(
          /Invalid skill name/,
        );
        await expect(deleteSkillConfig(root, name), name).rejects.toThrow(
          /Invalid skill name/,
        );
        expect(() => skillConfigExists(root, name), name).toThrow(
          /Invalid skill name/,
        );
      }
      // Nothing was written anywhere under the home.
      expect(existsSync(join(root, 'skills'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an ordinary name still round-trips', async () => {
    const root = createTempDir();
    try {
      await saveSkillConfig(root, 'alpha', {
        name: 'alpha',
        source: 'local',
        installedAt: '2026-01-01',
        path: join(root, 'skills', 'alpha'),
      });
      expect(skillConfigExists(root, 'alpha')).toBe(true);
      expect((await loadSkillConfig(root, 'alpha')).name).toBe('alpha');
      await deleteSkillConfig(root, 'alpha');
      expect(skillConfigExists(root, 'alpha')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ACP configuration identity boundary', () => {
  test('rejects malformed identities on write and on durable read', async () => {
    const root = createTempDir();
    try {
      await expect(
        saveACPConfigFile(root, {
          connections: [
            {
              id: 'bad_id',
              name: 'Bad',
              command: 'bad',
              enabled: true,
            },
          ],
        }),
      ).rejects.toThrow('Invalid clean identity');
      expect(existsSync(join(root, 'config', 'acp.json'))).toBe(false);

      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(
        join(root, 'config', 'acp.json'),
        JSON.stringify({
          connections: [
            {
              id: 'bad_id',
              name: 'Bad',
              command: 'bad',
              enabled: true,
            },
          ],
        }),
      );
      await expect(loadACPConfigFile(root)).rejects.toThrow(
        'Invalid clean identity',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const createTempDir = () =>
  mkdtempSync(join(tmpdir(), 'station-config-loader-storage-'));

const noopLogger = { error: () => {} };

describe('config-loader-storage integration icon (issue #691)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('listIntegrationMetadata passes through a manifest-declared icon', async () => {
    const integrationDir = join(tempDir, 'integrations', 'docs');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({
        id: 'docs',
        kind: 'mcp',
        displayName: 'Docs Server',
        icon: '📋',
      }),
    );

    const tools = await listIntegrationMetadata(tempDir, noopLogger);
    expect(tools).toEqual([
      {
        id: 'docs',
        kind: 'mcp',
        displayName: 'Docs Server',
        description: undefined,
        icon: '📋',
        transport: undefined,
        source: undefined,
        requiresEnvSecrets: false,
        enabled: true,
        disabledTools: undefined,
        probe: undefined,
      },
    ]);
  });

  test('listIntegrationMetadata scrubs and bounds persisted OAuth diagnostics', async () => {
    const integrationDir = join(tempDir, 'integrations', 'oauth-server');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({
        id: 'oauth-server',
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://resource.example/mcp',
        probe: {
          ok: false,
          toolCount: 0,
          checkedAt: '2026-08-15T00:00:00.000Z',
          error: `access_token=projected-secret ${'x'.repeat(700)}`,
          authorization: {
            state: 'authorization-failed',
            reason: 'Bearer projected-bearer',
          },
        },
      }),
    );

    const [metadata] = await listIntegrationMetadata(tempDir, noopLogger);

    expect(JSON.stringify(metadata)).not.toContain('projected-secret');
    expect(JSON.stringify(metadata)).not.toContain('projected-bearer');
    expect(metadata?.probe?.error?.length).toBeLessThanOrEqual(512);
    // Round-4 contract: legacy persisted diagnostics are REPLACED by a
    // Station-owned reason, not scrubbed. The old sanitizer emitted
    // 'Bearer [REDACTED]' — still echoing remote structure, and defeated by a
    // split secret it could not match. An unrecognized legacy value now
    // yields a fixed reason carrying no remote text at all.
    const authorization = metadata?.probe?.authorization;
    expect(authorization?.state).toBe('authorization-failed');
    // Narrowed access: `reason` exists only on the failure variants.
    const legacyReason =
      authorization && 'reason' in authorization ? authorization.reason : '';
    expect(legacyReason).not.toContain('Bearer');
    expect(legacyReason).not.toContain('projected');
    expect(legacyReason).toMatch(/^[a-z_]+: /);
  });

  test('treats exact legacy bytes as enabled without rewriting them', async () => {
    const dir = join(tempDir, 'integrations', 'legacy');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'integration.json');
    const bytes =
      '{\n  "id": "legacy",\n  "kind": "mcp",\n  "command": "legacy-mcp"\n}';
    writeFileSync(path, bytes);
    const loaded = await loadIntegrationConfig(tempDir, 'legacy');
    expect(loaded.enabled).toBe(true);
    expect(wasIntegrationEnabledExplicit(loaded)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  test('tracks an explicitly persisted enabled field separately from its read projection', async () => {
    await saveIntegrationConfig(tempDir, 'explicit', {
      id: 'explicit',
      kind: 'mcp',
      enabled: false,
    });
    expect(
      wasIntegrationEnabledExplicit(
        await loadIntegrationConfig(tempDir, 'explicit'),
      ),
    ).toBe(true);
  });

  test('listIntegrationMetadata omits icon when the manifest does not declare one', async () => {
    await saveIntegrationConfig(tempDir, 'docs', {
      id: 'docs',
      kind: 'mcp',
      displayName: 'Docs Server',
    });

    const tools = await listIntegrationMetadata(tempDir, noopLogger);
    expect(tools[0].icon).toBeUndefined();

    const reloaded = await loadIntegrationConfig(tempDir, 'docs');
    expect(reloaded.icon).toBeUndefined();
  });

  test('only projects a same-origin icon URL after local raster validation', async () => {
    const integrationDir = join(tempDir, 'integrations', 'docs');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({ id: 'docs', kind: 'mcp', icon: 'icon.png' }),
    );
    writeFileSync(
      join(integrationDir, 'icon.png'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    );

    await expect(listIntegrationMetadata(tempDir, noopLogger)).resolves.toEqual(
      [
        expect.objectContaining({
          id: 'docs',
          icon: 'icon.png',
          iconUrl: '/integrations/docs/icon',
        }),
      ],
    );
  });

  test('listIntegrationMetadata drops a non-string icon from a malformed disk manifest instead of crashing (review-flagged, issue #691)', async () => {
    const integrationDir = join(tempDir, 'integrations', 'docs');
    mkdirSync(integrationDir, { recursive: true });
    writeFileSync(
      join(integrationDir, 'integration.json'),
      JSON.stringify({
        id: 'docs',
        kind: 'mcp',
        displayName: 'Docs Server',
        icon: 123,
      }),
    );

    const tools = await listIntegrationMetadata(tempDir, noopLogger);
    expect(tools).toHaveLength(1);
    expect(tools[0].icon).toBeUndefined();
  });

  test('listIntegrationMetadata flags requiresEnvSecrets when the manifest declares env entries, never surfacing the values', async () => {
    await saveIntegrationConfig(tempDir, 'github', {
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'github-mcp',
      env: { GITHUB_TOKEN: 'super-secret-value' },
    });

    const tools = await listIntegrationMetadata(tempDir, noopLogger);
    expect(tools).toHaveLength(1);
    expect(tools[0].requiresEnvSecrets).toBe(true);
    expect(JSON.stringify(tools[0])).not.toContain('super-secret-value');
  });

  test('listIntegrationMetadata reports requiresEnvSecrets: false for an env-free manifest', async () => {
    await saveIntegrationConfig(tempDir, 'docs', {
      id: 'docs',
      kind: 'mcp',
      transport: 'stdio',
      command: 'docs-mcp',
    });

    const tools = await listIntegrationMetadata(tempDir, noopLogger);
    expect(tools[0].requiresEnvSecrets).toBe(false);
  });

  test('stores write-only secret env values behind refs while hydrating the runtime read', async () => {
    const secret = 'storage-canary-secret';
    await saveIntegrationConfig(tempDir, 'secure', {
      id: 'secure',
      kind: 'mcp',
      secretEnv: { API_TOKEN: secret },
    });
    const path = join(tempDir, 'integrations', 'secure', 'integration.json');
    const bytes = readFileSync(path, 'utf8');
    expect(bytes).not.toContain(secret);
    expect(JSON.parse(bytes)).toMatchObject({
      storedEnvNames: ['API_TOKEN'],
    });
    expect((await loadIntegrationConfig(tempDir, 'secure')).env).toEqual({
      API_TOKEN: secret,
    });
  });

  test('migrates only explicitly edited legacy values and preserves untouched inline material', async () => {
    const directory = join(tempDir, 'integrations', 'mixed');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'integration.json');
    writeFileSync(
      path,
      JSON.stringify({
        id: 'mixed',
        kind: 'mcp',
        env: { OLD: 'legacy', KEEP: 'keep' },
      }),
    );
    const loaded = await loadIntegrationConfig(tempDir, 'mixed');
    await saveIntegrationConfig(tempDir, 'mixed', {
      ...loaded,
      secretEnv: { OLD: 'rotated' },
    });
    const bytes = readFileSync(path, 'utf8');
    expect(bytes).not.toContain('legacy');
    expect(bytes).not.toContain('rotated');
    expect(bytes).toContain('keep');
    expect((await loadIntegrationConfig(tempDir, 'mixed')).env).toEqual({
      OLD: 'rotated',
      KEEP: 'keep',
    });
  });

  test('a planted marker can only address the containing server namespace', async () => {
    await saveIntegrationConfig(tempDir, 'victim', {
      id: 'victim',
      kind: 'mcp',
      secretEnv: { TOKEN: 'stolen' },
    });
    const directory = join(tempDir, 'integrations', 'attacker');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'integration.json'),
      JSON.stringify({
        id: 'attacker',
        kind: 'mcp',
        storedEnvNames: ['STOLEN'],
      }),
    );
    await expect(loadIntegrationConfig(tempDir, 'attacker')).rejects.toThrow(
      'Tool-server credential is missing',
    );
  });

  test('serialized concurrent partial submissions preserve both newly added keys', async () => {
    await Promise.all([
      saveIntegrationConfig(tempDir, 'merge', {
        id: 'merge',
        kind: 'mcp',
        secretEnv: { TOKEN_A: 'a' },
      }),
      saveIntegrationConfig(tempDir, 'merge', {
        id: 'merge',
        kind: 'mcp',
        secretEnv: { TOKEN_B: 'b' },
      }),
    ]);
    expect((await loadIntegrationConfig(tempDir, 'merge')).env).toEqual({
      TOKEN_A: 'a',
      TOKEN_B: 'b',
    });
  });

  test('fails closed on the retired pre-release envCredentialRefs shape', async () => {
    const directory = join(tempDir, 'integrations', 'retired');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'integration.json'),
      JSON.stringify({
        id: 'retired',
        kind: 'mcp',
        envCredentialRefs: { TOKEN: 'old-ref' },
      }),
    );
    await expect(loadIntegrationConfig(tempDir, 'retired')).rejects.toThrow(
      /Retired tool-server credential format.*pre-release envCredentialRefs.*clear this developer home/,
    );
  });

  test('save fails closed instead of overwriting retired envCredentialRefs', async () => {
    const directory = join(tempDir, 'integrations', 'retired-save');
    const path = join(directory, 'integration.json');
    mkdirSync(directory, { recursive: true });
    const retired = JSON.stringify({
      id: 'retired-save',
      kind: 'mcp',
      envCredentialRefs: { TOKEN: 'old-ref' },
    });
    writeFileSync(path, retired);
    await expect(
      saveIntegrationConfig(tempDir, 'retired-save', {
        id: 'retired-save',
        kind: 'mcp',
      }),
    ).rejects.toThrow(/Retired tool-server credential format/);
    expect(readFileSync(path, 'utf8')).toBe(retired);
  });

  test('credential store rejects slash-bearing server ids', async () => {
    const { ToolServerCredentialStore } = await import(
      '../../services/plugins/tool-server-credential-store.js'
    );
    const store = new ToolServerCredentialStore(tempDir);
    await expect(store.upsert('../escape', 'TOKEN', 'secret')).rejects.toThrow(
      /Invalid tool-server credential server id.*\.\.\/escape/,
    );
  });

  test("another integration's completed save cannot reconcile an in-flight upsert", async () => {
    const { ToolServerCredentialStore } = await import(
      '../../services/plugins/tool-server-credential-store.js'
    );
    const store = new ToolServerCredentialStore(tempDir);
    // Save A has committed credential material but is paused before its marker.
    await store.upsert('server-a', 'NEW_TOKEN', 'a-secret');
    await saveIntegrationConfig(tempDir, 'server-b', {
      id: 'server-b',
      kind: 'mcp',
      secretEnv: { B_TOKEN: 'b-secret' },
    });
    expect(store.get('server-a', 'NEW_TOKEN')).toBe('a-secret');
    await saveIntegrationConfig(tempDir, 'server-a', {
      id: 'server-a',
      kind: 'mcp',
      secretEnv: { NEW_TOKEN: 'a-secret' },
    });
    expect((await loadIntegrationConfig(tempDir, 'server-a')).env).toEqual({
      NEW_TOKEN: 'a-secret',
    });
  });

  test('partial rotation preserves an untouched stored key', async () => {
    await saveIntegrationConfig(tempDir, 'rotate', {
      id: 'rotate',
      kind: 'mcp',
      secretEnv: { TOKEN_A: 'old-a', TOKEN_B: 'keep-b' },
    });
    const loaded = await loadIntegrationConfig(tempDir, 'rotate');
    await saveIntegrationConfig(tempDir, 'rotate', {
      ...loaded,
      secretEnv: { TOKEN_A: 'new-a' },
    });
    expect((await loadIntegrationConfig(tempDir, 'rotate')).env).toEqual({
      TOKEN_A: 'new-a',
      TOKEN_B: 'keep-b',
    });
  });

  test('a config-write failure after store upsert leaves an orphan, never a dangling marker', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      saveIntegrationConfig(tempDir, 'crash', {
        id: 'crash',
        kind: 'mcp',
        secretEnv: { TOKEN: 'orphan-safe' },
        circular,
      } as ToolDef),
    ).rejects.toThrow('circular');
    const { ToolServerCredentialStore } = await import(
      '../../services/plugins/tool-server-credential-store.js'
    );
    expect(new ToolServerCredentialStore(tempDir).get('crash', 'TOKEN')).toBe(
      'orphan-safe',
    );
    expect(
      existsSync(join(tempDir, 'integrations', 'crash', 'integration.json')),
    ).toBe(false);
    await saveIntegrationConfig(tempDir, 'healthy', {
      id: 'healthy',
      kind: 'mcp',
      secretEnv: { TOKEN: 'live' },
    });
    // Ordinary saves never sweep another integration's bucket. This crash-safe
    // orphan remains available for an explicit future maintenance operation.
    expect(new ToolServerCredentialStore(tempDir).get('crash', 'TOKEN')).toBe(
      'orphan-safe',
    );
  });

  test('a save waiting behind deletion recreates its directory only after it owns the integration lock', async () => {
    const integrationDir = join(tempDir, 'integrations', 'linearized-save');
    mkdirSync(integrationDir, { recursive: true });
    const release = acquireFileMutationLock(
      toolServerIntegrationMutationLockPath(tempDir, 'linearized-save'),
    );
    const save = saveIntegrationConfig(tempDir, 'linearized-save', {
      id: 'linearized-save',
      kind: 'mcp',
      displayName: 'Recreated after delete',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    rmSync(integrationDir, { recursive: true, force: true });
    release();

    await save;
    await expect(
      loadIntegrationConfig(tempDir, 'linearized-save'),
    ).resolves.toMatchObject({ displayName: 'Recreated after delete' });
  });

  test('a delete after a completed save removes the exact published integration', async () => {
    await saveIntegrationConfig(tempDir, 'linearized-delete', {
      id: 'linearized-delete',
      kind: 'mcp',
    });

    await deleteIntegrationConfig(tempDir, 'linearized-delete');

    expect(
      existsSync(
        join(tempDir, 'integrations', 'linearized-delete', 'integration.json'),
      ),
    ).toBe(false);
  });

  test('does not rewrite legacy inline env bytes on an unrelated read', async () => {
    const directory = join(tempDir, 'integrations', 'legacy-secret');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'integration.json');
    const bytes =
      '{"id":"legacy-secret","kind":"mcp","env":{"TOKEN":"legacy-material"}}';
    writeFileSync(path, bytes);
    await loadIntegrationConfig(tempDir, 'legacy-secret');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  describe('integration id defense-in-depth (repo review, 2026-07-26)', () => {
    test('loadIntegrationConfig rejects a path-traversal id instead of joining it onto the filesystem path', async () => {
      await expect(
        loadIntegrationConfig(tempDir, '../outside'),
      ).rejects.toThrow(/Invalid tool-server id/);
    });

    test('saveIntegrationConfig rejects a path-traversal id and never creates a directory outside the registry', async () => {
      await expect(
        saveIntegrationConfig(tempDir, '../../evil', {
          id: 'evil',
          kind: 'mcp',
        }),
      ).rejects.toThrow(/Invalid tool-server id/);
      expect(existsSync(join(tempDir, '..', 'evil'))).toBe(false);
      expect(existsSync(join(tempDir, '..', '..', 'evil'))).toBe(false);
    });

    test('deleteIntegrationConfig rejects a path-traversal id', async () => {
      await expect(deleteIntegrationConfig(tempDir, '..')).rejects.toThrow(
        /Invalid tool-server id/,
      );
    });

    test('rejects ids containing a slash even without a literal ".."', async () => {
      await expect(loadIntegrationConfig(tempDir, 'foo/bar')).rejects.toThrow(
        /Invalid tool-server id/,
      );
    });

    test('rejects an empty id', async () => {
      await expect(loadIntegrationConfig(tempDir, '')).rejects.toThrow(
        /Invalid tool-server id/,
      );
    });

    test('rejects a dangerous object key as a server id with a named error', async () => {
      await expect(loadIntegrationConfig(tempDir, '__proto__')).rejects.toThrow(
        /Invalid tool-server id.*__proto__/,
      );
    });

    test('accepts the canonical lowercase-kebab id shape used by every built-in tool server', async () => {
      await saveIntegrationConfig(tempDir, 'station-sessions-mcp', {
        id: 'station-sessions-mcp',
        kind: 'mcp',
      });
      await expect(
        loadIntegrationConfig(tempDir, 'station-sessions-mcp'),
      ).resolves.toMatchObject({ id: 'station-sessions-mcp' });
    });

    test('compat (repo review, 2026-07-26): a legacy-shaped id with dots, underscores, and mixed case loads/saves fine — the guard is a safety rule, not a naming aesthetic', async () => {
      await saveIntegrationConfig(tempDir, 'My.Tool_v2', {
        id: 'My.Tool_v2',
        kind: 'mcp',
        displayName: 'My Tool v2',
      });
      await expect(
        loadIntegrationConfig(tempDir, 'My.Tool_v2'),
      ).resolves.toMatchObject({ id: 'My.Tool_v2' });

      const tools = await listIntegrationMetadata(tempDir, noopLogger);
      expect(tools.map((tool) => tool.id)).toContain('My.Tool_v2');
    });

    test("a bare '.' or '..' id is rejected even without a slash", async () => {
      await expect(loadIntegrationConfig(tempDir, '.')).rejects.toThrow(
        /Invalid tool-server id/,
      );
      await expect(loadIntegrationConfig(tempDir, '..')).rejects.toThrow(
        /Invalid tool-server id/,
      );
    });
  });
});
