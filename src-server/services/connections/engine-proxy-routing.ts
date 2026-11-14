import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { managedEngineEnvironmentLocked } from '../../security/managed-engine-limits.js';
import { connectionSpawnEnv } from './connection-env.js';

class EngineProxyConfigurationError extends Error {}

/** Launch identity for route lookup only; no credential or resource authority is granted. */
export interface EngineSessionLaunchContext {
  readonly threadId: string;
  readonly cwd?: string;
  readonly modelId?: string;
}

export interface EngineProxyRoute {
  connectionId: string;
  label: string;
  endpoint: string;
}

/** Resolve only an explicitly selected, operator-owned model connection. */
export function resolveEngineProxy(
  config: Record<string, unknown> | undefined,
  connections: readonly ProviderConnectionConfig[],
): { route: EngineProxyRoute; baseUrl: string; apiKey: string } | undefined {
  const id = config?.proxyConnectionId;
  if (typeof id !== 'string' || !id) return undefined;
  const connection = connections.find((candidate) => candidate.id === id);
  if (!connection?.enabled || connection.type !== 'openai-compat') {
    throw new EngineProxyConfigurationError(
      'Choose an available proxy connection under Models.',
    );
  }
  const value = connection.config.baseUrl;
  let url: URL;
  try {
    url = new URL(typeof value === 'string' ? value : '');
  } catch {
    throw new EngineProxyConfigurationError(
      'The selected proxy needs a valid address.',
    );
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new EngineProxyConfigurationError(
      'The selected proxy needs an HTTP or HTTPS address without embedded credentials.',
    );
  }
  const apiKey = connection.config.apiKey;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new EngineProxyConfigurationError(
      'Add a key to the selected proxy connection under Models.',
    );
  }
  const baseUrl = url.href.replace(/\/$/, '');
  return {
    route: { connectionId: id, label: connection.name, endpoint: url.origin },
    baseUrl,
    apiKey,
  };
}

export function engineProxyLaunch(
  engine: 'claude' | 'codex',
  config: Record<string, unknown> | undefined,
  connections: readonly ProviderConnectionConfig[],
): {
  env: Record<string, string> | undefined;
  args: string[];
  route?: EngineProxyRoute;
} {
  // #4520: under a locked managed environment the user's model-proxy route
  // is not applied either; it would send the engine's traffic to an
  // endpoint the administrator did not choose.
  if (managedEngineEnvironmentLocked(engine))
    return { env: undefined, args: [] };
  const env = connectionSpawnEnv(config, engine);
  const proxy = resolveEngineProxy(config, connections);
  if (!proxy) return { env, args: [] };
  if (engine === 'claude') {
    return {
      env: {
        ...env,
        ANTHROPIC_BASE_URL: proxy.baseUrl.replace(/\/v1$/, ''),
        ANTHROPIC_AUTH_TOKEN: proxy.apiKey,
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
      },
      args: [],
      route: proxy.route,
    };
  }
  const baseUrl = proxy.baseUrl.endsWith('/v1')
    ? proxy.baseUrl
    : `${proxy.baseUrl}/v1`;
  // Command overrides preserve the user's home and native resume history.
  // The credential travels only in the child environment, never argv.
  const overrides = {
    model_provider: 'station-proxy',
    'features.api_key_model_discovery': true,
    'model_providers.station-proxy': {
      name: proxy.route.label,
      base_url: baseUrl,
      wire_api: 'responses',
      env_key: 'STATION_ENGINE_PROXY_KEY',
      model_catalog_url: `${baseUrl}/models`,
    },
  };
  const args = Object.entries(overrides).flatMap(([key, value]) => {
    const toml =
      typeof value === 'object'
        ? `{${Object.entries(value)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(',')}}`
        : JSON.stringify(value);
    return ['-c', `${key}=${toml}`];
  });
  return {
    env: { ...env, STATION_ENGINE_PROXY_KEY: proxy.apiKey },
    args,
    route: proxy.route,
  };
}
