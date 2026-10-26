import { describe, expect, test, vi } from 'vitest';
import { loadRuntimePluginAssets } from '../runtime-plugin-assets.js';

describe('loadRuntimePluginAssets', () => {
  test('grandfathers install trust, then loads providers, then prompts', async () => {
    const calls: string[] = [];
    const migrateInstallTrust = vi.fn(async () => {
      calls.push('trust-migration');
    });
    const loadProviders = vi.fn(async () => {
      calls.push('providers');
    });
    const loadPrompts = vi.fn(async () => {
      calls.push('prompts');
    });

    await loadRuntimePluginAssets(
      {
        logger: { info: vi.fn() } as any,
        projectHomeDir: '/tmp/project',
        loadPluginOverrides: vi.fn(async () => ({})),
      },
      { loadProviders, loadPrompts, migrateInstallTrust },
    );

    expect(migrateInstallTrust).toHaveBeenCalledWith({
      logger: expect.anything(),
      projectHomeDir: '/tmp/project',
    });
    expect(loadProviders).toHaveBeenCalledWith({
      packageMcpJournal: undefined,
      logger: expect.anything(),
      projectHomeDir: '/tmp/project',
      loadPluginOverrides: expect.any(Function),
    });
    expect(loadPrompts).toHaveBeenCalledWith({
      logger: expect.anything(),
      projectHomeDir: '/tmp/project',
    });
    expect(calls).toEqual(['trust-migration', 'providers', 'prompts']);
  });
});
