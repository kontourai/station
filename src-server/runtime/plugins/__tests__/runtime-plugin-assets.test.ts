import { describe, expect, test, vi } from 'vitest';
import { loadRuntimePluginAssets } from '../runtime-plugin-assets.js';

describe('loadRuntimePluginAssets', () => {
  test('loads plugin providers before plugin prompts', async () => {
    const calls: string[] = [];
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
      { loadProviders, loadPrompts },
    );

    expect(loadProviders).toHaveBeenCalledWith({
      logger: expect.anything(),
      projectHomeDir: '/tmp/project',
      loadPluginOverrides: expect.any(Function),
    });
    expect(loadPrompts).toHaveBeenCalledWith({
      logger: expect.anything(),
      projectHomeDir: '/tmp/project',
    });
    expect(calls).toEqual(['providers', 'prompts']);
  });
});
