import type {
  EngineRouteObservation,
  ProviderConnectionConfig,
} from '@kontourai/station-contracts/tool';
import { engineProxyLaunch } from './engine-proxy-routing.js';

/**
 * The variable each engine's CLI reads for a replacement endpoint. Claude
 * Code's Bedrock and Vertex switches send it to a cloud provider instead.
 */
const ENDPOINT_ENV = {
  claude: 'ANTHROPIC_BASE_URL',
  codex: 'OPENAI_BASE_URL',
} as const;
const CLOUD_SWITCH_ENV = {
  claude: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  codex: [],
} as const;

/**
 * Where an engine child's model traffic goes, from the env it actually
 * receives: this process's environment with the connection's launch env
 * (saved env, config home, saved proxy) layered over it, as
 * `childProcessEnvironment` builds it.
 *
 * - `proxy`: the saved proxy Station applies; `origin` is its endpoint.
 * - `ambient`: an endpoint variable the child inherits or the connection
 *   sets. Only the origin is reported, so userinfo, path and query never
 *   leave the server.
 * - `account`: no endpoint override in that env. Engine settings files
 *   (Claude's `settings.json` cascade, Codex's `config.toml`) are not read
 *   here, so they can still route the engine.
 * - `unknown`: an override exists but cannot be named — an unusable endpoint
 *   value, a cloud-provider switch, or a saved proxy the launch would refuse.
 */
export function observeEngineRoute(
  engine: 'claude' | 'codex',
  config: Record<string, unknown> | undefined,
  connections: readonly ProviderConnectionConfig[],
  inherited: NodeJS.ProcessEnv = process.env,
): EngineRouteObservation {
  let launch: ReturnType<typeof engineProxyLaunch>;
  try {
    launch = engineProxyLaunch(engine, config, connections);
  } catch {
    // The launch refuses this proxy; nothing is routed yet.
    return { kind: 'unknown' };
  }
  if (launch.route)
    return {
      kind: 'proxy',
      origin: launch.route.endpoint,
      label: launch.route.label,
    };
  const env = { ...inherited, ...launch.env };
  if (CLOUD_SWITCH_ENV[engine].some((name) => truthy(env[name])))
    return { kind: 'unknown' };
  const value = env[ENDPOINT_ENV[engine]]?.trim();
  // An empty value is a mask: the CLI then uses its own endpoint.
  if (!value) return { kind: 'account' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'unknown' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { kind: 'unknown' };
  return { kind: 'ambient', origin: url.origin };
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && normalized !== '0' && normalized !== 'false';
}
