import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import { readPluginManifest } from '@kontourai/station-shared/parsers';

import {
  admitStationRuntimeHome,
  resolveStationRoot,
  resolveStationRuntimeContext,
  runtimeChannelFromEnvironment,
  StationRuntimeHomeAdmissionError,
} from '@kontourai/station-shared/runtime-path-resolver';
import {
  createStationTempDirSync,
  STATION_TEMP_ROOT_NAME,
} from '@kontourai/station-shared/temp-dir';
import {
  type LifecycleCodeRoot,
  type LifecycleStateLocation,
  resolveLifecycleCodeRoot,
  resolveLifecycleStateLocation,
} from './lifecycle-code-root.js';

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
/** What this process runs from: a source tree or a prebuilt archive (#2675). */
export const LIFECYCLE_CODE_ROOT: LifecycleCodeRoot =
  resolveLifecycleCodeRoot(CWD);

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

const SYSTEM_TEMP_HOME_ROOT = join('/tmp', STATION_TEMP_ROOT_NAME);

/**
 * The Station-owned `<home>/tmp` tree containing `candidate`, for the homes an
 * agent can inherit: `STATION_HOME` and the resolved Station root (which is
 * that home when it is self-rooted). Station hands spawned engines
 * `<home>/tmp/engine-spawn` and reaps it by age, so nothing durable for the
 * length of a run may live there. Only that subtree is refused: a temp root
 * elsewhere under a Station root, such as `STATION_ROOT=/tmp/station` with
 * the default `TMPDIR`, stays where it was.
 */
function stationHomeTmpContaining(
  candidate: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const target = realpathSync.native(candidate);
  for (const owner of [resolveStationRoot(env), env.STATION_HOME?.trim()]) {
    if (!owner) continue;
    let ownedTmp: string;
    try {
      ownedTmp = realpathSync.native(join(resolve(owner), 'tmp'));
    } catch {
      continue; // No such tree, so the candidate cannot be inside it.
    }
    const relation = relative(ownedTmp, target);
    if (
      relation === '' ||
      (relation !== '..' &&
        !relation.startsWith(
          `..${process.platform === 'win32' ? '\\' : '/'}`,
        ) &&
        !isAbsolute(relation))
    ) {
      return ownedTmp;
    }
  }
  return undefined;
}

function mintAdmittedTemporaryHome(
  env: NodeJS.ProcessEnv,
  root?: string,
): string {
  const candidate = realpathSync(createStationTempDirSync('dev-home', root));
  try {
    const ownedTmp = stationHomeTmpContaining(candidate, env);
    if (ownedTmp) {
      throw new StationRuntimeHomeAdmissionError(
        candidate,
        `a temporary home must not live in the Station-reaped tree ${ownedTmp}`,
      );
    }
    return normalizeHomePath(candidate, env);
  } catch (error) {
    rmSync(candidate, { recursive: true, force: true });
    throw error;
  }
}

/**
 * A `--temp-home` lives under the Station temp root, which follows the ambient
 * `TMPDIR`. Station points every agent it spawns at `<home>/tmp/engine-spawn`
 * (see `engine-spawn-tmpdir.ts`), so an agent running
 * `./station start --temp-home` would mint its home inside its parent's
 * Station tree. Under `instances/` the runtime-home guard refuses it; under a
 * self-rooted parent home (`--home`, `--temp-home`) the guard admits it, and
 * the parent's engine-spawn reaper then deletes it by age while it may still
 * be in use. So a candidate inside that home's `tmp/` tree is refused here
 * too, and any refused candidate is retried once under the system `/tmp`.
 * Windows agents do not get this redirect (`os.tmpdir()` reads TEMP/TMP
 * there), so the original refusal stands.
 */
function createTemporaryRuntimeHome(env: NodeJS.ProcessEnv): string {
  try {
    return mintAdmittedTemporaryHome(env);
  } catch (error) {
    if (
      !(error instanceof StationRuntimeHomeAdmissionError) ||
      process.platform === 'win32'
    ) {
      throw error;
    }
    try {
      return mintAdmittedTemporaryHome(env, SYSTEM_TEMP_HOME_ROOT);
    } catch (retryError) {
      throw new StationRuntimeHomeAdmissionError(
        error.homeDir,
        `${error.detail}; retrying under ${SYSTEM_TEMP_HOME_ROOT} was also refused: ${
          retryError instanceof Error ? retryError.message : String(retryError)
        }`,
      );
    }
  }
}

export function resolveLifecycleHomeTarget(
  options: LifecycleHomeOptions = {},
): LifecycleHomeTarget {
  const env = options.env ?? process.env;

  if (options.tempHome) {
    const projectHome = createTemporaryRuntimeHome(env);
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

  // #2675: a prebuilt archive is one version directory of a channel, and an
  // upgrade runs the next version from a different directory. Hashing its
  // path would give every version its own id for the same home and ports, so
  // the new version could not address the instance the old one started. Its
  // identity is the channel instead; a source checkout keeps its path, which
  // is what keeps two checkouts' instances apart.
  const cwd = options.cwd || CWD;
  const codeRoot =
    cwd === CWD ? LIFECYCLE_CODE_ROOT : resolveLifecycleCodeRoot(cwd);
  const hash = createHash('sha1')
    .update(
      JSON.stringify(
        codeRoot.kind === 'prebuilt-archive'
          ? {
              prebuiltArchiveChannel: codeRoot.release.channel,
              projectHome,
              serverPort,
              uiPort,
            }
          : { cwd: codeRoot.root, projectHome, serverPort, uiPort },
      ),
    )
    .digest('hex')
    .slice(0, 12);

  return `instance-${hash}`;
}

/**
 * station#2689: this source checkout's development instance id, or undefined
 * outside the development channel. The launcher (scripts/source-bootstrap.ts)
 * derives it from the checkout path and exports it as STATION_INSTANCE_ID; the
 * implicit development home is `<STATION_ROOT>/instances/dev/<this id>`.
 */
export function sourceCheckoutDevInstanceId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (runtimeChannelFromEnvironment(env) !== 'dev') return undefined;
  const id = env.STATION_INSTANCE_ID?.trim();
  return id ? normalizeInstanceName(id) : undefined;
}

/**
 * The instance id a SERVICE command acts on. Identical to
 * `resolveLifecycleInstanceId` except in one case: no explicit `--instance`
 * and an implicit home on the development channel. That home is the
 * checkout's development instance home, so the service takes that instance's
 * name rather than `default` (or a port-derived `instance-<hash>`), and the
 * machine-wide unit name agrees with the home it runs. Every service action
 * resolves through here, so install, status, start, stop and uninstall keep
 * addressing the same service.
 */
export function resolveServiceInstanceId(
  options: LifecycleInstanceIdentityOptions & {
    homeSource: LifecycleHomeSource;
    env?: NodeJS.ProcessEnv;
  },
): string {
  if (!options.instanceName?.trim() && options.homeSource === 'default') {
    const devInstanceId = sourceCheckoutDevInstanceId(options.env);
    if (devInstanceId) return devInstanceId;
  }
  return resolveLifecycleInstanceId(options);
}

/**
 * Where this CLI keeps lifecycle state for instances of `projectHome` — the
 * home the command resolved from its flags and environment. Every lifecycle
 * reader and writer goes through here (#2675). A source checkout ignores the
 * home; a prebuilt archive keeps state in the root that home's path belongs
 * to, and
 * without a home it takes the one a bare command targets (`STATION_HOME` or
 * the channel default), resolved only then.
 */
export function resolveLifecycleState(
  projectHome?: string,
  env: NodeJS.ProcessEnv = process.env,
): LifecycleStateLocation {
  return resolveLifecycleStateLocation(
    LIFECYCLE_CODE_ROOT,
    LIFECYCLE_CODE_ROOT.kind === 'source'
      ? CWD
      : (projectHome ?? resolveLifecycleHomeTarget({ env }).projectHome),
  );
}

export function getInstanceStatePath(
  instanceId: string,
  projectHome?: string,
): string {
  return join(
    resolveLifecycleState(projectHome).instanceStateDir,
    `${instanceId}.json`,
  );
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
