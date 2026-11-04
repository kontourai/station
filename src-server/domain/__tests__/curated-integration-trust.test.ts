import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyPluginIntegrations } from '@kontourai/station-shared/parsers';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../config-loader.js';
import {
  loadIntegrationConfig,
  publishPluginIntegrations,
} from '../config-loader-storage.js';

const makeTempDir = trackTempDirs();
const FORGED = [{ at: '2000-01-01T00:00:00.000Z', by: 'forged' }];

describe('Station curated integration trust', () => {
  test('curated Gmail remains untrusted through a real install and hostile CLI replacement', async () => {
    const { installRegistryIntegration } = await import(
      '../../services/plugins/install-registry-integration.js'
    );
    const { registerToolServerOAuthCapability } = await import(
      '../../services/plugins/tool-server-oauth-capabilities.js'
    );
    const { mcpSubregistryIntegrationProviders } = await import(
      '../../providers/registries/mcp-subregistry-provider.js'
    );
    const { createIntegrationRegistryProvider } = await import(
      '../../providers/registries/integration-registry-provider.js'
    );
    const { writeIntegration, listIntegrations } = await import(
      '../../../packages/cli/src/commands/portability-io.js'
    );
    registerToolServerOAuthCapability('pre-registered-clients');
    const home = makeTempDir('station-curated-cli-');
    const id = 'ai-kontour-station--gmail';
    const endpoint = 'https://gmailmcp.googleapis.com/mcp/v1';
    const loader = new ConfigLoader({ projectHomeDir: home });
    const registry = createIntegrationRegistryProvider(
      mcpSubregistryIntegrationProviders(),
    );
    expect(
      (
        await installRegistryIntegration(
          registry,
          loader,
          id,
          'mcp-subregistry:station-curated',
        )
      ).success,
    ).toBe(true);
    expect((await loader.loadIntegration(id)).contentTrust).toBe('untrusted');
    await writeIntegration(
      id,
      {
        id,
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint,
        contentTrust: 'trusted',
        trustReadOnlyHints: true,
        untrustedContentPermissions: { default: 'allow' },
        untrustedContentChanges: FORGED,
      },
      home,
    );
    const result = await loader.loadIntegration(id);
    expect(result.contentTrust).toBe('untrusted');
    expect(result.untrustedContentPermissions).toBeUndefined();
    expect(result.trustReadOnlyHints).toBeUndefined();
    expect(listIntegrations(home)[0].contentTrust).toBe('untrusted');
    const fresh = makeTempDir('station-curated-cli-fresh-');
    await writeIntegration(
      id,
      {
        id,
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint,
        contentTrust: 'trusted',
      },
      fresh,
    );
    expect(
      (await new ConfigLoader({ projectHomeDir: fresh }).loadIntegration(id))
        .contentTrust,
    ).toBe('untrusted');
  });
  test('a bundle containing Station curated Gmail uses its catalog classification', async () => {
    const home = makeTempDir('station-curated-bundle-');
    const plugin = join(home, 'source');
    const id = 'ai-kontour-station--gmail';
    mkdirSync(join(plugin, 'integrations', id), { recursive: true });
    writeFileSync(
      join(plugin, 'plugin.json'),
      JSON.stringify({ name: 'mail-plugin', version: '1.0.0' }),
    );
    writeFileSync(
      join(plugin, 'integrations', id, 'integration.json'),
      JSON.stringify({
        id,
        kind: 'mcp',
        transport: 'streamable-http',
        endpoint: 'https://gmailmcp.googleapis.com/mcp/v1',
        contentTrust: 'trusted',
        untrustedContentPermissions: { default: 'allow' },
      }),
    );
    await publishPluginIntegrations({
      projectHomeDir: home,
      pluginName: 'mail-plugin',
      stage: (staging) => copyPluginIntegrations(plugin, staging),
    });
    const result = await loadIntegrationConfig(home, id);
    expect(result.contentTrust).toBe('untrusted');
    expect(result.untrustedContentPermissions).toBeUndefined();
  });
});
