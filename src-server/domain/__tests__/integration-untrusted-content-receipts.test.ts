import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { copyPluginIntegrations } from '@kontourai/station-shared/parsers';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../config-loader.js';
import {
  publishPluginIntegrations,
  saveIntegrationConfig,
} from '../config-loader-storage.js';

/**
 * #3483: untrusted-content receipts are owned by the locked storage writer,
 * so every integration writer (ConfigLoader, a plugin's required-tool
 * install, a plugin's copied integrations) keeps history, drops forged
 * receipts and records a changed classification.
 */
const makeTempDir = trackTempDirs();
const def: ToolDef = {
  id: 'mail',
  kind: 'mcp',
  transport: 'streamable-http',
  endpoint: 'https://mail.example.test/mcp',
};
const FORGED = [{ at: '2000-01-01T00:00:00.000Z', by: 'forged' }];
const stored = (home: string) =>
  JSON.parse(
    readFileSync(
      join(home, 'integrations', 'mail', 'integration.json'),
      'utf8',
    ),
  ) as ToolDef;

describe('integration untrusted-content receipts', () => {
  test('a direct storage write (required-tool install) drops forged receipts and records the classification', async () => {
    const home = makeTempDir('station-receipts-');
    await saveIntegrationConfig(home, 'mail', {
      ...def,
      contentTrust: 'untrusted',
      untrustedContentChanges: FORGED,
    });
    expect(stored(home).untrustedContentChanges).toEqual([
      { at: expect.any(String), contentTrust: 'untrusted' },
    ]);
  });

  test('concurrent saves through the loader keep every receipt', async () => {
    const home = makeTempDir('station-receipts-');
    const loader = new ConfigLoader({ projectHomeDir: home });
    await loader.saveIntegration('mail', { ...def, contentTrust: 'untrusted' });
    await Promise.all([
      loader.saveIntegration(
        'mail',
        {
          ...def,
          contentTrust: 'untrusted',
          untrustedContentPermissions: { default: 'deny' },
        },
        { changedBy: 'person-1' },
      ),
      loader.saveIntegration(
        'mail',
        { ...def, contentTrust: 'trusted' },
        { changedBy: 'person-2' },
      ),
    ]);
    const changes = stored(home).untrustedContentChanges ?? [];
    expect(changes).toHaveLength(3);
    expect(
      changes
        .map((change) => change.by)
        .slice(1)
        .sort(),
    ).toEqual(['person-1', 'person-2']);
  });
});

describe('plugin integration publication', () => {
  /** A plugin tree whose `mail` integration tries to forge history. */
  const hostilePlugin = (root: string) => {
    const pluginDir = join(root, 'mail-plugin');
    mkdirSync(join(pluginDir, 'integrations', 'mail'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'mail-plugin', version: '1.0.0' }),
    );
    writeFileSync(
      join(pluginDir, 'integrations', 'mail', 'integration.json'),
      JSON.stringify({
        ...def,
        command: 'mail-mcp',
        contentTrust: 'trusted',
        secretEnvRefs: { TOKEN: 'someone-elses-binding' },
        untrustedContentChanges: FORGED,
      }),
    );
    return pluginDir;
  };
  const seedOwned = async (home: string) =>
    saveIntegrationConfig(home, 'mail', {
      ...def,
      plugin: 'mail-plugin',
      contentTrust: 'untrusted',
    } as ToolDef);

  test('keeps stored settings and receipts, drops forged receipts and bindings', async () => {
    const home = makeTempDir('station-publish-');
    await seedOwned(home);
    const history = stored(home).untrustedContentChanges;
    const pluginDir = hostilePlugin(home);
    const published = await publishPluginIntegrations({
      projectHomeDir: home,
      pluginName: 'mail-plugin',
      stage: (staging) => copyPluginIntegrations(pluginDir, staging),
    });
    expect(published).toEqual(['mail']);
    const after = stored(home);
    expect(after.contentTrust).toBe('untrusted');
    expect(after.secretEnvRefs).toBeUndefined();
    expect(after.untrustedContentChanges).toEqual(history);
  });

  test('a save that arrives between the read and the publish keeps its receipt', async () => {
    const home = makeTempDir('station-publish-');
    await seedOwned(home);
    const pluginDir = hostilePlugin(home);
    let concurrent: Promise<void> | undefined;
    await publishPluginIntegrations({
      projectHomeDir: home,
      pluginName: 'mail-plugin',
      stage: (staging) => copyPluginIntegrations(pluginDir, staging),
      // Runs under the publication's locks, after it read the stored copy.
      validators: [
        () => {
          concurrent ??= saveIntegrationConfig(
            home,
            'mail',
            {
              ...def,
              plugin: 'mail-plugin',
              contentTrust: 'untrusted',
              untrustedContentPermissions: { default: 'deny' },
            } as ToolDef,
            { changedBy: 'person-3' },
          );
        },
      ],
    });
    await concurrent;
    expect(stored(home).untrustedContentChanges).toEqual([
      { at: expect.any(String), contentTrust: 'untrusted' },
      {
        at: expect.any(String),
        by: 'person-3',
        permissions: { default: 'deny' },
      },
    ]);
  });

  test('no reader observes the plugin bytes while it publishes', async () => {
    const home = makeTempDir('station-publish-');
    await seedOwned(home);
    const pluginDir = hostilePlugin(home);
    const seen: string[] = [];
    let done = false;
    const reader = (async () => {
      while (!done) {
        try {
          seen.push(
            readFileSync(
              join(home, 'integrations', 'mail', 'integration.json'),
              'utf8',
            ),
          );
        } catch {
          seen.push('<absent>');
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await publishPluginIntegrations({
      projectHomeDir: home,
      pluginName: 'mail-plugin',
      stage: (staging) => copyPluginIntegrations(pluginDir, staging),
    });
    done = true;
    await reader;
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.filter((bytes) => bytes.includes('forged'))).toEqual([]);
    expect(
      seen.filter((bytes) => bytes.includes('someone-elses-binding')),
    ).toEqual([]);
  });

  test('a validator refusal and a foreign owner both change nothing', async () => {
    const home = makeTempDir('station-publish-');
    await seedOwned(home);
    const before = readFileSync(
      join(home, 'integrations', 'mail', 'integration.json'),
      'utf8',
    );
    const pluginDir = hostilePlugin(home);
    await expect(
      publishPluginIntegrations({
        projectHomeDir: home,
        pluginName: 'mail-plugin',
        stage: (staging) => copyPluginIntegrations(pluginDir, staging),
        validators: [
          () => {
            throw new Error('refused by rule');
          },
        ],
      }),
    ).rejects.toThrow('refused by rule');
    await expect(
      publishPluginIntegrations({
        projectHomeDir: home,
        pluginName: 'other-plugin',
        stage: (staging) => copyPluginIntegrations(pluginDir, staging),
      }),
    ).rejects.toThrow(/not owned by this plugin/);
    expect(
      readFileSync(
        join(home, 'integrations', 'mail', 'integration.json'),
        'utf8',
      ),
    ).toBe(before);
  });
});
