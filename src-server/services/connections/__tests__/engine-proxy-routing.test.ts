import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import {
  engineProxyLaunch,
  resolveEngineProxy,
} from '../engine-proxy-routing.js';

const proxy: ProviderConnectionConfig = {
  id: 'home-proxy',
  type: 'openai-compat',
  name: 'brian-media',
  enabled: true,
  capabilities: ['llm'],
  config: {
    baseUrl: 'https://proxy.example:8317/v1',
    apiKey: 'private-test-key',
  },
};

describe('saved engine proxy routing', () => {
  test('Claude uses the saved key and Messages root without importing the global account', () => {
    const launch = engineProxyLaunch(
      'claude',
      { proxyConnectionId: proxy.id },
      [proxy],
    );
    expect(launch.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://proxy.example:8317',
      ANTHROPIC_AUTH_TOKEN: 'private-test-key',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
    });
    expect(launch.route).toEqual({
      connectionId: proxy.id,
      label: 'brian-media',
      endpoint: 'https://proxy.example:8317',
    });
    expect(JSON.stringify(launch.route)).not.toContain('private-test-key');
  });
  test('Codex overrides the provider and discovers the saved proxy while preserving its config home', () => {
    const launch = engineProxyLaunch(
      'codex',
      { proxyConnectionId: proxy.id, configHome: '/tmp/existing-native-home' },
      [proxy],
    );
    expect(launch.env).toMatchObject({
      CODEX_HOME: '/tmp/existing-native-home',
      STATION_ENGINE_PROXY_KEY: 'private-test-key',
    });
    expect(launch.args).toContain('model_provider="station-proxy"');
    expect(launch.args).toContain('features.api_key_model_discovery=true');
    expect(launch.args.join(' ')).toContain(
      'model_catalog_url="https://proxy.example:8317/v1/models"',
    );
    expect(launch.args.join(' ')).not.toContain('private-test-key');
  });
  test.each([
    { ...proxy, enabled: false },
    {
      ...proxy,
      config: {
        baseUrl: 'https://user:secret@proxy.example/v1',
        apiKey: 'key',
      },
    },
    { ...proxy, config: { baseUrl: 'https://proxy.example/v1', apiKey: '' } },
  ])(
    'an unavailable or unsafe selected proxy cannot fall back to the direct account',
    (invalid) => {
      expect(() =>
        engineProxyLaunch('codex', { proxyConnectionId: proxy.id }, [invalid]),
      ).toThrow();
    },
  );
  test('reads the current saved credential on each launch', () => {
    expect(
      resolveEngineProxy({ proxyConnectionId: proxy.id }, [
        { ...proxy, config: { ...proxy.config, apiKey: 'rotated-key' } },
      ])?.apiKey,
    ).toBe('rotated-key');
  });
});
