/**
 * Every top-level entry of a Station home, classified by what an update
 * rollback does with it (#2675 slice D).
 *
 * A supervised update stops the running version, snapshots the home, and
 * starts the new version as a trial. When the trial fails, the home is put
 * back exactly as the old version left it, except for the entries the
 * installed service and the process registry own while no Station runs:
 *
 * - `state`: product data. Backed up before the trial; on rollback, removed
 *   and restored from the backup, so nothing the trial wrote survives.
 *   `.station-home-schema.json` is state on purpose: a trial that migrates
 *   the home bumps it, and an old version refuses a newer schema, so a
 *   rollback that kept the trial's marker would leave the old version unable
 *   to boot.
 * - `live`: owned by the service and process lifecycle, not by a Station
 *   version. Never backed up and never touched by a rollback: the service
 *   manifests and the liveness entry the update window re-points to the
 *   launcher (instances.json) must stay exactly as they are, and logs are the
 *   record of what the failed trial did.
 * - `external`: content kept in the home that an update does not snapshot
 *   or roll back: the default project directories under `workspaces/`
 *   (users' repositories, with their `node_modules` and its symbolic links),
 *   left in place exactly as the trial left it. Copying it made every update
 *   backup as large as the user's code (#2675 D review).
 *   Accepted gap, stated plainly: `workspaces/` is NOT free of
 *   Station-versioned data. Station writes `<project>/.station/` stores into
 *   each project (diff comments, trust bundles, review-evidence receipts,
 *   survey-review sessions, flow-review evidence), and a trial can change
 *   their format; a rollback does not restore them. Projects in directories
 *   the user chose outside the home were never rolled back either, so the
 *   default location is treated the same. Nested external paths
 *   (`STATION_HOME_EXTERNAL_PATHS`) extend this below a `state` root.
 *
 * An entry this registry does not name is treated as `state` (backed up and
 * restored), the data-safe default; the completeness test in
 * `__tests__/station-home-store-registry.test.ts` fails CI when Station's own
 * source names a home root that is missing here.
 *
 * The same `live` set is what `station home backup` leaves out, so the two
 * backups cannot disagree about what is product data.
 */
export type StationHomeRootClass = 'state' | 'live' | 'external';

export const STATION_HOME_ROOTS: Readonly<
  Record<string, StationHomeRootClass>
> = Object.freeze({
  '.station-home-schema.json': 'state',
  // The installer's claim on this data root (install.sh writes it before
  // any Station runs). Restored byte for byte, like any state.
  '.station-portable-data-root': 'state',
  '.review-evidence-coordination': 'state',
  '.storage-transactions': 'state',
  'action-operations.json': 'state',
  'agent-plugin-data': 'state',
  agents: 'state',
  analytics: 'state',
  'app-homes': 'state',
  authentication: 'state',
  automation: 'state',
  browser: 'state',
  'checkpoint-restores.json': 'state',
  'checkpoint-retention.json': 'state',
  config: 'state',
  'connection-smoke.json': 'state',
  'conversation-acknowledgements.json': 'state',
  'conversation-intent-summaries': 'state',
  'conversation-pull-request-links.json': 'state',
  coordination: 'state',
  data: 'state',
  'delegation-attempt-claims.json': 'state',
  devices: 'state',
  environments: 'state',
  feedback: 'state',
  imports: 'state',
  integrations: 'state',
  kits: 'state',
  knowledge: 'state',
  'knowledge-index': 'state',
  'knowledge-stores': 'state',
  layouts: 'state',
  'mcp-ui-render-grants.json': 'state',
  'notifications.json': 'state',
  'plugin-grants.json': 'state',
  'plugin-install-publication.mutation': 'state',
  plugins: 'state',
  pricing: 'state',
  'project-resource-shadow.json': 'state',
  projects: 'state',
  prompts: 'state',
  'proposed-changes.json': 'state',
  runtime: 'state',
  'runtime-auth-health.json': 'state',
  scheduler: 'state',
  security: 'state',
  'session-summaries': 'state',
  'setup-imports.json': 'state',
  skills: 'state',
  'station-home-recovery.json': 'state',
  'task-graph.json': 'state',
  'task-outputs': 'state',
  'terminal-history': 'state',
  'turn-checkpoints': 'state',
  'turn-checkpoints-evicted': 'state',
  vectordb: 'state',
  workflows: 'state',
  'workspace-home-role.json': 'state',

  // Default project directories: users' repositories (project-service.ts).
  workspaces: 'external',

  'instances.json': 'live',
  logs: 'live',
  monitoring: 'live',
  // station#3217: a store quarantined for corruption is kept for recovery,
  // not carried into every backup.
  quarantine: 'live',
  service: 'live',
  tmp: 'live',
});

/**
 * A durable-JSON sidecar (`<file>.previous`, `<file>.mutation`) belongs with
 * the file it protects.
 */
const SIDECAR_SUFFIXES = ['.previous', '.mutation'] as const;

/** The class of a top-level home entry, or undefined when none is recorded. */
export function classifyStationHomeRoot(
  name: string,
): StationHomeRootClass | undefined {
  const direct = STATION_HOME_ROOTS[name];
  if (direct) return direct;
  for (const suffix of SIDECAR_SUFFIXES) {
    if (name.endsWith(suffix)) {
      const owner = STATION_HOME_ROOTS[name.slice(0, -suffix.length)];
      if (owner) return owner;
    }
  }
  return undefined;
}

/** Top-level entries a backup leaves out and a rollback leaves alone. */
export function isLiveStationHomeRoot(name: string): boolean {
  return classifyStationHomeRoot(name) === 'live';
}

/**
 * Every path, in segments, that an update neither snapshots nor rolls back
 * (the `external` class). Beyond the external top-level roots, parts of a
 * `state` root whose bytes belong to another program:
 *
 * - `browser/chromium`: the Chromium build Station downloads
 *   (chromium-acquisition.ts), a large cache any version can fetch again.
 * - `browser/profiles`: Chromium's own profile directories
 *   (browser-session-registry.ts), in Chromium's format, which hold its
 *   `Singleton*` symbolic links and can grow to gigabytes.
 *
 * The rest of `browser/` (sessions.json, local-targets.json,
 * project-settings.json) is Station's and stays `state`.
 */
export const STATION_HOME_EXTERNAL_PATHS: readonly (readonly string[])[] =
  Object.freeze([
    ...Object.entries(STATION_HOME_ROOTS)
      .filter(([, value]) => value === 'external')
      .map(([name]) => Object.freeze([name])),
    Object.freeze(['browser', 'chromium']),
    Object.freeze(['browser', 'profiles']),
  ]);

function startsWith(
  segments: readonly string[],
  prefix: readonly string[],
): boolean {
  return (
    prefix.length <= segments.length &&
    prefix.every((segment, index) => segments[index] === segment)
  );
}

/** Whether a home path is, or is inside, an `external` path. */
export function isExternalStationHomePath(
  segments: readonly string[],
): boolean {
  return STATION_HOME_EXTERNAL_PATHS.some((external) =>
    startsWith(segments, external),
  );
}

/** Whether a home directory holds an `external` path somewhere below it. */
export function containsExternalStationHomePath(
  segments: readonly string[],
): boolean {
  return STATION_HOME_EXTERNAL_PATHS.some(
    (external) =>
      external.length > segments.length && startsWith(external, segments),
  );
}

/**
 * The SQLite databases Station keeps under a home, in path segments. A
 * backup must checkpoint each before copying it, because a WAL-mode store's
 * newest commits live in its `-wal` sidecar, which the backup does not copy
 * (see `isSqliteStoreEntry` in station-home-archive.ts). Every one lives
 * under a `state` root (asserted by the registry test).
 */
export const STATION_HOME_SQLITE_STORES: readonly (readonly string[])[] =
  Object.freeze([
    ['data', 'orchestration.sqlite'],
    ['scheduler', 'scheduler.sqlite'],
    ['automation', 'automation.sqlite'],
    ['authentication', 'application-sessions.sqlite'],
    ['authentication', 'local-accounts.sqlite'],
    ['authentication', 'local-account-authority.sqlite'],
    ['authentication', 'relay-enrollment.sqlite'],
    ['authentication', 'native-relay-enrollment.sqlite'],
    // #3257: operator passkey public keys. Created at the first enrollment.
    ['authentication', 'operator-passkeys.sqlite'],
    ['security', 'project-membership.sqlite'],
    ['security', 'native-surfaces.sqlite'],
    ['security', 'native-device-proof-replay.sqlite'],
    // sqlite-vec knowledge index; a `.db`, not a `.sqlite`.
    ['knowledge-index', 'index.db'],
  ]);
