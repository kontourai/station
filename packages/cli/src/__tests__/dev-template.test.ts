import { describe, expect, test } from 'vitest';
import { generateDevHTML } from '../dev/template.js';

describe('generateDevHTML', () => {
  test('composes dev template from extracted style and script helpers', () => {
    const html = generateDevHTML({
      name: 'Test Plugin',
      pluginName: 'test-plugin',
      tabsJson: '[{"id":"main"}]',
      registryJson:
        '{"layouts":[],"actions":[],"agents":[],"integrations":[],"prompts":[],"dependencies":[]}',
      sdkMockJs: 'window.__station_ai_sdk_mock = {};',
    });

    expect(html).toContain('Test Plugin — Dev Preview');
    expect(html).toContain(
      "window.__station_ai_plugins&&window.__station_ai_plugins['test-plugin']",
    );
    expect(html).toContain('window.__station_ai_shared = {');
    // The harness must expose the readiness handle the plugin guide documents
    // (station#883). Without it, a plugin written against the real host throws
    // `__station_ai_shared_ready is not a function` under `station plugin dev`.
    expect(html).toContain('window.__station_ai_shared_ready = function()');
    expect(html).toContain('var tabs=[{"id":"main"}]');
    expect(html).toContain(
      'var registry={"layouts":[],"actions":[],"agents":[],"integrations":[],"prompts":[],"dependencies":[]}',
    );
    expect(html).toContain("var es=new EventSource('/api/reload')");
  });
});
