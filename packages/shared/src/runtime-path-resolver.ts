import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { STATION_CHANNEL_PORTS_DATA } from './channel-ports.generated.js';

export interface ResolvedStationRuntimeContext {
  readonly channel: StationRuntimeChannel;
  readonly stationRoot: string;
  readonly home: string;
  readonly serverPort: number;
  readonly uiPort: number;
  readonly consentPort: number;
}

/**
 * The one app-owned Station root. It contains shared client configuration and
 * channel/worktree runtime instances. An explicit root wins; otherwise an
 * explicit runtime home derives a containing root so root-scoped writes can
 * never escape to the ambient user's ~/.station.
 */
export function resolveStationRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitRoot = env.STATION_ROOT?.trim();
  if (explicitRoot) return resolve(explicitRoot);
  const explicitHome = env.STATION_HOME?.trim();
  if (!explicitHome) return resolve(join(homedir(), '.station'));

  const home = resolve(explicitHome);
  const parent = dirname(home);
  if (basename(parent) === 'instances') return dirname(parent);
  if (basename(parent) === 'dev' && basename(dirname(parent)) === 'instances') {
    return dirname(dirname(parent));
  }
  return home;
}

/**
 * The `STATION_ROOT` a spawned Station runtime must carry for `home`, or
 * `undefined` when it must be left UNSET.
 *
 * `undefined` is the self-rooted case -- `--home`, `--base`, `--temp-home`, or
 * an external `STATION_HOME` naming a raw directory -- where
 * `resolveStationRoot` roots the home at itself. Writing that value into the
 * child's environment is not redundant, it is fatal: `admitStationRuntimeHome`
 * has no way to tell a root DERIVED from this home apart from a foreign root
 * the home would swallow, because provenance is not observable from the
 * environment. It reads the absence of `STATION_ROOT` as that proof, so
 * spelling out `STATION_ROOT === STATION_HOME` is rejected by design and the
 * runtime cannot boot. The child re-derives the identical root from
 * `STATION_HOME` alone -- `resolveStationRoot` reads nothing else -- so
 * omitting it loses no information.
 *
 * An operator-set `STATION_ROOT` is always passed through unchanged, including
 * when it equals the home: that is the original escape, and it stays rejected.
 */
export function spawnedStationRoot(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const root = resolveStationRoot({ ...env, STATION_HOME: home });
  if (env.STATION_ROOT?.trim()) return root;
  return sameRuntimePath(root, home) ? undefined : root;
}

export class StationRuntimeHomeAdmissionError extends Error {
  readonly code = 'STATION_RUNTIME_HOME_REJECTED';

  constructor(
    readonly homeDir: string,
    readonly detail: string,
  ) {
    super(`Station runtime home '${homeDir}' is not admissible: ${detail}`);
    this.name = 'StationRuntimeHomeAdmissionError';
  }
}

function canonicalPathThroughExistingAncestor(requestedPath: string): string {
  const requested = resolve(requestedPath);
  const suffix: string[] = [];
  let cursor = requested;
  for (;;) {
    try {
      const info = lstatSync(cursor);
      if (!info.isDirectory() && !info.isSymbolicLink()) {
        throw new StationRuntimeHomeAdmissionError(
          requested,
          'an existing path component is not a directory',
        );
      }
      let existing: string;
      try {
        existing = realpathSync(cursor);
      } catch (error) {
        if (info.isSymbolicLink()) {
          throw new StationRuntimeHomeAdmissionError(
            requested,
            'an existing path component is a dangling symlink',
          );
        }
        throw error;
      }
      if (!lstatSync(existing).isDirectory()) {
        throw new StationRuntimeHomeAdmissionError(
          requested,
          'an existing path component resolves to a non-directory',
        );
      }
      return suffix.reduceRight(
        (path, segment) => join(path, segment),
        existing,
      );
    } catch (error) {
      if (error instanceof StationRuntimeHomeAdmissionError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new StationRuntimeHomeAdmissionError(
          requested,
          `its existing ancestor could not be inspected (${code ?? 'unknown error'})`,
        );
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new StationRuntimeHomeAdmissionError(
        requested,
        'no existing ancestor can establish its canonical location',
      );
    }
    suffix.push(basename(cursor));
    cursor = parent;
  }
}

function equalOrDescendant(path: string, parent: string): boolean {
  // Station's macOS support runs on the usual case-insensitive APFS volume;
  // be conservative for a missing suffix rather than allowing `CONFIG` to
  // become a second spelling of the root-owned `config` container.
  const caseInsensitive =
    process.platform === 'win32' || process.platform === 'darwin';
  const candidate = caseInsensitive ? path.toLowerCase() : path;
  const container = caseInsensitive ? parent.toLowerCase() : parent;
  const relation = relative(container, candidate);
  return (
    relation === '' ||
    (!relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      relation !== '..' &&
      !isAbsolute(relation))
  );
}

function sameRuntimePath(left: string, right: string): boolean {
  return equalOrDescendant(left, right) && equalOrDescendant(right, left);
}

/**
 * Admit only a runtime leaf, never the shared Station control root or one of
 * its containers.  The comparison follows every existing ancestor first, so
 * a lexical alias cannot turn `config/` (or an ancestor of the root) into a
 * destructive runtime target.  Missing paths remain valid only when their
 * existing ancestor can be inspected; permission failures are never treated
 * as a fresh home.
 */
export function admitStationRuntimeHome(
  requestedHome: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const lexicalHome = resolve(requestedHome);
  try {
    if (lstatSync(lexicalHome).isSymbolicLink()) {
      throw new StationRuntimeHomeAdmissionError(
        lexicalHome,
        'the selected runtime home is a symlink',
      );
    }
  } catch (error) {
    if (error instanceof StationRuntimeHomeAdmissionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new StationRuntimeHomeAdmissionError(
        lexicalHome,
        `the selected path could not be inspected (${code ?? 'unknown error'})`,
      );
    }
  }
  const home = canonicalPathThroughExistingAncestor(requestedHome);
  const lexicalRoot = resolveStationRoot(env);
  const root = canonicalPathThroughExistingAncestor(lexicalRoot);
  for (const container of [
    'config',
    'cache',
    'installs',
    'instances',
    join('instances', 'dev'),
  ]) {
    const path = join(root, container);
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new StationRuntimeHomeAdmissionError(
          home,
          `shared Station container is unsafe: ${container}`,
        );
      }
    } catch (error) {
      if (error instanceof StationRuntimeHomeAdmissionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StationRuntimeHomeAdmissionError(
          home,
          `shared Station container could not be inspected: ${container}`,
        );
      }
    }
  }

  // `root === home` is legitimate ONLY when the root was derived from this
  // home — i.e. `STATION_HOME` was given with no explicit `STATION_ROOT`, so
  // `resolveStationRoot` self-roots it and every root-scoped write lands
  // inside the directory the operator named. That is what makes `--home`,
  // `--base`, `--temp-home` and an external `STATION_HOME` work.
  //
  // With an explicit `STATION_ROOT`, a home equal to it is the original
  // escape: the home swallows a root it does not own. Keep rejecting that.
  // `sameRuntimePath(root, home)` alone is NOT enough to establish that the
  // root was derived from this home. With no `STATION_ROOT` and no
  // `STATION_HOME`, the root is the ambient `~/.station` default, so passing
  // that directory as the home (`--home=$HOME/.station`, or a script that
  // computes it) satisfied the equality and was admitted — the shared root
  // accepted as a runtime home, which is the exact escape this guard exists
  // to stop. The derivation only happened if `STATION_HOME` was actually set
  // and names this same directory.
  const explicitHome = env.STATION_HOME?.trim();
  const rootWasDerivedFromHome =
    !env.STATION_ROOT?.trim() &&
    !!explicitHome &&
    sameRuntimePath(root, home) &&
    sameRuntimePath(canonicalPathThroughExistingAncestor(explicitHome), home);
  if (equalOrDescendant(root, home) && !rootWasDerivedFromHome) {
    throw new StationRuntimeHomeAdmissionError(
      home,
      'it is the shared Station root or an ancestor of that root',
    );
  }
  for (const protectedName of ['config', 'cache', 'installs']) {
    const canonicalProtected = canonicalPathThroughExistingAncestor(
      join(lexicalRoot, protectedName),
    );
    if (
      equalOrDescendant(home, canonicalProtected) ||
      equalOrDescendant(lexicalHome, join(lexicalRoot, protectedName))
    ) {
      throw new StationRuntimeHomeAdmissionError(
        home,
        `it is inside the shared Station ${protectedName} subtree`,
      );
    }
  }

  const instances = join(root, 'instances');
  if (sameRuntimePath(home, instances)) {
    throw new StationRuntimeHomeAdmissionError(
      home,
      'it is the shared Station instances container',
    );
  }
  const devInstances = join(instances, 'dev');
  if (sameRuntimePath(home, devInstances)) {
    throw new StationRuntimeHomeAdmissionError(
      home,
      'it is the shared Station development-instances container',
    );
  }

  if (equalOrDescendant(home, instances)) {
    const exactRelation = relative(instances, home);
    if (
      exactRelation === '..' ||
      exactRelation.startsWith(
        `..${process.platform === 'win32' ? '\\' : '/'}`,
      ) ||
      isAbsolute(exactRelation)
    ) {
      throw new StationRuntimeHomeAdmissionError(
        home,
        'it uses a reserved instances alias',
      );
    }
    const parts = exactRelation.split(/[\\/]/).filter(Boolean);
    const safeInstanceLeaf =
      parts.length === 1 && /^[a-z0-9][a-z0-9._-]*$/i.test(parts[0]);
    const safeDevLeaf =
      parts.length === 2 &&
      parts[0] === 'dev' &&
      /^[a-z0-9][a-z0-9._-]*$/i.test(parts[1]);
    if (!safeInstanceLeaf && !safeDevLeaf) {
      throw new StationRuntimeHomeAdmissionError(
        home,
        'it is not a concrete Station runtime instance leaf',
      );
    }
  }
  return home;
}

export function stationProfilesPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveStationRoot(env), 'config', 'profiles.json');
}

export type StationRuntimeChannel = 'stable' | 'beta' | 'nightly' | 'dev';

export function runtimeChannelFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): StationRuntimeChannel {
  switch (env.STATION_CHANNEL?.trim()) {
    case 'beta':
      return 'beta';
    case 'nightly':
      return 'nightly';
    case 'development':
    case 'dev':
      return 'dev';
    case 'stable':
    case undefined:
    case '':
      return 'stable';
    default:
      throw new Error(
        `Unsupported Station runtime channel: ${env.STATION_CHANNEL}`,
      );
  }
}

export function runtimeInstancePath(
  channel: StationRuntimeChannel,
  options: { env?: NodeJS.ProcessEnv; instanceId?: string } = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env.STATION_HOME?.trim();
  if (explicit) return resolve(explicit);
  const root = resolveStationRoot(env);
  const generatedChannel = channel === 'dev' ? 'development' : channel;
  const instanceDirectory =
    STATION_CHANNEL_PORTS_DATA[generatedChannel].instanceDirectory;
  if (channel === 'dev') {
    const instanceId = options.instanceId?.trim();
    if (!instanceId || !/^[a-z0-9][a-z0-9._-]*$/i.test(instanceId)) {
      throw new Error(
        'A development Station runtime requires a safe full-path-derived instance id.',
      );
    }
    return join(root, 'instances', instanceDirectory, instanceId);
  }
  return join(root, 'instances', instanceDirectory);
}

function explicitPort(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `Station port must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`,
    );
  }
  return port;
}

/**
 * The process-wide runtime facts.  A packaged or standalone process has no
 * source bootstrap, so this intentionally defaults to the stable channel and
 * its API port (18141).  Source launchers establish their development facts
 * in the environment before importing consumers of this resolver.
 */
export function resolveStationRuntimeContext(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedStationRuntimeContext {
  const channel = runtimeChannelFromEnvironment(env);
  const generatedChannel = channel === 'dev' ? 'development' : channel;
  const defaults = STATION_CHANNEL_PORTS_DATA[generatedChannel];
  const serverPort =
    explicitPort(env.STATION_SERVER_PORT ?? env.STATION_PORT) ??
    defaults.serverPort;
  const uiPort = explicitPort(env.STATION_UI_PORT) ?? defaults.uiPort;
  const consentPort = explicitPort(env.STATION_CONSENT_PORT) ?? serverPort + 3;
  const stationRoot = resolveStationRoot(env);
  const home = runtimeInstancePath(channel, {
    env,
    // Source bootstrap writes the canonical derived identity here.  Never
    // re-hash the raw STATION_DEV_INSTANCE seed in a shared consumer.
    instanceId: channel === 'dev' ? env.STATION_INSTANCE_ID : undefined,
  });
  return { channel, stationRoot, home, serverPort, uiPort, consentPort };
}

/** Resolve a runtime home without ever falling back to the client root. */
export function resolveRuntimeHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveStationRuntimeContext(env).home;
}

/** Resolve and admit a home at an actual runtime I/O boundary. */
export function resolveAdmittedRuntimeHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = resolveRuntimeHome(env);
  admitStationRuntimeHome(home, env);
  // Admission compares canonical paths, but callers retain their configured
  // spelling. That keeps ordinary `/tmp` and caller-visible paths stable while
  // still refusing aliases that resolve into shared Station control state.
  return home;
}

export function stationCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStationRoot(env), 'cache');
}

export function stationInstallPath(
  channel: Exclude<StationRuntimeChannel, 'dev'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveStationRoot(env), 'installs', channel);
}
