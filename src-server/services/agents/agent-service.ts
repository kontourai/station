/**
 * Agent Service - handles agent CRUD and lifecycle operations
 */

import type {
  AgentExecutionConfig,
  AgentSpec,
} from '@kontourai/station-contracts/agent';
import {
  type EngineConnectionId,
  engineConnectionId,
  isStationAgentIdentity,
} from '@kontourai/station-contracts/agent-identity';
import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';

type Agent = any;

import {
  type AgentRegistry,
  assertCustomAgentIdentity,
  DefaultAgentMutationError,
  isRegistryDefaultAgent,
  materializeEngineAgent as materializeEngineAgentFile,
  withoutReservedStationBinding,
} from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { resolveAgentConfigSlug } from '../../domain/config-loader-agents.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { agentOps } from '../../telemetry/metrics.js';

export interface AgentMetadata {
  slug: string;
  name: string;
  description?: string;
  prompt?: string;
  /** Plugin that owns this Agent definition, when contributed by a plugin. */
  plugin?: string;
  updatedAt?: string;
  /** Owning project slug; absent = global scope (agent-engine-unification.md §3.3). */
  project?: string;
  /**
   * archive#1194 (epic archive#1191, slice B): carried through for the built-in
   * default agent (`bootstrapRuntimeDefaultAgent`) when it's bound to an
   * external engine, so `enriched-agents.ts`'s `defaultSpec()` projection
   * classifies it exactly like every other external-engine-bound agent
   * record (archive#954's `execution.agentConnectionId` convention).
   */
  execution?: AgentExecutionConfig;
}

export interface EnrichedAgent {
  id: string;
  slug: string;
  name: string;
  prompt?: string;
  description?: string;
  plugin?: string;
  model?: string;
  region?: string;
  guardrails?: AgentSpec['guardrails'];
  maxSteps?: number;
  icon?: string;
  commands?: AgentSpec['commands'];
  toolsConfig?: AgentSpec['tools'];
  execution?: AgentExecutionConfig;
  updatedAt?: string;
  /**
   * Additive legibility fields (#chat). Registered/launchable agents omit
   * these (undefined). A persisted agent that failed model resolution and was
   * therefore never registered with VoltAgent is surfaced by `GET /api/agents`
   * with `available: false` and `unavailableReason` set to the concrete
   * resolution error, so it stops being silently invisible.
   */
  available?: boolean;
  unavailableReason?: string;
  /** Owning project slug; absent = global scope (agent-engine-unification.md §3.3). */
  project?: string;
}

/** `POST /agents/materialize-engine` was handed an id no registry identity claims. */
export class UnknownEngineIdentityError extends Error {
  readonly code = 'UNKNOWN_ENGINE_IDENTITY';
  constructor(engineId: string) {
    super(`No engine connection '${engineId}' is registered.`);
    this.name = 'UnknownEngineIdentityError';
  }
}

/**
 * A write tried to bind the reserved `station` identity to an engine.
 *
 * archive#3662 delta-2 HIGH. The write boundary already strips such a binding
 * (`withoutReservedStationBinding` in `saveAgentConfigWithOwnedLock`), which
 * keeps the FILE honest — but on its own that made
 * `PUT /agents/station {"execution":{"agentConnectionId":"claude"}}` and
 * `station agents update station --data ...` answer 2xx for a change that did
 * not happen, and echo back the current runtime binding as if it were the
 * result. A silent no-op is the label-vs-derivation defect wearing a success
 * code: the caller is told its write took effect and it did not.
 *
 * The UI never reaches this (its Engine row states the value and points at
 * Settings) and station-control's typed tool does not expose `execution`, but
 * REST, the SDK and the CLI all do — so the refusal lives at the SERVICE seam
 * they share rather than in any one route.
 *
 * Only a NON-EMPTY `agentConnectionId` is refused. `execution: null` (the
 * editor's "runs on Station's own engine" signal) and a modelId-only
 * `execution` are ordinary, accepted writes.
 */
export class StationEngineIsAppSettingError extends Error {
  readonly code = 'STATION_ENGINE_IS_APP_SETTING';
  /** The route family maps this to 409, not 400: the request is well-formed. */
  readonly status = 409 as const;
  constructor(submitted: string) {
    super(
      `The Station Agent's engine is not an Agent field, so '${submitted}' cannot be persisted on it. ` +
        'It is a Station setting — `builtinAgentEngineConnectionId` (Settings → Station → Built-in agent engine) — ' +
        'resolved fresh on every start against live engine readiness, which is why the Agent record never stores it. ' +
        'Set it there instead. To run the built-in Agent on Station\'s own engine, send `"execution": null`.',
    );
    this.name = 'StationEngineIsAppSettingError';
  }
}

/**
 * Refuse a write that submits an engine binding for the reserved Station
 * identity. Shared by `createAgent` and `updateAgent` — the two doors every
 * public surface goes through.
 */
function assertStationBindingNotSubmitted(
  slug: string,
  input: Record<string, unknown>,
): void {
  if (!isStationAgentIdentity(slug)) return;
  const execution = input.execution;
  // `null` is the CLEAR signal and `undefined` is "no change"; neither is an
  // attempt to bind.
  if (!execution || typeof execution !== 'object') return;
  const submitted = (execution as { agentConnectionId?: unknown })
    .agentConnectionId;
  // An empty string is how a form spells "no engine connection", not a bind.
  if (typeof submitted !== 'string' || submitted.trim() === '') return;
  throw new StationEngineIsAppSettingError(submitted);
}

/**
 * The slug `ConfigLoader.createAgent` will actually write to, for a create
 * body that may not carry one. Same derivation the loader uses; an
 * unresolvable name is left for the loader to reject with its own message.
 */
function resolvedCreateSlug(body: Record<string, unknown>): string {
  try {
    return resolveAgentConfigSlug(body as unknown as AgentSpec);
  } catch {
    return '';
  }
}

/**
 * The internal runtime key the built-in Station Agent's instance and metadata
 * live under. The PUBLIC identity is `station`; this key is the runtime's own
 * and is deliberately not renamed here (see `enriched-agents.ts`'s `isActive`,
 * which reads the pair as one Agent).
 */
export const RUNTIME_DEFAULT_AGENT_KEY = 'default';

/**
 * The engine binding the RUNTIME resolved for the reserved Station identity
 * this boot, or `undefined` when it runs on Station's own engine.
 *
 * THIS IS THE AUTHORITY, and archive#3662 review HIGH-3 is what makes saying
 * so necessary. The selection a user makes lives in
 * `AppConfig.builtinAgentEngineConnectionId`, but the BINDING is resolved from
 * it per boot against live state — readiness, control-plane capability, and
 * (since archive#1549) a per-connection runtime observation. That resolution
 * is deliberately not persisted:
 *
 *  - `resolveBuiltinAgentEngineBinding` fails safe to Station "for THIS
 *    resolution only; the persisted choice itself is untouched", so writing
 *    the resolution into `agents/station/agent.json` would let one boot with
 *    an unready engine destroy the user's choice — precisely the
 *    clobber-back that `runtime-default-agent.ts` records this in metadata to
 *    avoid;
 *  - archive#1549's payoff is that the same stored choice starts resolving
 *    the moment evidence arrives, with no user action. A frozen record would
 *    defeat that.
 *  - and a derived copy in the Agent record would be a SECOND record of one
 *    fact — which is the defect class this whole change removes, made worse
 *    by `listAgents` preferring a stored file over the registry projection.
 *
 * So the record stays unbound and every reader consults this projection
 * instead. Exported so the catalog (`enriched-agents.ts`) and this service
 * read the same field rather than each reaching into the map.
 */
export function runtimeStationEngineExecution(
  agentMetadataMap: ReadonlyMap<string, { execution?: AgentSpec['execution'] }>,
): AgentSpec['execution'] | undefined {
  return agentMetadataMap.get(RUNTIME_DEFAULT_AGENT_KEY)?.execution;
}

/**
 * The reserved Station identity's engine binding as a READER sees it — the
 * per-boot runtime resolution when there is one, and no binding at all
 * otherwise.
 *
 * THE ONE PROJECTION POINT (archive#3662 delta H3). Round 1 applied this
 * overlay per reader, inside `enriched-agents.ts`; that made the runtime a
 * second authority which every current and future reader had to consult
 * correctly, and two already did not — `GET /api/agents/:slug/binding` (the
 * endpoint `station chat` uses to pick its managed-vs-external read model)
 * and the save-response validation. Applying it here, on the service every
 * route/CLI/MCP reader already goes through, makes a reader that forgets
 * impossible rather than merely wrong.
 *
 * The `withoutReservedStationBinding` fallback is what makes the projection
 * total: on a home this process could not heal (read-only mount, an atomic
 * replace the filesystem refuses) the record still carries a binding, and the
 * reader must not honour one this identity cannot have.
 */
function projectStationEngineBinding<
  T extends { execution?: AgentSpec['execution'] },
>(
  slug: string,
  record: T,
  agentMetadataMap: ReadonlyMap<string, { execution?: AgentSpec['execution'] }>,
): T {
  if (!isStationAgentIdentity(slug)) return record;
  const runtimeExecution = runtimeStationEngineExecution(agentMetadataMap);
  return runtimeExecution
    ? { ...record, execution: runtimeExecution }
    : withoutReservedStationBinding(record);
}

export class AgentService {
  constructor(
    private configLoader: ConfigLoader,
    private storageAdapter: IStorageAdapter,
    private activeAgents: Map<string, Agent>,
    private agentMetadataMap: Map<string, AgentMetadata>,
    _agentSpecs: Map<string, AgentSpec>,
    private logger: any,
    /** Registry identities are the source of truth for engine-owned defaults. */
    private readonly getAgentRegistry?: () => Promise<AgentRegistry>,
    private readonly getRuntimeReadiness?: (
      connectionId: EngineConnectionId,
    ) => Promise<{ available: boolean; reason?: string }>,
  ) {}

  /**
   * Names a command-backed engine connection the way its owner named it.
   *
   * RT-11: connecting an ACP CLI adds a `defaultAgents` entry, and the naming
   * below has no capability-matrix `displayName` for a non-native connection,
   * so the alias fell straight through to the bare id — the Agents list
   * rendered `opencode / opencode / opencode`, the raw slug three times. The
   * ACP config is where that connection's name actually lives, so the fallback
   * reads it rather than inventing one. Absent (a hand-edited registry entry
   * with no ACP record, or a loader without the ACP surface) keeps the id.
   */
  private async acpConnectionNames(): Promise<Map<string, string>> {
    if (typeof (this.configLoader as any).loadACPConfig !== 'function') {
      return new Map();
    }
    try {
      const config = await this.configLoader.loadACPConfig();
      return new Map(
        (config.connections ?? []).flatMap((connection) =>
          connection?.id && connection.name?.trim()
            ? [[String(connection.id), connection.name.trim()]]
            : [],
        ),
      );
    } catch {
      // An unreadable or mid-write ACP config is not a reason to fail the
      // whole agent listing; the bare id remains the honest fallback.
      return new Map();
    }
  }

  private async registryDefaults(): Promise<AgentMetadata[]> {
    if (!this.getAgentRegistry) return [];
    const registry = await this.getAgentRegistry();
    const runtimeDefaultExecution = runtimeStationEngineExecution(
      this.agentMetadataMap,
    );
    const nativeConnectionIds = new Set(
      registry.engineConnections
        // Strictly explicit 'native' — no absent-source fallback. The decline
        // path defaults absent source to native because erring that way only
        // suppresses a redoable adoption; on this NAMING boundary the same
        // default would grant a hand-edited entry a trusted CLI brand, so
        // the safety direction flips.
        .filter((connection) => connection.source?.kind === 'native')
        .map((connection) => String(connection.id)),
    );
    // Only a non-native connection can need it, and only then is the ACP
    // config read.
    const acpNames = registry.defaultAgents.some(
      (agent) =>
        agent.kind === 'engine-connection' &&
        !nativeConnectionIds.has(String(agent.engineConnectionId)),
    )
      ? await this.acpConnectionNames()
      : new Map<string, string>();
    return registry.defaultAgents.map((agent) =>
      agent.kind === 'station'
        ? {
            slug: agent.id,
            name: 'Station',
            ...(runtimeDefaultExecution
              ? { execution: runtimeDefaultExecution }
              : {}),
          }
        : {
            slug: agent.id,
            // Out of the box a coding runtime presents itself the way its
            // CLI does — "Claude Code", "Codex" — not as a bare slug (owner
            // direction on archive#1575). The matrix lookup is gated on the
            // connection actually being NATIVE: an ACP/plugin connection
            // whose id merely collides with a matrix key must keep its own
            // identity, never wear the engine's brand (the matrix's own
            // displayName:null convention for 'acp').
            name:
              (nativeConnectionIds.has(String(agent.engineConnectionId))
                ? ENGINE_CAPABILITY_MATRICES[String(agent.engineConnectionId)]
                    ?.displayName
                : acpNames.get(String(agent.engineConnectionId))) ?? agent.id,
            execution: {
              // Agent bindings are public EngineConnectionIds — the only
              // engine identity the registry stores (#938 retired the
              // separate adapter-private runtime selector, so there is no
              // second id for ConnectionService to resolve).
              agentConnectionId: agent.engineConnectionId,
            },
          },
    );
  }

  private async assertMutableAgent(slug: string): Promise<void> {
    assertCustomAgentIdentity(slug);
    if (!this.getAgentRegistry) return;
    const registry = await this.getAgentRegistry();
    // A registry default without a file is the sole remaining virtual row.
    // Materialized engine agents are intentionally editable.
    if (
      isRegistryDefaultAgent(registry, slug) &&
      typeof (this.configLoader as any).agentExists === 'function' &&
      !(await this.configLoader.agentExists(slug))
    ) {
      throw new DefaultAgentMutationError(slug);
    }
  }

  /**
   * One Agent's spec as every reader should see it — the persisted record with
   * the Station-identity projection applied (`projectStationEngineBinding`).
   *
   * The seam. `configLoader.loadAgent` is the file; this is the Agent.
   */
  async getAgent(slug: string): Promise<AgentSpec> {
    return projectStationEngineBinding(
      slug,
      await this.configLoader.loadAgent(slug),
      this.agentMetadataMap,
    );
  }

  async listAgents(): Promise<AgentMetadata[]> {
    agentOps.add(1, { operation: 'list' });
    const [rawStored, defaults] = await Promise.all([
      this.configLoader.listAgents(),
      this.registryDefaults(),
    ]);
    // The listing carries `execution`, and a listing of the Station identity
    // read straight off the file is the same second-authority hole as a spec
    // read straight off the file.
    const stored = rawStored.map((agent) =>
      projectStationEngineBinding(agent.slug, agent, this.agentMetadataMap),
    );
    const storedEngineConnections = new Set(
      stored.map((agent) => agent.execution?.agentConnectionId).filter(Boolean),
    );
    // Persisted definitions win over aliases. A legacy Enable-created name
    // bound to a default connection suppresses that connection's phantom row.
    return [
      ...stored,
      ...defaults.filter(
        (agent) =>
          !stored.some((storedAgent) => storedAgent.slug === agent.slug) &&
          !(
            agent.execution?.agentConnectionId &&
            storedEngineConnections.has(agent.execution.agentConnectionId)
          ),
      ),
    ];
  }

  async getEnrichedAgents(
    coreAgents: Array<{ id: string; [key: string]: any }>,
  ): Promise<EnrichedAgent[]> {
    const enriched = await Promise.all(
      coreAgents.map(async (agent: { id: string; [key: string]: any }) => {
        const metadata = this.agentMetadataMap.get(agent.id);
        if (!metadata) return null;

        try {
          const spec = await this.getAgent(metadata.slug);
          return {
            ...agent,
            slug: metadata.slug,
            name: metadata.name,
            prompt: spec.prompt,
            description: spec.description,
            model: spec.model,
            region: spec.region,
            guardrails: spec.guardrails,
            maxSteps: spec.maxSteps,
            icon: spec.icon,
            commands: spec.commands,
            toolsConfig: spec.tools,
            execution: spec.execution,
            updatedAt: metadata.updatedAt,
            ...(spec.project !== undefined ? { project: spec.project } : {}),
          } as EnrichedAgent;
        } catch (e) {
          this.logger.warn('Agent spec not found, skipping', {
            agent: metadata.slug,
            error: e,
          });
          return null;
        }
      }),
    );
    const registered = enriched.filter((a): a is EnrichedAgent => a !== null);
    const registeredIds = new Set(registered.map((agent) => agent.slug));
    const defaults = await this.registryDefaults();
    for (const agent of defaults) {
      if (registeredIds.has(agent.slug)) continue;
      const readinessId =
        agent.slug === 'station'
          ? engineConnectionId('default')
          : agent.execution?.agentConnectionId;
      const readiness = readinessId
        ? await this.getRuntimeReadiness?.(readinessId)
        : undefined;
      registered.push({
        id: agent.slug,
        slug: agent.slug,
        name: agent.name,
        execution: agent.execution,
        available: readiness?.available ?? false,
        unavailableReason: readiness?.available
          ? undefined
          : (readiness?.reason ??
            (agent.slug === 'station'
              ? 'Station default Agent is not registered with the managed runtime.'
              : // archive#3742: a connection id is not a user noun, and this
                // path has no connection record to name — only the binding it
                // could not resolve. Say what is true instead.
                'The engine this agent runs on is not ready yet.')),
      });
    }
    return registered;
  }

  /**
   * Find-or-create the ONE persisted Agent bound to a detected engine's
   * connection — the single materialisation path every caller shares
   * (boot-time native adoption, ACP connect, the New Chat picker's Enable,
   * and first run's "Set up N" batch).
   *
   * It exists because those callers used to each mint their own definition:
   * boot projected a per-request phantom row while Enable POSTed a
   * separately-named "<engine> Agent" beside it, so one engine ended up with
   * two rows and neither path could see the other's. Resolving BOTH the
   * identity and the display name here — from the same registry projection
   * the catalog renders — is what makes a second call idempotent instead of
   * duplicating.
   *
   * Throws when `engineId` is not a registry engine identity: a caller must
   * not be able to mint an Agent for an arbitrary string through this door.
   */
  async materializeEngineAgent(
    engineId: string,
  ): Promise<{ slug: string; created: boolean; spec: AgentSpec }> {
    const defaults = await this.registryDefaults();
    const identity = defaults.find(
      (agent) =>
        agent.execution?.agentConnectionId === engineId ||
        agent.slug === engineId,
    );
    if (!identity) {
      throw new UnknownEngineIdentityError(engineId);
    }
    const { slug, created } = await materializeEngineAgentFile(
      this.configLoader,
      identity.slug,
      identity.name,
    );
    const spec = await this.configLoader.loadAgent(slug);
    if (created) agentOps.add(1, { operation: 'create', agent: slug });
    return { slug, created, spec };
  }

  async createAgent(
    body: Record<string, any>,
  ): Promise<{ slug: string; spec: AgentSpec }> {
    if (typeof body.slug === 'string') {
      await this.assertMutableAgent(body.slug);
    }
    // Resolved the way the loader will resolve it, not read off `body.slug`:
    // a create that omits the slug still lands on `agents/station/` when the
    // name is "Station", and the refusal must not be dodgeable by leaving the
    // field out.
    assertStationBindingNotSubmitted(resolvedCreateSlug(body), body);
    const { slug, spec } = await this.configLoader.createAgent(
      body as AgentSpec,
    );
    agentOps.add(1, { operation: 'create', agent: slug });
    return {
      slug,
      spec: projectStationEngineBinding(slug, spec, this.agentMetadataMap),
    };
  }

  async updateAgent(
    slug: string,
    updates: Record<string, any>,
  ): Promise<AgentSpec> {
    await this.assertMutableAgent(slug);
    assertStationBindingNotSubmitted(slug, updates);
    // Remove null values to allow unsetting optional fields — with two
    // scoped exceptions, both explicit CLEAR signals that
    // `config-loader-agents.ts`'s `updateAgentConfig` deletes the key for,
    // under the per-Agent persistence lock:
    //
    //  - `project: null` — the ownership-clearing signal (archive#1004 §4);
    //  - `execution: null` — the engine-clearing signal (archive#3662 review
    //    HIGH-2 / delta H2). Moving an Agent from Codex to Station's own
    //    engine means it must LOSE `execution.agentConnectionId`, and an
    //    omitted key cannot say that: `undefined` means "no change"
    //    downstream, so dropping the null here left the old Codex binding
    //    persisted after a save whose whole point was changing the engine.
    //    The editor emits exactly this null (`buildExecutionPayload`).
    //
    // Every other null-valued key is still dropped here.
    const CLEAR_SIGNAL_KEYS = new Set(['project', 'execution']);
    const filtered = Object.entries(updates).reduce(
      (acc, [key, value]) => {
        if (value !== null || CLEAR_SIGNAL_KEYS.has(key)) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, any>,
    );

    // Materialize virtual agents (like 'default') to disk on first save
    try {
      await this.configLoader.loadAgent(slug);
    } catch {
      // A from-scratch record has nothing to clear, and a persisted `null`
      // would be a second spelling of "absent" — the create path takes the
      // shape without the clear signals.
      const created = Object.fromEntries(
        Object.entries(filtered).filter(([, value]) => value !== null),
      );
      const seed = {
        slug,
        name: created.name || slug,
        ...created,
      } as unknown as Record<string, unknown>;
      await this.configLoader.createAgent(seed as unknown as AgentSpec);
      agentOps.add(1, { operation: 'materialize', agent: slug });
      return this.getAgent(slug);
    }

    const result = await this.configLoader.updateAgent(slug, filtered);
    agentOps.add(1, { operation: 'update', agent: slug });
    // The save response is a READ too: the editor loads it straight back into
    // its form and `agents.ts` validates capabilities against it, so it goes
    // through the same projection as every other read.
    return projectStationEngineBinding(slug, result, this.agentMetadataMap);
  }

  async deleteAgent(
    slug: string,
    beginMutation: () => void = () => undefined,
  ): Promise<{ success: boolean; error?: string }> {
    await this.assertMutableAgent(slug);
    const dependentLayouts = this.storageAdapter.findLayoutsUsingAgent(slug);
    if (dependentLayouts.length > 0) {
      return {
        success: false,
        error: `Cannot delete agent '${slug}' - it is referenced by project layouts: ${dependentLayouts.map(({ projectSlug, layoutSlug }) => `${projectSlug}/${layoutSlug}`).join(', ')}`,
      };
    }

    beginMutation();
    await this.configLoader.deleteAgent(slug);
    agentOps.add(1, { operation: 'delete', agent: slug });
    return { success: true };
  }

  /** Alias kept for existing callers; `getAgent` is the name of the seam. */
  async loadAgentSpec(slug: string): Promise<AgentSpec> {
    return this.getAgent(slug);
  }

  getActiveAgent(slug: string): Agent | undefined {
    return this.activeAgents.get(slug);
  }

  isAgentActive(slug: string): boolean {
    return this.activeAgents.has(slug);
  }
}
