import { randomUUID } from 'node:crypto';
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { chmod, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  type AgentId,
  agentId,
  type EngineConnectionId,
  type EngineRuntimeId,
  engineConnectionId,
  engineRuntimeId,
  ReservedStationIdentityError,
  STATION_AGENT_ID,
} from '@kontourai/station-contracts/agent-identity';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type { ConfigLoader } from './config-loader.js';
import {
  canonicalStationHome,
  ensureStationHomeSchema,
  readRegularFileNoFollow,
  type SafeFileReadHooks,
  StationHomeResetRequiredError,
} from './home-schema-gate.js';

const REGISTRY_VERSION = 1;
const REGISTRY_MAX_BYTES = 256 * 1024;
const REGISTRY_LOAD_MAX_ATTEMPTS = 8;

export interface AgentRegistry {
  version: typeof REGISTRY_VERSION;
  revision: number;
  engineConnections: Array<{
    id: EngineConnectionId;
    /** Internal adapter/ACP selector; public identity never infers from it. */
    runtimeConnectionId?: EngineRuntimeId;
    source?:
      | { kind: 'native' }
      | { kind: 'user-acp' }
      | { kind: 'plugin-acp'; plugin: string };
  }>;
  defaultAgents: Array<
    | { id: AgentId; kind: 'station' }
    | {
        id: AgentId;
        kind: 'engine-connection';
        engineConnectionId: EngineConnectionId;
      }
  >;
  /**
   * Native engine ids the user explicitly removed. Automatic adoption of
   * detected CLIs must never resurrect one of these — a deliberate deletion
   * outranks detection (archive#1575).
   */
  declinedEngineConnections?: string[];
}

export class AgentRegistryConflictError extends Error {
  constructor() {
    super('Agent registry changed before the update could commit.');
  }
}

export class DefaultAgentMutationError extends Error {
  readonly code = 'DEFAULT_AGENT_MUTATION_FORBIDDEN';

  constructor(id: string) {
    super(
      `Agent '${id}' is owned by its engine connection and cannot be changed directly. Change or remove the connection instead.`,
    );
  }
}

export class ReservedAgentIdentityError extends Error {
  readonly code = 'AGENT_ID_RESERVED';

  constructor(id: string) {
    super(
      `Agent '${id}' is a retired Station identity and cannot be created or changed. Use the 'station' Agent instead.`,
    );
  }
}

export function assertCustomAgentIdentity(id: string): void {
  if (id === 'default') throw new ReservedAgentIdentityError(id);
}

export class EngineConnectionBindingCollisionError extends Error {
  readonly code = 'ENGINE_CONNECTION_BINDING_COLLISION';

  constructor(id: string) {
    super(`Engine connection '${id}' is already bound to a different runtime.`);
  }
}

export interface AgentRegistryWriteHooks {
  /** Test-only deterministic interleaving point, immediately before rename. */
  beforeRename?: () => void;
}

export interface AgentRegistryReadHooks {
  /** Test-only fallback simulation immediately before opening the registry. */
  beforeRegistryOpen?: () => void;
  registryOpenFlags?: number;
}

function registryPath(homeDir: string): string {
  return join(homeDir, 'config', 'agent-registry.json');
}

function identityMutationLockPath(homeDir: string): string {
  return join(homeDir, 'config', 'agent-identities.mutation');
}

function rejectUnsafeRegistryPath(homeDir: string): never {
  throw new StationHomeResetRequiredError(homeDir);
}

function configDirectory(homeDir: string, create = false): string | null {
  const path = join(homeDir, 'config');
  if (!create && !existsSync(path)) return null;
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    const stats = lstatSync(path, { bigint: true });
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      realpathSync(path) !== path
    ) {
      rejectUnsafeRegistryPath(homeDir);
    }
    return path;
  } catch (error) {
    if (error instanceof StationHomeResetRequiredError) throw error;
    rejectUnsafeRegistryPath(homeDir);
  }
}

function pathIdentity(path: string): string {
  const stats = lstatSync(path, { bigint: true });
  return [stats.dev, stats.ino].join(':');
}

function registryFileSignature(homeDir: string): string | null {
  const directory = configDirectory(homeDir);
  if (directory === null) return null;
  const path = registryPath(homeDir);
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink())
      rejectUnsafeRegistryPath(homeDir);
    return [
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof StationHomeResetRequiredError) throw error;
    throw error;
  }
}

async function registrySignature(homeDir: string): Promise<string | null> {
  return registryFileSignature(homeDir);
}

function registrySignatureSync(homeDir: string): string | null {
  return registryFileSignature(homeDir);
}

function assertRegistry(value: unknown): asserts value is AgentRegistry {
  const registry = value as Partial<AgentRegistry>;
  if (
    !registry ||
    registry.version !== REGISTRY_VERSION ||
    typeof registry.revision !== 'number' ||
    !Number.isSafeInteger(registry.revision) ||
    registry.revision < 0 ||
    !Array.isArray(registry.engineConnections) ||
    !Array.isArray(registry.defaultAgents) ||
    !(
      registry.declinedEngineConnections === undefined ||
      (Array.isArray(registry.declinedEngineConnections) &&
        registry.declinedEngineConnections.every(
          (id) => typeof id === 'string' && id.length > 0,
        ))
    )
  ) {
    throw new Error('Agent registry is invalid.');
  }

  const connectionIds = new Set<string>();
  for (const connection of registry.engineConnections) {
    engineConnectionId(connection.id);
    if (connection.id === 'station') throw new ReservedStationIdentityError();
    if (connectionIds.has(connection.id)) {
      throw new Error('Agent registry has duplicate engine connections.');
    }
    connectionIds.add(connection.id);
    if (
      connection.runtimeConnectionId !== undefined &&
      typeof connection.runtimeConnectionId !== 'string'
    ) {
      throw new Error(
        'Agent registry has an invalid runtime connection binding.',
      );
    }
    if (connection.runtimeConnectionId !== undefined) {
      engineRuntimeId(connection.runtimeConnectionId);
    }
  }

  let stationDefaults = 0;
  const defaultIds = new Set<string>();
  const defaultConnectionIds = new Set<string>();
  for (const defaultAgent of registry.defaultAgents) {
    agentId(defaultAgent.id);
    if (defaultIds.has(defaultAgent.id)) {
      throw new Error('Agent registry has duplicate default Agents.');
    }
    defaultIds.add(defaultAgent.id);
    if (defaultAgent.kind === 'station') {
      if (defaultAgent.id !== 'station') {
        throw new Error('Station default Agent must use the station ID.');
      }
      stationDefaults += 1;
      continue;
    }
    if (
      defaultAgent.kind !== 'engine-connection' ||
      String(defaultAgent.id) !== String(defaultAgent.engineConnectionId) ||
      !connectionIds.has(String(defaultAgent.engineConnectionId)) ||
      defaultConnectionIds.has(String(defaultAgent.engineConnectionId))
    ) {
      throw new Error('Agent registry has an invalid engine default Agent.');
    }
    defaultConnectionIds.add(String(defaultAgent.engineConnectionId));
  }
  if (stationDefaults !== 1) {
    throw new Error(
      'Agent registry must contain exactly one Station default Agent.',
    );
  }
  if (connectionIds.size !== defaultConnectionIds.size) {
    throw new Error(
      'Every engine connection must own exactly one default Agent.',
    );
  }
}

function stationRegistry(): AgentRegistry {
  return {
    version: REGISTRY_VERSION,
    revision: 0,
    engineConnections: [],
    defaultAgents: [{ id: agentId('station'), kind: 'station' }],
  };
}

async function readRegistry(
  homeDir: string,
  hooks: AgentRegistryReadHooks = {},
): Promise<AgentRegistry> {
  const path = registryPath(homeDir);
  const signatureBefore = registrySignatureSync(homeDir);
  if (signatureBefore === null) throw new AgentRegistryConflictError();
  const source = readRegularFileNoFollow(homeDir, path, {
    beforeOpen: hooks.beforeRegistryOpen,
    openFlags: hooks.registryOpenFlags,
  } satisfies SafeFileReadHooks);
  if (registrySignatureSync(homeDir) !== signatureBefore) {
    throw new AgentRegistryConflictError();
  }
  if (Buffer.byteLength(source) > REGISTRY_MAX_BYTES) {
    throw new Error('Agent registry exceeds the byte limit.');
  }
  const registry = JSON.parse(source) as unknown;
  assertRegistry(registry);
  return registry;
}

async function saveRegistry(
  homeDir: string,
  registry: AgentRegistry,
  expectedSignature: string | null,
  hooks: AgentRegistryWriteHooks = {},
): Promise<void> {
  assertRegistry(registry);
  const path = registryPath(homeDir);
  const directory = configDirectory(homeDir, true);
  if (directory === null) rejectUnsafeRegistryPath(homeDir);
  const directoryIdentity = pathIdentity(directory);
  await chmod(directory, 0o700);
  const serialized = JSON.stringify(registry, null, 2);
  if (Buffer.byteLength(serialized) > REGISTRY_MAX_BYTES) {
    throw new Error('Agent registry exceeds the byte limit.');
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const temporary = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await temporary.writeFile(serialized, 'utf8');
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    // Async acquisitions (archive#2646): a contended cross-process lock wait must
    // not freeze the server's event loop. Both locks are still taken in the
    // same path-lock → identity-lock order as every other writer, and the
    // signature recheck below runs after the lock is held, so in-process
    // interleaving during the awaits is detected exactly like the
    // cross-process races this code already defends against.
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    try {
      hooks.beforeRename?.();
      if (
        canonicalStationHome(homeDir) !== homeDir ||
        configDirectory(homeDir) !== directory ||
        pathIdentity(directory) !== directoryIdentity
      ) {
        rejectUnsafeRegistryPath(homeDir);
      }
      if (registrySignatureSync(homeDir) !== expectedSignature) {
        throw new AgentRegistryConflictError();
      }
      const releaseIdentity = await acquireFileMutationLockAsync(
        identityMutationLockPath(homeDir),
      );
      try {
        // The identity fence, re-checked under the lock. A file for a default
        // identity is EXPECTED now — that is what materialization writes —
        // but only when it is bound to that identity's engine connection. An
        // unrelated Agent squatting the id still loses, and re-checking here
        // rather than at the caller is what makes the check atomic: the
        // pre-flight check in `registerEngineConnectionDetailed` happens
        // before this rename, so a concurrent `createAgent` for the same id
        // would otherwise land between the two and both would "win".
        for (const identity of registry.defaultAgents) {
          if (identity.kind !== 'engine-connection') continue;
          if (
            !agentFileBindsConnection(
              homeDir,
              String(identity.id),
              identity.engineConnectionId,
            )
          ) {
            throw new DefaultAgentMutationError(String(identity.id));
          }
        }
        renameSync(temporaryPath, path);
      } finally {
        await releaseIdentity();
      }
    } finally {
      await release();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Whether the persisted Agent at this identity (if any) is the identity's own
 * materialized definition. No file at all is fine — the identity simply has
 * not been materialized yet.
 */
function agentFileBindsConnection(
  homeDir: string,
  id: string,
  connectionId: EngineConnectionId,
): boolean {
  const agentPath = join(homeDir, 'agents', id, 'agent.json');
  if (!existsSync(agentPath)) return true;
  try {
    const spec = JSON.parse(
      readRegularFileNoFollow(homeDir, agentPath),
    ) as AgentSpec;
    return spec.execution?.agentConnectionId === connectionId;
  } catch (error) {
    if (error instanceof StationHomeResetRequiredError) throw error;
    // Unreadable or malformed: it is not provably the identity's own
    // definition, so it keeps the identity out rather than being overwritten.
    return false;
  }
}

/** Seeds only the immutable Station Agent; connection/default lifecycle is Wave 2. */
export async function loadOrCreateAgentRegistry(
  configLoader: ConfigLoader,
  hooks: AgentRegistryReadHooks = {},
): Promise<AgentRegistry> {
  const homeDir = canonicalStationHome(configLoader.getProjectHomeDir());
  await ensureStationHomeSchema(homeDir);
  for (let attempt = 0; attempt < REGISTRY_LOAD_MAX_ATTEMPTS; attempt += 1) {
    const signature = await registrySignature(homeDir);
    if (signature === null) {
      const seeded = stationRegistry();
      try {
        await saveRegistry(homeDir, seeded, null);
        return seeded;
      } catch (error) {
        if (error instanceof AgentRegistryConflictError) continue;
        throw error;
      }
    }
    const registry = await readRegistry(homeDir, hooks);
    if ((await registrySignature(homeDir)) === signature) return registry;
  }
  throw new AgentRegistryConflictError();
}

export async function agentRegistrySourceSignature(
  configLoader: ConfigLoader,
): Promise<string | null> {
  return registrySignature(
    canonicalStationHome(configLoader.getProjectHomeDir()),
  );
}

export async function saveAgentRegistry(
  configLoader: ConfigLoader,
  registry: AgentRegistry,
  expectedSourceSignature: string | null,
  hooks: AgentRegistryWriteHooks = {},
): Promise<void> {
  const homeDir = canonicalStationHome(configLoader.getProjectHomeDir());
  await ensureStationHomeSchema(homeDir);
  await saveRegistry(homeDir, registry, expectedSourceSignature, hooks);
}

/**
 * CAS mutation boundary for later lifecycle waves. Persist first; runtime
 * activation remains owned by StationRuntime.applyAgentConfigurationMutation.
 */
export async function updateAgentRegistry(
  configLoader: ConfigLoader,
  expectedRevision: number,
  mutate: (current: Readonly<AgentRegistry>) => AgentRegistry,
): Promise<AgentRegistry> {
  const homeDir = canonicalStationHome(configLoader.getProjectHomeDir());
  await ensureStationHomeSchema(homeDir);
  const signature = await registrySignature(homeDir);
  if (signature === null) throw new AgentRegistryConflictError();
  const current = await readRegistry(homeDir);
  if ((await registrySignature(homeDir)) !== signature) {
    throw new AgentRegistryConflictError();
  }
  if (current.revision !== expectedRevision) {
    throw new AgentRegistryConflictError();
  }
  const updated = mutate(structuredClone(current));
  assertRegistry(updated);
  updated.revision = current.revision + 1;
  await saveAgentRegistry(configLoader, updated, signature);
  return updated;
}

/**
 * Materialize one external engine identity and its same-ID default Agent in
 * one registry CAS. The provider/ACP configuration is deliberately not read
 * here: it may exist before this succeeds, but is not authoritative until the
 * identity pair is committed.
 */
/** Thrown when automatic adoption meets a recorded decline inside the CAS. */
export class DeclinedEngineConnectionError extends Error {
  readonly code = 'ENGINE_CONNECTION_DECLINED';

  constructor(id: string) {
    super(`Engine connection '${id}' was removed by the user; not readopting.`);
  }
}

export async function registerEngineConnection(
  configLoader: ConfigLoader,
  id: string,
  runtimeConnectionId: string = id,
  source: NonNullable<AgentRegistry['engineConnections'][number]['source']> = {
    kind: 'native',
  },
  options: RegisterEngineConnectionOptions = {},
): Promise<AgentRegistry> {
  return (
    await registerEngineConnectionDetailed(
      configLoader,
      engineConnectionId(id),
      engineRuntimeId(runtimeConnectionId),
      source,
      options,
    )
  ).registry;
}

interface RegisterEngineConnectionOptions {
  /**
   * What a recorded decline means for this registration, evaluated inside
   * the same CAS snapshot as the write so a concurrent removal can never
   * be silently overridden (archive#1575 review HIGH):
   * - 'clear' (default): an EXPLICIT registration outranks an old decline
   *   and erases it — the user asking for the engine back must win.
   * - 'abort': AUTOMATIC adoption must never resurrect a decline; throws
   *   DeclinedEngineConnectionError.
   */
  onDeclined?: 'clear' | 'abort';
}

async function registerEngineConnectionDetailed(
  configLoader: ConfigLoader,
  id: EngineConnectionId,
  runtimeConnectionId: EngineRuntimeId = engineRuntimeId(id),
  source: NonNullable<AgentRegistry['engineConnections'][number]['source']> = {
    kind: 'native',
  },
  options: RegisterEngineConnectionOptions = {},
): Promise<{ registry: AgentRegistry; created: boolean }> {
  assertCustomAgentIdentity(id);
  const connectionId = id;
  if (connectionId === 'station') throw new ReservedStationIdentityError();
  // A matching persisted definition is the desired materialized form. An
  // unrelated record using this id remains a collision.
  if (await configLoader.agentExists(String(connectionId))) {
    const existing = await configLoader.loadAgent(String(connectionId));
    if (existing.execution?.agentConnectionId !== connectionId) {
      throw new DefaultAgentMutationError(String(connectionId));
    }
  }

  const onDeclined = options.onDeclined ?? 'clear';
  for (let attempt = 0; attempt < REGISTRY_LOAD_MAX_ATTEMPTS; attempt += 1) {
    const current = await loadOrCreateAgentRegistry(configLoader);
    if (
      onDeclined === 'abort' &&
      current.declinedEngineConnections?.includes(String(connectionId))
    ) {
      throw new DeclinedEngineConnectionError(id);
    }
    const existing = current.engineConnections.find(
      (item) => item.id === connectionId,
    );
    if (existing) {
      if (
        (existing.runtimeConnectionId ?? existing.id) !== runtimeConnectionId ||
        JSON.stringify(existing.source ?? { kind: 'native' }) !==
          JSON.stringify(source)
      ) {
        throw new EngineConnectionBindingCollisionError(id);
      }
      return { registry: current, created: false };
    }
    try {
      const registry = await updateAgentRegistry(
        configLoader,
        current.revision,
        (value) => ({
          ...value,
          engineConnections: [
            ...value.engineConnections,
            { id: connectionId, runtimeConnectionId, source },
          ],
          defaultAgents: [
            ...value.defaultAgents,
            {
              id: agentId(connectionId),
              kind: 'engine-connection',
              engineConnectionId: connectionId,
            },
          ],
          ...(value.declinedEngineConnections?.includes(String(connectionId))
            ? {
                declinedEngineConnections:
                  value.declinedEngineConnections.filter(
                    (declined) => declined !== String(connectionId),
                  ),
              }
            : {}),
        }),
      );
      return { registry, created: true };
    } catch (error) {
      if (error instanceof AgentRegistryConflictError) continue;
      throw error;
    }
  }
  throw new AgentRegistryConflictError();
}

/** Removes an owned connection/default pair while preserving custom agents. */
/**
 * Outcome of one automatic native-engine adoption attempt (archive#1575). Only
 * 'adopted' changed the registry; every other value is a settled no-op the
 * caller must not retry.
 */
export type NativeEngineAdoptionOutcome =
  | 'adopted'
  | 'exists'
  | 'declined'
  | 'agent-collision'
  /**
   * The id is already registered as a DIFFERENT connection — a user's ACP
   * entry, or a plugin's, that happens to share this native engine's clean
   * id. Previously folded into 'exists', which then let bootstrap materialize
   * that foreign connection under the native engine's brand ("Claude Code"
   * for someone's own `claude` ACP command). It is a settled no-op like the
   * others, but it must NOT be treated as this engine being present.
   */
  | 'connection-collision';

/**
 * Register a DETECTED native engine (claude/codex CLI on PATH) exactly once,
 * without ever fighting the user: an existing connection, a recorded decline
 * (the user deleted this engine before), or a user-authored agent squatting
 * the id all settle as no-ops (archive#1575).
 */
export async function adoptNativeEngineConnection(
  configLoader: ConfigLoader,
  id: string,
  runtimeConnectionId: string = id,
): Promise<NativeEngineAdoptionOutcome> {
  try {
    // The decline/exists checks live INSIDE the registration CAS snapshot:
    // a pre-check here would be stale the moment a concurrent removal
    // records a decline (archive#1575 review HIGH).
    const { created } = await registerEngineConnectionDetailed(
      configLoader,
      engineConnectionId(id),
      engineRuntimeId(runtimeConnectionId),
      { kind: 'native' },
      { onDeclined: 'abort' },
    );
    return created ? 'adopted' : 'exists';
  } catch (error) {
    if (error instanceof DeclinedEngineConnectionError) return 'declined';
    if (error instanceof DefaultAgentMutationError) return 'agent-collision';
    if (error instanceof EngineConnectionBindingCollisionError) {
      return 'connection-collision';
    }
    throw error;
  }
}

/** What `selectEngineAgentAdoption` needs to judge one candidate Agent. */
export interface EngineAgentCandidate {
  readonly slug: string;
  readonly name: string;
  /** Owning project slug; absent = global. */
  readonly project?: string;
  /** Owning plugin, when a plugin contributed this definition. */
  readonly plugin?: string;
  readonly execution?: { agentConnectionId?: string };
  readonly provenance?: AgentSpec['provenance'];
}

export interface EngineAgentAdoption<T extends EngineAgentCandidate> {
  /** The engine's canonical Agent, if an eligible one already exists. */
  readonly adopted?: T;
  /**
   * Every OTHER Agent bound to the same engine connection. They are not
   * removed — they are the user's files — but a surface listing them beside
   * the canonical row has to say so, or one engine reads as two Agents with
   * nothing to tell them apart.
   */
  readonly alsoBound: readonly T[];
}

/**
 * Which authored Agent, if any, IS this engine's Agent — decided by rule,
 * never by listing order.
 *
 * The first version took `agents.find(bound to this connection)`. Three
 * things were wrong with that. `listAgentConfigs` sorts by mtime descending,
 * so "first" meant "most recently edited" and could change under an ordinary
 * save. Nothing checked ownership, so a project-owned or plugin-owned Agent
 * that merely bound the same engine could be adopted as the engine's seeded
 * row — a plugin's file then answering for "Claude Code" everywhere. And with
 * two bound files it silently picked one and left the other as an
 * indistinguishable duplicate.
 *
 * ELIGIBILITY (all required): bound to this connection, GLOBAL (a
 * project-owned Agent is out of scope for a global engine identity), and NOT
 * plugin-owned (a plugin owns its file; adopting it would mean Station
 * rewriting it on the next plugin update).
 *
 * TIERS, best first — each is positive evidence that this file IS the
 * engine's Agent rather than merely pointed at it:
 *   0. it occupies the engine's canonical slug;
 *   1. it carries engine-detection provenance for this engine (a previously
 *      materialized row, possibly renamed);
 *   2. it has the exact shape the legacy Enable minted — `"<Display> Agent"`.
 * An Agent that is merely bound (a user's own second Agent on the same
 * engine) qualifies for none of them and is never adopted.
 *
 * TIE-BREAK inside a tier: slug, lexicographically. Deliberately NOT
 * "earliest createdAt": the listing carries mtime, not creation time, so
 * ordering by it would hand the engine's identity to whichever file the user
 * edited least recently and move it again on the next save. A slug never
 * changes, so this decision is stable for the life of the file.
 */
export function selectEngineAgentAdoption<T extends EngineAgentCandidate>(
  candidates: readonly T[],
  engine: { id: string; connectionId: string; displayName: string },
): EngineAgentAdoption<T> {
  const bound = candidates.filter(
    (candidate) =>
      candidate.execution?.agentConnectionId === engine.connectionId,
  );
  const tierOf = (candidate: T): number | null => {
    if (candidate.project !== undefined) return null;
    if (candidate.plugin !== undefined) return null;
    if (candidate.slug === engine.id) return 0;
    if (
      candidate.provenance?.origin === 'engine-detection' &&
      candidate.provenance.engineId === engine.id
    ) {
      return 1;
    }
    if (candidate.name === `${engine.displayName} Agent`) return 2;
    return null;
  };
  const eligible = bound
    .map((candidate) => ({ candidate, tier: tierOf(candidate) }))
    .filter(
      (entry): entry is { candidate: T; tier: number } => entry.tier !== null,
    )
    .sort(
      (a, b) =>
        a.tier - b.tier || a.candidate.slug.localeCompare(b.candidate.slug),
    );
  const adopted = eligible[0]?.candidate;
  return {
    ...(adopted ? { adopted } : {}),
    alsoBound: bound.filter((candidate) => candidate !== adopted),
  };
}

export interface StationAgentMaterialization {
  /** The definition did not exist and was written. */
  readonly created: boolean;
  /** An existing definition named the unresolvable `station` connection. */
  readonly healed: boolean;
}

/**
 * Materialize (and heal) Station's own Agent — archive#3662.
 *
 * Deliberately NOT `materializeEngineAgent`. That function binds the file it
 * writes to an engine CONNECTION of the same id, and `station` is the one id
 * that can never be one: `assertRegistry` throws `ReservedStationIdentityError`
 * for an engine connection called `station`, and `registerEngineConnection`
 * refuses to create one. So the seeded file named a connection that structurally
 * cannot exist, and every consumer that resolves the binding disagreed with
 * every consumer that does not:
 *
 *  - `resolveExecutionTarget` took the bound-connection branch and threw
 *    `Connection not found`, so `POST /api/orchestration/chat` 400'd for the
 *    default Agent on a home `/api/system/status` called chat-ready;
 *  - `enriched-agents.ts` reported `available: false` with the reason
 *    "Engine connection 'station' is not configured." whenever the managed
 *    engine had not registered — an external-engine sentence about Station's
 *    own engine;
 *  - the new-chat picker's dispatch check (`canAgentStartChat`) could not find
 *    the connection either and offered nothing to chat with.
 *
 * The fix is one derivation rather than three repairs: a Station-engine Agent
 * omits `agentConnectionId` (`docs/design/agent-engine-unification.md` §7.1),
 * which is exactly what `resolveExecutionTarget`'s unbound branch already
 * means — `engine: { kind: 'station' }`, `provider: 'station-agent'`.
 *
 * HEALS AT LOAD, and only then. This runs at every startup, so it must not
 * rewrite a file it has already corrected: the write is gated on the binding
 * actually being present (the archive#1588/#3063 self-write-loop rule). Only the
 * `agentConnectionId` key is dropped — anything else the user put on
 * `execution` (a model pin, runtime options) is preserved, and `execution`
 * itself is removed only when nothing else remains.
 *
 * The heal is a READ-MODIFY-WRITE INSIDE the per-Agent persistence lock
 * (`mutateAgent`), not a load-then-save around it — review HIGH-1. Startup
 * and the editor are genuinely concurrent: this runs fire-and-forget after
 * the runtime is serving, so a user can save a prompt change in the window
 * between a read and a write. Re-reading under the lock means the heal edits
 * whatever the editor just committed, and the precondition is re-checked
 * there too, so a spec that no longer carries the dead binding declines the
 * write instead of stamping a stale snapshot over the user's edit.
 */
/**
 * The reserved Station identity's spec with its engine binding removed — the
 * ONE definition of what healing means, shared by the writer
 * (`materializeStationAgent`), the WRITE boundary
 * (`config-loader-agents.ts`'s `saveAgentConfigWithOwnedLock`) and the read
 * projection (`AgentService`) that has to cope when the write could not
 * happen (archive#3662 review MEDIUM-2, delta H3).
 *
 * ANY `agentConnectionId`, not merely the impossible literal `station`.
 * `AppConfig.builtinAgentEngineConnectionId` is the authority for this one
 * identity's engine and it is resolved per boot
 * (`docs/design/agent-engine-unification.md` §7.1); the record itself never
 * carries a binding. Dropping only `station` left the other half of the same
 * defect reachable: the catalog projects the RUNTIME binding (say `codex`)
 * onto the record, the editor loads that into its form, and any unrelated
 * save writes `codex` back to disk — after which a boot where Codex is
 * unavailable resolves to Station's own engine while the file still says
 * Codex, and dispatch follows the file.
 *
 * Anything else the user put on `execution` (a model pin, runtime options) is
 * preserved, and `execution` itself is removed only when nothing else
 * remains.
 *
 * The heal is a fire-and-forget startup write. On a read-only home, a home on
 * a filesystem that refuses the atomic replace, or any other write failure,
 * it does nothing — and before this the impossible binding stayed live for
 * the whole session, which is the original dispatch failure surviving a boot
 * that reported success. Correctness therefore does not depend on the write:
 * a reader never honours a binding this identity cannot have, and the write
 * is what makes the file agree.
 *
 * Returns the SAME object when there is nothing to drop, so the common path
 * allocates nothing.
 */
export function withoutReservedStationBinding<
  T extends { execution?: AgentSpec['execution'] },
>(spec: T): T {
  if (spec.execution?.agentConnectionId === undefined) return spec;
  const { agentConnectionId: _reserved, ...rest } = spec.execution;
  const healed: T = { ...spec };
  if (Object.keys(rest).length > 0) healed.execution = rest;
  else delete healed.execution;
  return healed;
}

export async function materializeStationAgent(
  configLoader: Pick<
    ConfigLoader,
    'agentExists' | 'createAgent' | 'mutateAgent'
  >,
): Promise<StationAgentMaterialization> {
  if (!(await configLoader.agentExists(STATION_AGENT_ID))) {
    await configLoader.createAgent({
      slug: STATION_AGENT_ID,
      name: 'Station',
      prompt: '',
      provenance: {
        origin: 'engine-detection',
        engineId: STATION_AGENT_ID,
        detectedAt: new Date().toISOString(),
      },
    } as AgentSpec & { slug: string });
    return { created: true, healed: false };
  }
  const healedRecord = await configLoader.mutateAgent(
    STATION_AGENT_ID,
    (current) => {
      // Re-checked under the lock, against whatever is on disk NOW. Same
      // function the read boundary applies, so a healed file and an unhealed
      // one are read identically. `null` declines the write outright, which is
      // what keeps a per-boot heal from being a self-write→watcher loop.
      const healed = withoutReservedStationBinding(current);
      return healed === current ? null : healed;
    },
  );
  return { created: false, healed: healedRecord !== null };
}

/**
 * Make the registry identity usable. The resulting file is deliberately an
 * ordinary Agent: users can edit, add skills to, or delete it like any other.
 * An eligible pre-existing Agent bound to the connection is adopted instead
 * (the legacy Enable migration), so this never creates a second row for one
 * engine — see `selectEngineAgentAdoption` for which files qualify and why
 * the choice is by rule rather than by listing order.
 *
 * IDEMPOTENT PER REQUEST, not merely storage-safe. The checks below are not
 * inside the per-slug persistence lock, so two simultaneous calls (two tabs,
 * or first run racing the picker's Enable) can both reach the create; the
 * lock then lets one win and makes the other throw "already exists". One file
 * is still correct on disk, but the losing REQUEST used to surface as an HTTP
 * 400 to a user who did nothing wrong. A create that loses that race
 * re-resolves and reports the winner's file as `created: false`.
 */
export async function materializeEngineAgent(
  configLoader: ConfigLoader,
  id: string,
  name: string,
): Promise<{ slug: string; created: boolean }> {
  const connectionId = engineConnectionId(id);
  const resolveExisting = async (): Promise<string | null> => {
    const metadata = await configLoader.listAgents();
    // The listing does not carry `provenance`, and tier 1 needs it. Load only
    // the files that are actually bound to this engine — never the catalog.
    const candidates = await Promise.all(
      metadata
        .filter((agent) => agent.execution?.agentConnectionId === connectionId)
        .map(async (agent) => {
          let provenance: AgentSpec['provenance'];
          try {
            provenance = (await configLoader.loadAgent(String(agent.slug)))
              .provenance;
          } catch {
            // Mid-write or unreadable: it simply cannot prove tier 1. The
            // other tiers still apply, and a missing file drops out below.
          }
          return {
            slug: String(agent.slug),
            name: agent.name,
            ...(agent.project !== undefined ? { project: agent.project } : {}),
            ...(agent.plugin !== undefined ? { plugin: agent.plugin } : {}),
            execution: agent.execution,
            ...(provenance ? { provenance } : {}),
          } as EngineAgentCandidate;
        }),
    );
    const { adopted } = selectEngineAgentAdoption(candidates, {
      id,
      connectionId: String(connectionId),
      displayName: name,
    });
    return adopted?.slug ?? null;
  };

  const adoptedSlug = await resolveExisting();
  if (adoptedSlug) return { slug: adoptedSlug, created: false };

  if (await configLoader.agentExists(id)) {
    // A file sits at the identity's own id that adoption did not choose.
    // Decide from the file, not from the projection: it is either this
    // identity's own definition (a listing that did not carry the binding) or
    // an unrelated Agent squatting the id — and returning the squatter as
    // "the engine's Agent" would be a lie the whole picker then repeats.
    const existingSpec = await configLoader.loadAgent(id);
    if (existingSpec.execution?.agentConnectionId === connectionId) {
      return { slug: id, created: false };
    }
    throw new DefaultAgentMutationError(id);
  }
  try {
    const { slug } = await configLoader.createAgent({
      slug: id,
      name,
      prompt: '',
      execution: { agentConnectionId: connectionId },
      provenance: {
        origin: 'engine-detection',
        engineId: id,
        detectedAt: new Date().toISOString(),
      },
    } as AgentSpec & { slug: string });
    return { slug, created: true };
  } catch (error) {
    // Deliberately not matched on the message — re-ASK the store. If a
    // concurrent call already materialized this engine, that is the answer
    // this caller wanted; anything else is a real failure and rethrows.
    const winner = await resolveExisting();
    if (winner) return { slug: winner, created: false };
    throw error;
  }
}

export async function unregisterEngineConnection(
  configLoader: ConfigLoader,
  id: string,
): Promise<AgentRegistry> {
  const connectionId = engineConnectionId(id);
  for (let attempt = 0; attempt < REGISTRY_LOAD_MAX_ATTEMPTS; attempt += 1) {
    const current = await loadOrCreateAgentRegistry(configLoader);
    const removed = current.engineConnections.find(
      (item) => item.id === connectionId,
    );
    if (!removed) {
      return current;
    }
    // A user-removed NATIVE engine records a decline so automatic adoption
    // of a still-detected CLI cannot resurrect it (archive#1575). ACP/plugin
    // engines are never auto-adopted, so they need no decline memory.
    // Absent source (a hand-edited registry — the file is documented as
    // authoritative and user-editable) defaults to 'native' deliberately:
    // erring toward honoring a deletion can at worst suppress an adoption
    // the user can redo explicitly; erring the other way resurrects a
    // connection the user just removed.
    const declines =
      (removed.source?.kind ?? 'native') === 'native'
        ? [
            ...new Set([
              ...(current.declinedEngineConnections ?? []),
              String(connectionId),
            ]),
          ]
        : current.declinedEngineConnections;
    try {
      return await updateAgentRegistry(
        configLoader,
        current.revision,
        (value) => ({
          ...value,
          engineConnections: value.engineConnections.filter(
            (item) => item.id !== connectionId,
          ),
          defaultAgents: value.defaultAgents.filter(
            (item) =>
              item.kind !== 'engine-connection' ||
              item.engineConnectionId !== connectionId,
          ),
          ...(declines !== undefined
            ? { declinedEngineConnections: declines }
            : {}),
        }),
      );
    } catch (error) {
      if (error instanceof AgentRegistryConflictError) continue;
      throw error;
    }
  }
  throw new AgentRegistryConflictError();
}

export function isRegistryDefaultAgent(
  registry: AgentRegistry,
  id: string,
): boolean {
  return registry.defaultAgents.some((agent) => agent.id === id);
}

/** Descriptor-safe read for lower-level writers; unsafe registry state fails closed. */
export async function registryOwnsAgentAtHome(
  requestedHomeDir: string,
  id: string,
): Promise<boolean> {
  const homeDir = canonicalStationHome(requestedHomeDir);
  if (registrySignatureSync(homeDir) === null) return false;
  return isRegistryDefaultAgent(await readRegistry(homeDir), id);
}

/**
 * Shared commit lock for the two stores that can claim an Agent id. The
 * ACQUISITION is async (archive#2646 review MEDIUM): with `saveRegistry` taking this
 * lock asynchronously, any remaining synchronous acquirer that queued behind
 * an async holder would spin `Atomics.wait` on the event loop — which also
 * prevents the holder's release from ever running, deterministically freezing
 * the server for the sync caller's full timeout. Every in-process acquirer of
 * this lock file must therefore use this async form. The HELD section's
 * contract is unchanged: callers must not await between acquisition and
 * release — it protects only the final synchronous ownership recheck and
 * publish.
 */
export async function acquireAgentIdentityMutationLockAtHome(
  requestedHomeDir: string,
): Promise<() => Promise<void>> {
  const homeDir = canonicalStationHome(requestedHomeDir);
  configDirectory(homeDir, true);
  return acquireFileMutationLockAsync(identityMutationLockPath(homeDir));
}

/**
 * The fail-closed tamper check that used to ride along on
 * `registryOwnsAgentAtHomeSync`'s read. Agent writers call it for the
 * ASSERTION, not for a verdict: registry ownership is no longer a reason to
 * refuse a write (engine agents are ordinary materialized files), but a
 * symlinked, non-regular, or malformed registry still must stop one — and
 * dropping the call along with the veto silently dropped that too.
 */
export function assertRegistryIntegrityAtHomeSync(
  requestedHomeDir: string,
): void {
  const homeDir = canonicalStationHome(requestedHomeDir);
  if (registrySignatureSync(homeDir) === null) return;
  assertRegistry(
    JSON.parse(
      readRegularFileNoFollow(homeDir, registryPath(homeDir)),
    ) as unknown,
  );
}

/**
 * The engine connection a registry default with this id owns, or `null` when
 * the registry does not claim the id at all. Read fail-closed, like every
 * other registry read on a write path.
 */
export function registryEngineConnectionForDefaultSync(
  requestedHomeDir: string,
  id: string,
): EngineConnectionId | null {
  const homeDir = canonicalStationHome(requestedHomeDir);
  if (registrySignatureSync(homeDir) === null) return null;
  const registry = JSON.parse(
    readRegularFileNoFollow(homeDir, registryPath(homeDir)),
  ) as unknown;
  assertRegistry(registry);
  const identity = registry.defaultAgents.find((agent) => agent.id === id);
  return identity?.kind === 'engine-connection'
    ? identity.engineConnectionId
    : null;
}

export function registryOwnsAgentAtHomeSync(
  requestedHomeDir: string,
  id: string,
): boolean {
  const homeDir = canonicalStationHome(requestedHomeDir);
  if (registrySignatureSync(homeDir) === null) return false;
  const source = readRegularFileNoFollow(homeDir, registryPath(homeDir));
  const registry = JSON.parse(source) as unknown;
  assertRegistry(registry);
  return isRegistryDefaultAgent(registry, id);
}

export function registryIdentityForRuntimeConnection(
  registry: AgentRegistry,
  runtimeConnectionId: EngineRuntimeId,
): EngineConnectionId | null {
  return (
    registry.engineConnections.find(
      (connection) =>
        (connection.runtimeConnectionId ?? connection.id) ===
        runtimeConnectionId,
    )?.id ?? null
  );
}

export async function reconcilePluginEngineConnections(
  configLoader: ConfigLoader,
  configured: Array<{ id: string; plugin: string }>,
): Promise<void> {
  const expected = new Map<string, { id: string; plugin: string }>();
  for (const connection of configured) {
    const prior = expected.get(connection.id);
    if (prior && prior.plugin !== connection.plugin) {
      throw new EngineConnectionBindingCollisionError(connection.id);
    }
    expected.set(connection.id, connection);
  }
  // Reconciliation is additive. A provider missing from this boot may have
  // failed to load or probe; absence is availability, not an uninstall
  // command, and must not delete its durable identity/default Agent.
  for (const connection of expected.values()) {
    await registerEngineConnection(
      configLoader,
      engineConnectionId(connection.id),
      engineRuntimeId(connection.id),
      {
        kind: 'plugin-acp',
        plugin: connection.plugin,
      },
    );
  }
}

/** Exact reconciliation for one explicit plugin lifecycle mutation. */
export async function replacePluginEngineConnections(
  configLoader: ConfigLoader,
  plugin: string,
  configuredIds: string[],
): Promise<AgentRegistry> {
  const desired = new Set<EngineConnectionId>();
  for (const rawId of configuredIds) {
    assertCustomAgentIdentity(rawId);
    const id = engineConnectionId(rawId);
    agentId(id);
    if (desired.has(id)) {
      throw new EngineConnectionBindingCollisionError(rawId);
    }
    desired.add(id);
    if (await configLoader.agentExists(rawId)) {
      throw new DefaultAgentMutationError(rawId);
    }
  }

  for (let attempt = 0; attempt < REGISTRY_LOAD_MAX_ATTEMPTS; attempt += 1) {
    const current = await loadOrCreateAgentRegistry(configLoader);
    for (const id of desired) {
      const existing = current.engineConnections.find(
        (connection) => connection.id === id,
      );
      if (
        existing &&
        (existing.source?.kind !== 'plugin-acp' ||
          existing.source.plugin !== plugin ||
          (existing.runtimeConnectionId ?? existing.id) !== id)
      ) {
        throw new EngineConnectionBindingCollisionError(id);
      }
    }

    const previousOwned = new Set(
      current.engineConnections
        .filter(
          (connection) =>
            connection.source?.kind === 'plugin-acp' &&
            connection.source.plugin === plugin,
        )
        .map((connection) => connection.id),
    );
    const retainedConnections = current.engineConnections.filter(
      (connection) => !previousOwned.has(connection.id),
    );
    const retainedDefaults = current.defaultAgents.filter(
      (agent) =>
        agent.kind !== 'engine-connection' ||
        !previousOwned.has(agent.engineConnectionId),
    );

    try {
      return await updateAgentRegistry(
        configLoader,
        current.revision,
        (value) => ({
          ...value,
          engineConnections: [
            ...retainedConnections,
            ...[...desired].map((id) => ({
              id,
              runtimeConnectionId: engineRuntimeId(id),
              source: { kind: 'plugin-acp' as const, plugin },
            })),
          ],
          defaultAgents: [
            ...retainedDefaults,
            ...[...desired].map((id) => ({
              id: agentId(id),
              kind: 'engine-connection' as const,
              engineConnectionId: id,
            })),
          ],
        }),
      );
    } catch (error) {
      if (error instanceof AgentRegistryConflictError) continue;
      throw error;
    }
  }
  throw new AgentRegistryConflictError();
}

/** Removes only the engine identities durably owned by an explicitly uninstalled plugin. */
export async function unregisterPluginEngineConnections(
  configLoader: ConfigLoader,
  plugin: string,
): Promise<AgentRegistry> {
  for (let attempt = 0; attempt < REGISTRY_LOAD_MAX_ATTEMPTS; attempt += 1) {
    const current = await loadOrCreateAgentRegistry(configLoader);
    const removedIds = new Set(
      current.engineConnections
        .filter(
          (connection) =>
            connection.source?.kind === 'plugin-acp' &&
            connection.source.plugin === plugin,
        )
        .map((connection) => connection.id),
    );
    if (removedIds.size === 0) return current;
    try {
      return await updateAgentRegistry(
        configLoader,
        current.revision,
        (value) => ({
          ...value,
          engineConnections: value.engineConnections.filter(
            (connection) => !removedIds.has(connection.id),
          ),
          defaultAgents: value.defaultAgents.filter(
            (agent) =>
              agent.kind !== 'engine-connection' ||
              !removedIds.has(agent.engineConnectionId),
          ),
        }),
      );
    } catch (error) {
      if (error instanceof AgentRegistryConflictError) continue;
      throw error;
    }
  }
  throw new AgentRegistryConflictError();
}
