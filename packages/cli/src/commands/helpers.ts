import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { readPluginManifest } from '@kontourai/station-shared/parsers';

import {
  admitStationRuntimeHome,
  resolveStationRuntimeContext,
} from '@kontourai/station-shared/runtime-path-resolver';
import { createStationTempDirSync } from '@kontourai/station-shared/temp-dir';

function defaultRuntimeContext(env: NodeJS.ProcessEnv = process.env) {
  const withoutExplicitHome = { ...env };
  delete withoutExplicitHome.STATION_HOME;
  return resolveStationRuntimeContext(withoutExplicitHome);
}

export const DEFAULT_SERVER_PORT = defaultRuntimeContext().serverPort;
export const DEFAULT_UI_PORT = defaultRuntimeContext().uiPort;

export const DEFAULT_INSTANCE_ID = 'default';
function defaultProjectHome(env: NodeJS.ProcessEnv = process.env): string {
  return defaultRuntimeContext(env).home;
}

/** Env override: STATION_HOME. */
function resolveHomeEnv(env: NodeJS.ProcessEnv = process.env): {
  value?: string;
} {
  if (env.STATION_HOME) return { value: env.STATION_HOME };
  return {};
}

export const DEFAULT_PROJECT_HOME = defaultProjectHome();
export const PROJECT_HOME = resolve(
  resolveHomeEnv().value || DEFAULT_PROJECT_HOME,
);
export const PLUGINS_DIR = join(PROJECT_HOME, 'plugins');
export const AGENTS_DIR = join(PROJECT_HOME, 'agents');
export const CWD = process.cwd();
export const PIDFILE = join(CWD, '.station.pids');
export const INSTANCE_STATE_DIR = join(CWD, '.station', 'instances');

/**
 * The directory `station` was invoked from, before the launcher `cd`s into
 * the repo root to bootstrap the CLI (see the `station` script). Falls back
 * to `CWD` when unset (e.g. the CLI is invoked directly, without the
 * launcher). The plugin command family (create/build/dev/local install)
 * operates on a plugin directory that lives outside the Station repo and
 * must resolve paths against this, not `CWD` — lifecycle commands
 * (start/stop/build the Station app/doctor/config/etc.) intentionally keep
 * using `CWD`, since they operate on the Station checkout itself and the
 * launcher always `cd`s there first regardless of invocation directory.
 */
export const INVOKED_CWD = resolve(process.env.STATION_INVOKED_CWD || CWD);

export type LifecycleHomeSource =
  | 'env'
  | '--home'
  | '--base'
  | '--temp-home'
  | 'default';

export interface LifecycleHomeTarget {
  projectHome: string;
  isDefaultHome: boolean;
  source: LifecycleHomeSource;
}

export interface LifecycleHomeOptions {
  baseDir?: string;
  /**
   * `--home=<path>` (station#4299). The same setting `baseDir` carries, under
   * the name the rest of Station uses for it — `STATION_HOME`, `~/.station`,
   * `station home verify`. It exists because `--base` did not read as a home
   * override to anyone looking for one, so the only obvious way to isolate a
   * run was `--temp-home`, and getting it wrong booted the real home silently.
   */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  tempHome?: boolean;
}

export interface LifecycleInstanceIdentityOptions {
  cwd?: string;
  instanceName?: string;
  projectHome?: string;
  serverPort?: number;
  uiPort?: number;
}

export function getDefaultProjectHome(): string {
  return defaultProjectHome();
}

export function normalizeHomePath(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const normalized = resolve(path);
  admitStationRuntimeHome(normalized, env);
  return normalized;
}

export function resolveLifecycleHomeTarget(
  options: LifecycleHomeOptions = {},
): LifecycleHomeTarget {
  const env = options.env ?? process.env;

  if (options.tempHome) {
    const projectHome = normalizeHomePath(createStationTempDirSync('dev-home'));
    return {
      projectHome,
      isDefaultHome: false,
      source: '--temp-home',
    };
  }

  // `--home` and `--base` name one setting, so a caller that supplies both is
  // rejected upstream in `parseLifecycleArgs` rather than silently ranked here.
  if (options.homeDir) {
    const projectHome = normalizeHomePath(options.homeDir, env);
    return {
      projectHome,
      isDefaultHome:
        admitStationRuntimeHome(projectHome, env) ===
        admitStationRuntimeHome(defaultProjectHome(env), env),
      source: '--home',
    };
  }

  if (options.baseDir) {
    const projectHome = normalizeHomePath(options.baseDir, env);
    return {
      projectHome,
      isDefaultHome:
        admitStationRuntimeHome(projectHome, env) ===
        admitStationRuntimeHome(defaultProjectHome(env), env),
      source: '--base',
    };
  }

  const homeEnv = resolveHomeEnv(env);
  if (homeEnv.value) {
    const projectHome = normalizeHomePath(homeEnv.value, env);
    return {
      projectHome,
      isDefaultHome:
        admitStationRuntimeHome(projectHome, env) ===
        admitStationRuntimeHome(defaultProjectHome(env), env),
      source: 'env',
    };
  }

  return {
    projectHome: admitStationRuntimeHome(defaultProjectHome(env), env),
    isDefaultHome: true,
    source: 'default',
  };
}

export function normalizeInstanceName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || DEFAULT_INSTANCE_ID;
}

export function resolveLifecycleInstanceId(
  options: LifecycleInstanceIdentityOptions = {},
): string {
  if (options.instanceName?.trim()) {
    return normalizeInstanceName(options.instanceName);
  }

  const projectHome = normalizeHomePath(
    options.projectHome || DEFAULT_PROJECT_HOME,
  );
  const serverPort = options.serverPort ?? DEFAULT_SERVER_PORT;
  const uiPort = options.uiPort ?? DEFAULT_UI_PORT;

  if (
    projectHome === DEFAULT_PROJECT_HOME &&
    serverPort === DEFAULT_SERVER_PORT &&
    uiPort === DEFAULT_UI_PORT
  ) {
    return DEFAULT_INSTANCE_ID;
  }

  const hash = createHash('sha1')
    .update(
      JSON.stringify({
        cwd: options.cwd || CWD,
        projectHome,
        serverPort,
        uiPort,
      }),
    )
    .digest('hex')
    .slice(0, 12);

  return `instance-${hash}`;
}

export function getInstanceStatePath(instanceId: string, cwd = CWD): string {
  return join(cwd, '.station', 'instances', `${instanceId}.json`);
}

export function readManifest(dir = CWD): PluginManifest {
  return readPluginManifest(dir);
}

export function isGitUrl(source: string): boolean {
  return (
    source.startsWith('git@') ||
    source.endsWith('.git') ||
    (source.startsWith('https://') &&
      (source.includes('.git') ||
        source.includes('gitlab') ||
        source.includes('github')))
  );
}

export function parseGitSource(source: string): {
  url: string;
  branch: string;
} {
  const [url, branch] = source.split('#');
  return { url, branch: branch || 'main' };
}

export function extractPluginName(
  source: string,
  invokedCwd = INVOKED_CWD,
): string {
  if (isGitUrl(source)) {
    const { url } = parseGitSource(source);
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : url.split('/').pop()!.replace('.git', '');
  }
  return basename(resolve(invokedCwd, source.replace(/\\/g, '/')));
}

/** Scan installed plugins for registry.json files and look up a dep by id */
export function lookupDepInRegistries(id: string): string | null {
  if (!existsSync(PLUGINS_DIR)) return null;
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(PLUGINS_DIR, entry.name, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      for (const p of manifest.providers || []) {
        if (
          p.module?.endsWith('.json') &&
          (p.type === 'agentRegistry' || p.type === 'toolRegistry')
        ) {
          const regPath = join(PLUGINS_DIR, entry.name, p.module);
          if (!existsSync(regPath)) continue;
          const reg = JSON.parse(readFileSync(regPath, 'utf-8'));
          const found = (reg.plugins || []).find((pl: any) => pl.id === id);
          if (found?.source) return found.source;
        }
      }
    } catch {}
  }
  return null;
}
