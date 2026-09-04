/**
 * An observation-only recovery inventory. Never a migration admission token.
 * Known credential payloads, SQLite, plugin code and historical content are
 * deliberately not opened. No bootstrap, lease, process launch or writer lives
 * here. Pathname checks detect observed changes, not an atomic filesystem view.
 */
import { lstatSync, opendirSync, type Stats } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { CLEAN_ID_PATTERN } from '@kontourai/station-contracts/agent-identity';
import {
  canonicalStationHome,
  readRegularFileNoFollow,
  STATION_HOME_SCHEMA_FILE,
  STATION_HOME_SCHEMA_VERSION,
} from './station-home-schema.js';

export const STATION_HOME_RECOVERY_CATALOG = {
  schema: { disposition: 'schema-observation', fields: ['version'] },
  app: {
    disposition: 'identity-review',
    fields: ['agentConnections (keys only)', 'builtinAgentEngineConnectionId'],
  },
  registry: {
    disposition: 'identity-review',
    fields: [
      'version',
      'revision',
      'engineConnections',
      'defaultAgents',
      'declinedEngineConnections',
    ],
  },
  agents: {
    disposition: 'identity-review',
    fields: ['execution.agentConnectionId', 'execution.credentialProfileRef'],
  },
  history: { disposition: 'history-not-resume-authority', fields: [] },
  projects: { disposition: 'bindings-require-review', fields: [] },
  grants: { disposition: 'consent-requires-revalidation', fields: [] },
  credentials: { disposition: 'opaque-account-storage', fields: [] },
  scheduler: { disposition: 'do-not-reactivate-jobs', fields: [] },
  runtime: {
    disposition: 'not-portable-ownership',
    fields: ['instances.pid (existence only)'],
  },
  evidence: { disposition: 'retain-original-evidence', fields: [] },
  plugins: { disposition: 'do-not-load-code', fields: [] },
  unknown: { disposition: 'unclassified', fields: [] },
} as const;

type Store = keyof typeof STATION_HOME_RECOVERY_CATALOG;
type Code =
  | 'missing-home'
  | 'unsafe-path'
  | 'unavailable'
  | 'changed-during-inspection'
  | 'limit-exceeded'
  | 'invalid-json'
  | 'invalid-shape'
  | 'missing-schema'
  | 'unsupported-schema'
  | 'store-schema-conflict'
  | 'missing-registry'
  | 'identity-conflict'
  | 'unresolved-binding'
  | 'owner-mapping-required'
  | 'payload-not-inspected'
  | 'unknown-store'
  | 'additional-fields-not-inspected';

export interface StationHomeRecoveryPlan {
  schema: 'station.home-recovery-plan/v1';
  sourceSchemaVersion: number | null;
  targetSchemaVersion: number;
  inspection: 'observed' | 'partial' | 'refused';
  /** False even for a complete observation of the supported fields. */
  applyAllowed: false;
  migration: 'not-implemented';
  snapshot: 'non-atomic-observation';
  codes: Code[];
  stores: Array<{
    store: Store;
    disposition: string;
    entries: number;
    inspectedRecords: number;
  }>;
  identities: {
    builtinSelection:
      | 'not-inspected'
      | 'not-recorded'
      | 'explicit-station'
      | 'explicit-engine';
    connections: number;
    exactReferences: number;
    unresolvedReferences: number;
    differingRuntimeSelectors: number;
    agentCredentialReferences: number;
  };
  owners: {
    recordedInstances: number;
    pidPresent: number;
    pidAbsent: number;
    unknown: number;
    /** PID existence is not PID-birth identity, nor legacy service exclusion. */
    exclusion: 'not-proven';
    modernLeases: 'not-inspected';
    legacyProfiles: 'not-inspected';
  };
  requiredDecisions: readonly string[];
}

export interface StationHomeRecoveryOptions {
  homeDir: string;
  /** Bounds may only be lowered from the production ceiling. */
  limits?: {
    entries?: number;
    fileBytes?: number;
    totalReadBytes?: number;
    depth?: number;
  };
  /** Private deterministic race seam. Not reachable from CLI arguments. */
  hooks?: {
    beforeRead?: (relativePath: string) => void;
    afterInventory?: () => void;
  };
}

const CEILINGS = {
  entries: 4096,
  fileBytes: 256 * 1024,
  totalReadBytes: 4 * 1024 * 1024,
  depth: 6,
};
class Refusal extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
function fail(code: Code): never {
  throw new Refusal(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function clean(value: unknown): value is string {
  return typeof value === 'string' && CLEAN_ID_PATTERN.test(value);
}
function same(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** No raw names, ids, paths, errors, transcript text or credential values escape. */
export function inspectStationHomeRecovery(
  options: StationHomeRecoveryOptions,
): StationHomeRecoveryPlan {
  const plan: StationHomeRecoveryPlan = {
    schema: 'station.home-recovery-plan/v1',
    sourceSchemaVersion: null,
    targetSchemaVersion: STATION_HOME_SCHEMA_VERSION,
    inspection: 'observed',
    applyAllowed: false,
    migration: 'not-implemented',
    snapshot: 'non-atomic-observation',
    codes: [],
    stores: (Object.keys(STATION_HOME_RECOVERY_CATALOG) as Store[]).map(
      (store) => ({
        store,
        disposition: STATION_HOME_RECOVERY_CATALOG[store].disposition,
        entries: 0,
        inspectedRecords: 0,
      }),
    ),
    identities: {
      builtinSelection: 'not-inspected',
      connections: 0,
      exactReferences: 0,
      unresolvedReferences: 0,
      differingRuntimeSelectors: 0,
      agentCredentialReferences: 0,
    },
    owners: {
      recordedInstances: 0,
      pidPresent: 0,
      pidAbsent: 0,
      unknown: 0,
      exclusion: 'not-proven',
      modernLeases: 'not-inspected',
      legacyProfiles: 'not-inspected',
    },
    requiredDecisions: [
      'Confirm exact Engine, Agent and account mappings; never infer aliases.',
      'Keep history separate from session resume and scheduled execution authority.',
      'Revalidate exact principal and content bindings before carrying consent.',
      'Retain original evidence; approve a separately reviewed backup and recovery transaction.',
      'Prove modern and legacy owner exclusion again before any future mutation.',
    ],
  };
  const codes = new Set<Code>();
  const refs: string[] = [];
  const connections = new Set<string>();
  const runtimeTargets = new Map<string, string>();
  let sawRegistry = false;
  let registryVersion: number | undefined;
  const add = (code: Code) => {
    codes.add(code);
  };
  const storeRow = (store: Store) =>
    plan.stores.find((row) => row.store === store)!;
  try {
    const limits = { ...CEILINGS, ...options.limits };
    for (const key of Object.keys(CEILINGS) as (keyof typeof CEILINGS)[]) {
      if (
        !Number.isSafeInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > CEILINGS[key]
      )
        fail('limit-exceeded');
    }
    if (
      typeof options.homeDir !== 'string' ||
      !options.homeDir.trim() ||
      options.homeDir.length > 4096
    )
      fail('unsafe-path');
    const requested = resolve(options.homeDir);
    const observed = new Map<string, Stats>();
    // Do not silently follow a supplied symlinked ancestor into another home.
    const ancestors: string[] = [];
    for (let path = requested; path !== parse(path).root; path = dirname(path))
      ancestors.unshift(path);
    for (const path of ancestors) {
      let stats: Stats;
      try {
        stats = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          fail('missing-home');
        fail('unavailable');
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) fail('unsafe-path');
      // Parent directory contents can change independently; pin identity only
      // there. Full content metadata is tracked for the selected home below.
      observed.set(path, stats);
    }
    let home: string;
    try {
      home = canonicalStationHome(requested);
    } catch {
      fail('unsafe-path');
    }
    if (home !== requested) fail('unsafe-path');
    const check = (leaf?: string) => {
      const paths: string[] = [];
      if (leaf) {
        for (let path = leaf; path !== parse(path).root; path = dirname(path))
          paths.push(path);
      } else paths.push(...observed.keys());
      for (const path of paths) {
        const baseline = observed.get(path);
        if (!baseline) fail('changed-during-inspection');
        let current: Stats;
        try {
          current = lstatSync(path);
        } catch {
          fail('changed-during-inspection');
        }
        const inHome =
          path === home ||
          path.startsWith(`${home}/`) ||
          path.startsWith(`${home}\\`);
        if (
          current.isSymbolicLink() ||
          (inHome
            ? !same(baseline, current)
            : baseline.dev !== current.dev ||
              baseline.ino !== current.ino ||
              !current.isDirectory())
        )
          fail('changed-during-inspection');
      }
    };
    let entries = 0;
    let bytes = 0;
    const read = (path: string, segments: string[]): unknown => {
      check(path);
      const stats = observed.get(path)!;
      const remaining = Math.min(
        limits.fileBytes,
        limits.totalReadBytes - bytes,
      );
      if (stats.size > remaining) fail('limit-exceeded');
      let raw: string;
      try {
        raw = readRegularFileNoFollow(home, path, {
          maxBytes: remaining,
          beforeOpen: () => {
            options.hooks?.beforeRead?.(segments.join('/'));
            check(path);
          },
        });
      } catch (error) {
        if (error instanceof Refusal) throw error;
        check(path);
        fail('unavailable');
      }
      bytes += Buffer.byteLength(raw);
      check(path);
      try {
        return JSON.parse(raw);
      } catch {
        fail('invalid-json');
      }
    };
    const shape = (condition: unknown) => {
      if (!condition) fail('invalid-shape');
    };
    const inspect = (store: Store, value: unknown) => {
      shape(record(value));
      const data = value as Record<string, unknown>;
      if (store === 'schema') {
        shape(
          Object.keys(data).length === 1 &&
            Number.isSafeInteger(data.version) &&
            (data.version as number) >= 0,
        );
        plan.sourceSchemaVersion = data.version as number;
        if (data.version !== 1 && data.version !== STATION_HOME_SCHEMA_VERSION)
          add('unsupported-schema');
      } else if (store === 'app') {
        plan.identities.builtinSelection = 'not-recorded';
        if ('builtinAgentEngineConnectionId' in data) {
          shape(
            data.builtinAgentEngineConnectionId === null ||
              clean(data.builtinAgentEngineConnectionId),
          );
          plan.identities.builtinSelection =
            data.builtinAgentEngineConnectionId === null
              ? 'explicit-station'
              : 'explicit-engine';
          if (typeof data.builtinAgentEngineConnectionId === 'string')
            refs.push(data.builtinAgentEngineConnectionId);
        }
        if ('agentConnections' in data) {
          shape(record(data.agentConnections));
          for (const [id, settings] of Object.entries(
            data.agentConnections as Record<string, unknown>,
          )) {
            shape(clean(id) && record(settings));
            refs.push(id);
          }
        }
        // Other app settings and opaque connection configs are not validated.
        add('additional-fields-not-inspected');
      } else if (store === 'registry') {
        sawRegistry = true;
        shape(
          (data.version === 1 || data.version === 2) &&
            Number.isSafeInteger(data.revision) &&
            (data.revision as number) >= 0 &&
            Array.isArray(data.engineConnections) &&
            Array.isArray(data.defaultAgents),
        );
        registryVersion = data.version as number;
        for (const item of data.engineConnections as unknown[]) {
          shape(record(item));
          const connection = item as Record<string, unknown>;
          shape(clean(connection.id) && connection.id !== 'station');
          const id = connection.id as string;
          if (connections.has(id)) add('identity-conflict');
          connections.add(id);
          if ('runtimeConnectionId' in connection) {
            shape(data.version === 1 && clean(connection.runtimeConnectionId));
            const runtime = connection.runtimeConnectionId as string;
            if (
              runtimeTargets.has(runtime) &&
              runtimeTargets.get(runtime) !== id
            )
              add('identity-conflict');
            runtimeTargets.set(runtime, id);
            if (runtime !== id) {
              plan.identities.differingRuntimeSelectors++;
              add('owner-mapping-required');
            }
          }
          if (connection.source !== undefined) {
            shape(record(connection.source));
            const source = connection.source as Record<string, unknown>;
            shape(
              source.kind === 'native' ||
                source.kind === 'user-acp' ||
                (source.kind === 'plugin-acp' &&
                  typeof source.plugin === 'string' &&
                  source.plugin.length > 0),
            );
          }
        }
        const defaults = new Set<string>();
        let stationDefaults = 0;
        for (const item of data.defaultAgents as unknown[]) {
          shape(record(item));
          const agent = item as Record<string, unknown>;
          shape(clean(agent.id));
          if (defaults.has(agent.id as string)) add('identity-conflict');
          defaults.add(agent.id as string);
          if (agent.kind === 'station') {
            shape(agent.id === 'station');
            stationDefaults++;
          } else {
            shape(
              agent.kind === 'engine-connection' &&
                clean(agent.engineConnectionId),
            );
            if (agent.id !== agent.engineConnectionId) add('identity-conflict');
            refs.push(agent.engineConnectionId as string);
          }
        }
        if (stationDefaults !== 1) add('identity-conflict');
        if (data.declinedEngineConnections !== undefined) {
          shape(
            Array.isArray(data.declinedEngineConnections) &&
              data.declinedEngineConnections.every(clean),
          );
          for (const id of data.declinedEngineConnections as string[])
            if (connections.has(id)) add('identity-conflict');
        }
        add('additional-fields-not-inspected');
      } else if (store === 'agents') {
        if (data.execution !== undefined) {
          shape(record(data.execution));
          const execution = data.execution as Record<string, unknown>;
          if ('agentConnectionId' in execution) {
            shape(clean(execution.agentConnectionId));
            refs.push(execution.agentConnectionId as string);
          }
          if (
            execution.credentialProfileRef !== undefined &&
            execution.credentialProfileRef !== null
          ) {
            shape(
              typeof execution.credentialProfileRef === 'string' &&
                execution.credentialProfileRef.length > 0,
            );
            plan.identities.agentCredentialReferences++;
          }
        }
        add('additional-fields-not-inspected');
      } else if (store === 'runtime') {
        shape(data.version === 1 && record(data.instances));
        for (const item of Object.values(
          data.instances as Record<string, unknown>,
        )) {
          shape(record(item));
          const instance = item as Record<string, unknown>;
          shape(
            typeof instance.port === 'number' &&
              Number.isFinite(instance.port) &&
              ['service', 'sidecar', 'worktree', 'inline'].includes(
                instance.type as string,
              ),
          );
          plan.owners.recordedInstances++;
          if (instance.pid === undefined) {
            plan.owners.unknown++;
            continue;
          }
          shape(
            Number.isSafeInteger(instance.pid) && (instance.pid as number) > 0,
          );
          // A zero signal launches nothing and changes no process state. It
          // cannot establish exact birth identity; never label this owner-live.
          try {
            process.kill(instance.pid as number, 0);
            plan.owners.pidPresent++;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH')
              plan.owners.pidAbsent++;
            else plan.owners.unknown++;
          }
        }
      }
    };
    const classify = (s: string[]): Store | 'directory' => {
      const [root, child, leaf] = s;
      if (s.length === 1) {
        if (root === STATION_HOME_SCHEMA_FILE) return 'schema';
        if (root === 'instances.json') return 'runtime';
        if (
          root === 'plugin-grants.json' ||
          root === 'mcp-ui-render-grants.json'
        )
          return 'grants';
        if (
          [
            'config',
            'agents',
            'projects',
            'data',
            'scheduler',
            'security',
          ].includes(root)
        )
          return 'directory';
        if (root === 'app-homes') return 'credentials';
        if (root === 'quarantine') return 'evidence';
        if (root === 'service') return 'runtime';
        if (root === 'plugins') return 'plugins';
      }
      if (root === 'config' && s.length === 2) {
        if (child === 'app.json') return 'app';
        if (child === 'agent-registry.json') return 'registry';
        if (
          ['providers.json', 'hosts.json', 'host-credentials.json'].includes(
            child,
          )
        )
          return 'credentials';
      }
      if (root === 'agents') {
        if (s.length === 2) return 'directory';
        if (s.length === 3 && leaf === 'agent.json') return 'agents';
      }
      if (root === 'projects') {
        if (s.length === 2) return 'directory';
        if (s.length === 3 && leaf === 'conversations.json') return 'history';
        if (
          s.length === 3 &&
          ['project.json', 'layouts', 'documents'].includes(leaf)
        )
          return 'projects';
      }
      if (
        root === 'data' &&
        s.length === 2 &&
        [
          'orchestration.sqlite',
          'orchestration.sqlite-wal',
          'orchestration.sqlite-shm',
          'attachments',
        ].includes(child)
      )
        return 'history';
      if (root === 'scheduler' && s.length === 2) return 'scheduler';
      if (root === 'security' && s.length === 2)
        return child === 'unattended-tool-grants.json'
          ? 'grants'
          : 'credentials';
      return 'unknown';
    };
    const walk = (directory: string, segments: string[]) => {
      check(directory);
      if (segments.length >= limits.depth) fail('limit-exceeded');
      const dir = opendirSync(directory);
      const names: string[] = [];
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++entries > limits.entries) fail('limit-exceeded');
          names.push(entry.name);
        }
      } finally {
        dir.closeSync();
      }
      for (const name of names.sort()) {
        check(directory);
        const path = join(directory, name);
        const parts = [...segments, name];
        const stats = lstatSync(path);
        if (
          stats.isSymbolicLink() ||
          (!stats.isDirectory() && !stats.isFile()) ||
          (stats.isFile() && stats.nlink !== 1)
        )
          fail('unsafe-path');
        observed.set(path, stats);
        const store = classify(parts);
        if (store === 'directory') {
          if (!stats.isDirectory()) fail('invalid-shape');
          walk(path, parts);
          continue;
        }
        const row = storeRow(store);
        row.entries++;
        const readsPayload =
          ['schema', 'app', 'registry', 'agents'].includes(store) ||
          (store === 'runtime' &&
            parts.length === 1 &&
            parts[0] === 'instances.json');
        if (readsPayload) {
          if (!stats.isFile()) fail('invalid-shape');
          inspect(store, read(path, parts));
          row.inspectedRecords++;
        } else {
          add(store === 'unknown' ? 'unknown-store' : 'payload-not-inspected');
        }
      }
    };
    walk(home, []);
    options.hooks?.afterInventory?.();
    check();
    if (plan.sourceSchemaVersion === null) add('missing-schema');
    if (!sawRegistry) add('missing-registry');
    if (
      registryVersion !== undefined &&
      plan.sourceSchemaVersion !== null &&
      registryVersion !== plan.sourceSchemaVersion
    )
      add('store-schema-conflict');
    plan.identities.connections = connections.size;
    for (const ref of refs) {
      if (connections.has(ref)) plan.identities.exactReferences++;
      else {
        plan.identities.unresolvedReferences++;
        add('unresolved-binding');
      }
    }
    for (const [runtime, target] of runtimeTargets)
      if (connections.has(runtime) && runtime !== target)
        add('identity-conflict');
    if (codes.size) plan.inspection = 'partial';
  } catch (error) {
    add(error instanceof Refusal ? error.code : 'unavailable');
    plan.inspection = 'refused';
  }
  plan.codes = [...codes].sort();
  return plan;
}
