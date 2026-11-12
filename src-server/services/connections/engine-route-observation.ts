import type {
  EngineRouteObservation,
  ProviderConnectionConfig,
} from '@kontourai/station-contracts/tool';
import {
  managedEngineLaunch,
  managedEnginePin,
} from '../../security/managed-engine-limits.js';
import { childProcessEnvironment } from '../../utils/child-process-environment.js';
import { engineProxyLaunch } from './engine-proxy-routing.js';

/**
 * The variable each engine's CLI reads for a replacement endpoint. Codex
 * reads `OPENAI_BASE_URL` for its default provider (the Codex review
 * workflow relies on it). Claude Code's Bedrock and Vertex switches send it
 * to a cloud provider instead.
 */
const ENDPOINT_ENV = {
  claude: 'ANTHROPIC_BASE_URL',
  codex: 'OPENAI_BASE_URL',
} as const;
const CLOUD_SWITCH_ENV = {
  claude: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
  codex: [],
} as const;
/** Codex `-c` keys that choose a provider or its endpoint. */
const ROUTE_ARG = {
  claude: /^--settings(=|$)/,
  codex:
    /(^|[\s"'=])(model_provider|model_providers|openai_base_url)\b|^(-p|--profile)(=|$)/,
} as const;

/**
 * Where an engine child's model traffic goes, from the launch the adapter
 * actually makes: this process's environment with the connection's launch
 * env layered over it (`childProcessEnvironment`, which also scrubs boot
 * secrets), then the managed policy's pinned arguments and environment
 * merged in (`managedEngineLaunch`), as the Claude and Codex spawns do.
 *
 * - `proxy`: the saved proxy Station applies; `origin` is its endpoint.
 * - `ambient`: an endpoint variable in that env. `source` says who set it:
 *   the connection's saved env, the managed policy, or Station's own
 *   environment. Only the origin is reported, so userinfo, path and query
 *   never leave the server.
 * - `account`: no endpoint override in Station's launch. Engine settings
 *   files (Claude's `settings.json` cascade, Codex's `config.toml`) are not
 *   read here, so they can still route the engine; clients read this as an
 *   unobserved route, not as the account.
 * - `unknown`: an override exists but cannot be named: an unusable endpoint
 *   value, a cloud-provider switch, a pinned Codex provider argument, or a
 *   saved proxy the launch would refuse.
 */
export function observeEngineRoute(
  engine: 'claude' | 'codex',
  config: Record<string, unknown> | undefined,
  connections: readonly ProviderConnectionConfig[],
  platform: NodeJS.Platform = process.platform,
): EngineRouteObservation {
  let proxyLaunch: ReturnType<typeof engineProxyLaunch>;
  try {
    proxyLaunch = engineProxyLaunch(engine, config, connections);
  } catch {
    // The launch refuses this proxy; nothing is routed yet.
    return { kind: 'unknown' };
  }
  const base = { ...childProcessEnvironment(proxyLaunch.env, platform) };
  const launch = managedEngineLaunch(
    engine,
    { command: engine, args: proxyLaunch.args, env: base },
    'station',
    platform,
  );
  // Pinned launch arguments that can choose the route make it unknown rather
  // than a guess: Claude `--settings` (it can carry an env block), Codex
  // provider config in either `-c key=…` or `--config=key=…` form, and a
  // Codex profile, which can select any provider.
  const pinnedArgs = launch.args.slice(proxyLaunch.args.length);
  if (pinnedArgs.some((arg) => ROUTE_ARG[engine].test(arg)))
    return { kind: 'unknown' };
  const name = ENDPOINT_ENV[engine];
  const read = (
    env: Record<string, string | undefined> | undefined,
    key: string,
  ) => envValue(env, key, platform);
  if (proxyLaunch.route) {
    // Claude's proxy is the endpoint variable; a locked policy variable
    // would replace it (Codex's proxy is an argument the policy follows).
    const proxied =
      engine === 'codex' ||
      read(launch.env, name) === read(proxyLaunch.env, name);
    if (proxied)
      return {
        kind: 'proxy',
        origin: proxyLaunch.route.endpoint,
        label: proxyLaunch.route.label,
      };
  }
  if (CLOUD_SWITCH_ENV[engine].some((key) => truthy(read(launch.env, key))))
    return { kind: 'unknown' };
  const value = read(launch.env, name)?.trim();
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
  const pinned = read(managedEnginePin(engine)?.environment, name);
  return {
    kind: 'ambient',
    origin: url.origin,
    source:
      pinned !== undefined && pinned.trim() === value
        ? 'policy'
        : read(proxyLaunch.env, name)?.trim() === value
          ? 'connection'
          : 'station',
  };
}

/** A variable's value; Windows names are case-insensitive. */
function envValue(
  env: Record<string, string | undefined> | undefined,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (!env) return undefined;
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find(
    (candidate) => candidate.toUpperCase() === name.toUpperCase(),
  );
  return key === undefined ? undefined : env[key];
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && normalized !== '0' && normalized !== 'false';
}
