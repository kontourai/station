/** Registry-backed enriched Agent catalog routes. */

import {
  type AgentSpec,
  delegationDeniedCommandCatalog,
} from '@kontourai/station-contracts/agent';
import {
  agentId,
  type EngineConnectionId,
  type EngineId,
  engineId,
  isStationAgentIdentity,
} from '@kontourai/station-contracts/agent-identity';
import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import { agentOwnershipFinding } from '@kontourai/station-contracts/project-reference-integrity';
import { Hono } from 'hono';
import { selectEngineAgentAdoption } from '../../domain/agent-registry.js';
import type { AgentMetadata } from '../../services/agents/agent-service.js';
import { sessionAgentStartUnavailableReason } from '../../services/orchestration/session-agent-resolution.js';
import type { Logger } from '../../utils/logger.js';
import { errorMessage, param } from '../schemas/schemas.js';

export interface RuntimeConnectionSummary {
  id: EngineConnectionId;
  type?: string;
  /** Adapter provider used by the execution-target resolver at dispatch. */
  provider?: string;
  name: string;
  description?: string;
  status: string;
  enabled: boolean;
  defaultModel?: string;
  engineId?: EngineId;
  readinessReason?: string;
}

type UnavailableFix = NonNullable<EnrichedAgentProjection['unavailableFix']>;

/**
 * The one projection from a live runtime connection to the summary this
 * route family consumes.
 *
 * archive#2845: there used to be two hand-maintained copies of this mapping
 * in `runtime-routes.ts` — one feeding `/api/agents`, one feeding
 * save-response validation. Adding `provider` to only the second left the
 * catalog reading `provider: undefined`, which silently disabled the very
 * readiness derivation that change existed to enable, while every test that
 * supplied `provider` by hand stayed green. One function, both call sites.
 */
export function runtimeConnectionSummary(connection: {
  id: EngineConnectionId;
  type?: string;
  name: string;
  enabled: boolean;
  status: string;
  config: Record<string, unknown>;
  readinessEvidence?: { summary?: string };
  parseEngineId: (value: unknown) => EngineId | undefined;
}): RuntimeConnectionSummary {
  return {
    id: connection.id,
    type: connection.type,
    provider:
      typeof connection.config.provider === 'string'
        ? connection.config.provider
        : undefined,
    name: connection.name,
    enabled: connection.enabled,
    status: connection.status,
    // Connection config is an untyped bag, so narrow the engine id before
    // projecting it onto registry-backed Agent rows.
    engineId: connection.parseEngineId(connection.config.engineId),
    readinessReason:
      connection.readinessEvidence?.summary ||
      (typeof connection.config.readinessReason === 'string'
        ? connection.config.readinessReason
        : undefined),
  };
}

export interface EnrichedAgentDeps {
  agentMetadataMap: Map<string, AgentMetadata>;
  activeAgents: Map<string, unknown>;
  /**
   * MUST be `AgentService.getAgent`, not `ConfigLoader.loadAgent` — the
   * service is where the reserved Station identity's engine binding is
   * projected (archive#3662 delta H3), and nothing in this route re-derives
   * it. `agent-binding-projection.test.ts` is the source guard on that.
   */
  loadAgent: (slug: string) => Promise<AgentSpec>;
  /** Registry-aware catalog (`AgentService.listAgents`). Same projection. */
  listAgents?: () => Promise<AgentMetadata[]>;
  /** Exact public ids owned by the registry. Runtime wiring must provide this. */
  getDefaultAgentIds?: () => Promise<ReadonlySet<string>>;
  defaultModel: string;
  defaultTools: { mcpServers: string[]; autoApprove: string[] };
  getRuntimeConnections: () => Promise<RuntimeConnectionSummary[]>;
  /** Runtime generation guard; reads never rebuild the runtime as a side effect. */
  getAgentConfigurationRevision?: () => number | null;
  /** Test override for the bounded optional attribution on detail reads. */
  detailAttributionTimeoutMs?: number;
  logger: Logger;
  resolveAvailability?: (spec: AgentSpec) => string | null;
  /** Why a repeatedly-failed activation was abandoned, per slug. */
  getActivationFailure?: (
    slug: string,
  ) => { reason: string; at: string } | undefined;
  listProjectSlugs?: () => string[] | Promise<string[]>;
}

export function isExternalEngineConnection(
  connection: RuntimeConnectionSummary,
): boolean {
  return (
    connection.type === 'acp' ||
    (connection.engineId != null && connection.engineId !== 'station')
  );
}

export function isHonestlyAvailableConnectedAgent(
  spec: AgentSpec,
  runtimeConnectionsById: Map<string, RuntimeConnectionSummary>,
): boolean {
  const agentConnectionId = spec.execution?.agentConnectionId;
  if (!agentConnectionId) return false;
  const connection = runtimeConnectionsById.get(agentConnectionId);
  return Boolean(
    connection?.enabled &&
      connection.status === 'ready' &&
      isExternalEngineConnection(connection),
  );
}

/**
 * Why this agent's engine cannot run it, in words a person can act on.
 *
 * archive#3742: every branch printed the connection ID — "Engine connection
 * 'e2e-nonexistent-engine' is not configured." went straight into the Agents
 * rail and the New Chat picker, where DESIGN's vocabulary rule says a
 * connection id is never a user noun. The connection carries the name its
 * owner gave it, so every branch that HAS the record uses it. The one branch
 * that does not — the record is missing, which is why that branch fires — says
 * what is true without naming the thing that is not there; the `fix` still
 * carries the id, which is what the repair route needs and what nobody reads.
 */
export function externalEngineUnavailable(
  id: string,
  runtimeConnectionsById: Map<string, RuntimeConnectionSummary>,
): { reason: string; fix: UnavailableFix } {
  const connection = runtimeConnectionsById.get(id);
  if (!connection) {
    return {
      reason: 'The engine this agent runs on is no longer connected.',
      fix: { kind: 'connection-broken', target: id },
    };
  }
  const engine = connection.name?.trim() || 'This agent\u2019s engine';
  if (!connection.enabled) {
    return {
      reason: `${engine} is turned off.`,
      fix: { kind: 'engine-disabled', target: id },
    };
  }
  if (connection.readinessReason) {
    return {
      reason: connection.readinessReason,
      fix: {
        kind:
          connection.status === 'missing_prerequisites'
            ? 'cli-missing'
            : 'connection-broken',
        target: id,
      },
    };
  }
  switch (connection.status) {
    case 'missing_prerequisites':
      return {
        reason: `${engine} is missing something it needs before it can run.`,
        fix: { kind: 'cli-missing', target: id },
      };
    case 'degraded':
      return {
        reason: `${engine} is only partly working.`,
        fix: { kind: 'connection-broken', target: id },
      };
    case 'error':
      return {
        reason: `${engine} failed its readiness check.`,
        fix: { kind: 'connection-broken', target: id },
      };
    case 'disconnected':
      return {
        reason: `${engine} is disconnected.`,
        fix: { kind: 'connection-broken', target: id },
      };
    case 'unavailable':
      return {
        reason: `${engine} is unavailable.`,
        fix: { kind: 'connection-broken', target: id },
      };
    case 'unprobed':
      return {
        reason: `${engine} has not been checked yet.`,
        fix: { kind: 'connection-broken', target: id },
      };
    default:
      // A status this function has no sentence for is still not an enum to
      // print at a person.
      return {
        reason: `${engine} is not ready.`,
        fix: { kind: 'connection-broken', target: id },
      };
  }
}
/**
 * How many stable-read attempts a catalog request makes before degrading, and
 * the pause between them. Reconciliation passes are sub-second, so two short
 * retries resolve ordinary drift; anything longer is the churn case that the
 * last-stable cache absorbs (archive#1574).
 */
const CATALOG_READ_ATTEMPTS = 3;
const CATALOG_RETRY_DELAY_MS = 150;
export const CATALOG_REFRESHING_REASON =
  'Agent catalog is refreshing after a configuration change; retrying automatically.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The catalog's two READ dependencies, bound to the service that owns the
 * Station-identity projection.
 *
 * A named function rather than two inline lambdas in `runtime-routes.ts`
 * because this wiring is the whole of archive#3662 delta H3: point
 * `loadAgent` at `ConfigLoader.loadAgent` instead and every reader of
 * `/api/agents` — list, detail, and `/:slug/binding`, which is what
 * `station chat` classifies from — silently goes back to reading the file.
 * As a function it can be TESTED (delta-2 MEDIUM: the previous guard was a
 * string match on the wiring line, which a comment could satisfy while the
 * production call was rebound).
 */
export function agentCatalogReadSeam(agentService: {
  getAgent: (slug: string) => Promise<AgentSpec>;
  listAgents: () => Promise<AgentMetadata[]>;
}): Pick<EnrichedAgentDeps, 'loadAgent' | 'listAgents'> {
  return {
    loadAgent: (slug) => agentService.getAgent(slug),
    listAgents: () => agentService.listAgents(),
  };
}

export function createEnrichedAgentRoutes(deps: EnrichedAgentDeps) {
  const app = new Hono();

  async function listMetadata(): Promise<AgentMetadata[]> {
    return deps.listAgents
      ? deps.listAgents()
      : Array.from(deps.agentMetadataMap.values());
  }

  async function defaultAgentIds(): Promise<ReadonlySet<string>> {
    return deps.getDefaultAgentIds?.() ?? new Set();
  }

  function defaultSpec(metadata: AgentMetadata): AgentSpec {
    const stationDefault = metadata.slug === 'station';
    return {
      name: metadata.name || metadata.slug,
      prompt: stationDefault
        ? (metadata.prompt ?? metadata.description ?? '')
        : '',
      description: metadata.description,
      ...(stationDefault
        ? { model: deps.defaultModel, tools: deps.defaultTools }
        : {}),
      execution: metadata.execution,
    };
  }

  function isActive(slug: string): boolean {
    // `station` is the public identity; the managed runtime retains an
    // explicit internal `default` binding until its implementation key can
    // be renamed independently.
    return (
      deps.activeAgents.has(slug) ||
      (slug === 'station' && deps.activeAgents.has('default'))
    );
  }

  function buildAgentPayload(
    metadata: AgentMetadata,
    spec: AgentSpec,
    runtimeConnectionsById: Map<string, RuntimeConnectionSummary>,
    knownProjectSlugs: ReadonlySet<string> | undefined,
    engineDefault: boolean,
  ): EnrichedAgentProjection {
    const agentConnectionId = spec.execution?.agentConnectionId;
    const connection = agentConnectionId
      ? runtimeConnectionsById.get(agentConnectionId)
      : undefined;
    const activationFailure = deps.getActivationFailure?.(metadata.slug);
    const ownership = knownProjectSlugs
      ? agentOwnershipFinding(spec.project, knownProjectSlugs)
      : undefined;
    return {
      slug: agentId(metadata.slug),
      name: metadata.name,
      prompt: spec.prompt,
      description: spec.description,
      ...(metadata.plugin ? { plugin: metadata.plugin } : {}),
      model: spec.model,
      region: spec.region,
      guardrails: spec.guardrails,
      maxSteps: spec.maxSteps,
      icon: spec.icon,
      commands: spec.commands,
      toolsConfig: spec.tools,
      execution: spec.execution,
      ...(spec.delegation ? { delegation: spec.delegation } : {}),
      deniedCommandCatalog: delegationDeniedCommandCatalog(
        spec.delegation?.blockedTools,
      ),
      skills: spec.skills,
      ...(spec.provenance ? { provenance: spec.provenance } : {}),
      ...(activationFailure ? { activationFailure } : {}),
      updatedAt: metadata.updatedAt,
      ...(engineDefault ? { engineDefault: true as const } : {}),
      ...(spec.project !== undefined ? { project: spec.project } : {}),
      ...(ownership ? { ownership: { findings: [ownership] } } : {}),
      ...(connection
        ? {
            engineId: connection.engineId,
            engineDisplayName: connection.name,
            ...(connection.type
              ? { engineConnectionType: connection.type }
              : {}),
          }
        : // archive#3662 review HIGH-3: only when this Agent really is on
          // Station's own engine. The fallback used to assert it from the
          // SLUG alone, so a home whose built-in engine is Codex still had
          // the detail read chip it "Station" whenever connection
          // attribution was unavailable (the detail path bounds it) — the
          // execution binding said codex and the label said otherwise.
          isStationAgentIdentity(metadata.slug) &&
            !spec.execution?.agentConnectionId
          ? { engineId: engineId('station'), engineDisplayName: 'Station' }
          : {}),
    };
  }

  async function safeRuntimeConnections(
    timeoutMs?: number,
  ): Promise<RuntimeConnectionSummary[] | null> {
    try {
      if (timeoutMs === undefined) return await deps.getRuntimeConnections();
      return await new Promise<RuntimeConnectionSummary[] | null>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            deps.logger.warn(
              'Runtime connection attribution timed out; continuing without it',
              { timeoutMs },
            );
            // A detail read deliberately bounds optional engine attribution so
            // the UI stays responsive during host discovery. `[]` remains an
            // authoritative empty catalog; `null` means attribution could not
            // be obtained. Treating both alike made configured external
            // engines appear "not configured" and blocked foreground chat.
            resolve(null);
          }, timeoutMs);
          deps.getRuntimeConnections().then(
            (connections) => {
              clearTimeout(timer);
              resolve(connections);
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error);
            },
          );
        },
      );
    } catch (error: unknown) {
      deps.logger.warn(
        'Failed to fetch runtime connections for Agent attribution; continuing without it',
        { error: errorMessage(error) },
      );
      return null;
    }
  }

  async function safeProjectSlugs(): Promise<Set<string> | undefined> {
    if (!deps.listProjectSlugs) return undefined;
    try {
      return new Set(await deps.listProjectSlugs());
    } catch (error: unknown) {
      deps.logger.warn(
        'Failed to fetch project slugs for Agent ownership attribution; continuing without orphan marking',
        { error: errorMessage(error) },
      );
      return undefined;
    }
  }

  async function resolvePayload(
    metadata: AgentMetadata,
    defaults: ReadonlySet<string>,
    runtimeConnectionsById: Map<string, RuntimeConnectionSummary>,
    knownProjectSlugs: ReadonlySet<string> | undefined,
    runtimeConfigurationCurrent: boolean,
    runtimeConnectionAttributionAvailable: boolean,
  ) {
    const registryDefault = defaults.has(metadata.slug);
    let engineDefault = false;
    let spec: AgentSpec;
    try {
      spec = await deps.loadAgent(metadata.slug);
    } catch (error: unknown) {
      if (!registryDefault) {
        deps.logger.warn('Agent spec not found, skipping', {
          agent: metadata.slug,
          error,
        });
        return null;
      }
      engineDefault = true;
      spec = defaultSpec(metadata);
    }

    // No Station-identity overlay here. `deps.loadAgent` IS
    // `AgentService.getAgent` and `deps.listAgents` IS
    // `AgentService.listAgents`, and both already carry the projection
    // (archive#3662 delta H3): for the reserved Station identity the RUNTIME
    // owns the engine binding, not the file. This route applied that overlay
    // itself in round 1, which is precisely what left `/:slug/binding` and the
    // save-response validation reading the raw record.

    const payload = buildAgentPayload(
      metadata,
      spec,
      runtimeConnectionsById,
      knownProjectSlugs,
      engineDefault,
    );
    const connection = spec.execution?.agentConnectionId
      ? runtimeConnectionsById.get(spec.execution.agentConnectionId)
      : undefined;
    const sessionAgentUnavailableReason = sessionAgentStartUnavailableReason({
      provider: connection?.provider,
      agentSlug: metadata.slug,
      // A successfully loaded authored spec and the narrow runtime-owned
      // Station identity are exactly the two sources the session resolver
      // can enrich. Registry connection aliases have neither.
      hasResolvedAgent: !engineDefault || metadata.slug === 'station',
      // archive#3027: symmetric across every engine default. Honest for an
      // existing alias-bound conversation too — enabling the engine creates
      // an authored Agent for NEW chats; it does not resurrect this thread.
      unresolvedReason: `Agent '${metadata.slug}' has no authored Agent definition, so Station cannot start new sessions or continue existing conversations with it. Enable this engine by creating an Agent for it — new chats will run as that Agent; existing conversations stay readable.`,
    });
    if (!runtimeConfigurationCurrent) {
      // Only reachable after every in-route retry found the runtime mid-change
      // AND no previously stable catalog exists to serve instead (archive#1574). The
      // copy must not promise a retry the caller would have to perform: the
      // route already retried, and it keeps retrying on subsequent requests.
      return {
        ...payload,
        available: false,
        unavailableReason: CATALOG_REFRESHING_REASON,
        unavailableFix: { kind: 'none' },
      };
    }
    // Detail attribution is intentionally time-bounded. An unavailable
    // attribution read cannot honestly negate a persisted external binding;
    // the execution resolver will perform its authoritative connection read
    // before starting a session.
    if (
      !runtimeConnectionAttributionAvailable &&
      spec.execution?.agentConnectionId
    ) {
      return payload;
    }
    if (sessionAgentUnavailableReason) {
      // The missing-authored-Agent refusal is independent of connection
      // health, but its repair is not: a ready engine can be materialized,
      // while a disabled, missing, or broken engine must be repaired first.
      // Project the connection's observed state rather than labelling every
      // alias "engine disabled" from the refusal prose.
      const unavailableConnectionFix =
        spec.execution?.agentConnectionId &&
        runtimeConnectionAttributionAvailable &&
        (!connection?.enabled || connection.status !== 'ready')
          ? externalEngineUnavailable(
              spec.execution.agentConnectionId,
              runtimeConnectionsById,
            ).fix
          : undefined;
      return {
        ...payload,
        available: false,
        unavailableReason: sessionAgentUnavailableReason,
        unavailableFix: unavailableConnectionFix ?? {
          // A usable connection with no authored Agent is the one state
          // where Enable is truthful. `enable` below is the stricter
          // machine-readable authorization for materialization.
          kind: 'engine-disabled',
          ...(connection ? { target: connection.id } : {}),
        },
        // archive#3027: the machine-readable remedy for exactly this refusal.
        // Only an engine-default alias whose bound connection is USABLE is
        // enableable — a dead/degraded connection would make the created
        // Agent equally unstartable, so `enable` would overclaim. Strict
        // 'ready' deliberately mirrors isHonestlyAvailableConnectedAgent's
        // readiness bar (which excludes 'degraded'). An authored Agent that
        // is unavailable for other reasons must never carry it.
        ...(engineDefault &&
        metadata.slug !== 'station' &&
        connection?.enabled &&
        connection.status === 'ready'
          ? { enable: { engineConnectionId: connection.id } }
          : {}),
      };
    }
    if (
      isActive(metadata.slug) ||
      isHonestlyAvailableConnectedAgent(spec, runtimeConnectionsById)
    ) {
      return payload;
    }
    const externalConnectionUnavailable =
      runtimeConnectionAttributionAvailable &&
      spec.execution?.agentConnectionId &&
      spec.execution.agentConnectionId !== 'default'
        ? externalEngineUnavailable(
            spec.execution.agentConnectionId,
            runtimeConnectionsById,
          )
        : null;
    const reason =
      externalConnectionUnavailable?.reason ??
      deps.resolveAvailability?.(spec) ??
      null;
    return {
      ...payload,
      available: false,
      unavailableReason: reason ?? 'Agent is not currently launchable.',
      unavailableFix: externalConnectionUnavailable?.fix ?? {
        kind: spec.execution?.agentConnectionId
          ? 'agent-configuration'
          : 'model-connection',
      },
    };
  }

  type CatalogEntry = NonNullable<Awaited<ReturnType<typeof resolvePayload>>>;

  /**
   * Name the duplicates. Two authored Agents can legitimately bind one engine
   * — a legacy Enable row beside a hand-made one, say — and Station never
   * deletes a user's file to resolve that. But the catalog rendered them as
   * two indistinguishable rows for one engine, and nothing said which one the
   * seeding path adopted.
   *
   * The canonical row is chosen by `selectEngineAgentAdoption`, the SAME
   * function `materializeEngineAgent` decides with, fed the same fields — so
   * the marker cannot disagree with the adoption. (This is why `provenance`
   * is carried on the projection: tier 1 needs it, and a second, weaker
   * derivation here would eventually contradict the first.)
   *
   * Full-list reads only: this is a statement about a SET, and a slug-filtered
   * read has no set to compare against. A detail pane that guessed from one
   * row would be asserting something it cannot see.
   */
  function markSecondaryBindings(agents: CatalogEntry[]): CatalogEntry[] {
    const byConnection = new Map<string, CatalogEntry[]>();
    for (const agent of agents) {
      const connectionId = agent.execution?.agentConnectionId;
      if (!connectionId) continue;
      const group = byConnection.get(connectionId);
      if (group) group.push(agent);
      else byConnection.set(connectionId, [agent]);
    }
    const secondary = new Map<string, string>();
    for (const [connectionId, group] of byConnection) {
      if (group.length < 2) continue;
      const displayName =
        group.find((agent) => agent.engineDisplayName)?.engineDisplayName ??
        connectionId;
      const { alsoBound } = selectEngineAgentAdoption(group, {
        id: connectionId,
        connectionId,
        displayName,
      });
      for (const agent of alsoBound) secondary.set(agent.slug, displayName);
    }
    if (secondary.size === 0) return agents;
    return agents.map((agent) => {
      const engineDisplayName = secondary.get(agent.slug);
      return engineDisplayName
        ? { ...agent, secondaryEngineBinding: { engineDisplayName } }
        : agent;
    });
  }

  /**
   * The most recent full catalog produced under a stable runtime generation.
   * Served (flagged, with its capture time) when the runtime stays
   * mid-reconciliation past the in-route retries: a moment-stale catalog
   * keeps chat startable, where the old behavior marked every agent
   * unavailable with a retry the route never performed (archive#1574). Only the
   * full-list read writes it (a slug-filtered read is a partial catalog),
   * a monotonic revision guard keeps a delayed older read from clobbering a
   * fresher snapshot, and entries past the max age degrade honestly instead
   * of masking a lasting configuration change.
   */
  let lastStableCatalog: {
    agents: CatalogEntry[];
    revision: number | null;
    capturedAtMs: number;
  } | null = null;
  const CATALOG_CACHE_MAX_AGE_MS = 5 * 60_000;

  async function readCatalogOnce(options: {
    attributionTimeoutMs?: number;
    slugFilter?: string;
  }): Promise<{
    agents: CatalogEntry[];
    stable: boolean;
    revision: number | null;
    /**
     * Whether the requested slug exists in metadata at all — distinct from
     * `agents.length`: a present slug whose spec load failed transiently
     * still deserves the retry loop, an absent slug never will.
     */
    slugKnown: boolean;
  }> {
    const expectedRuntimeConfigurationRevision =
      deps.getAgentConfigurationRevision?.() ?? null;
    const [metadata, defaults, runtimeConns, knownProjectSlugs] =
      await Promise.all([
        listMetadata(),
        defaultAgentIds(),
        safeRuntimeConnections(options.attributionTimeoutMs),
        safeProjectSlugs(),
      ]);
    const runtimeConnectionAttributionAvailable = runtimeConns !== null;
    const runtimeConnectionsById = new Map(
      (runtimeConns ?? []).map((connection) => [connection.id, connection]),
    );
    const stable = deps.getAgentConfigurationRevision
      ? expectedRuntimeConfigurationRevision !== null &&
        deps.getAgentConfigurationRevision() ===
          expectedRuntimeConfigurationRevision
      : true;
    const selected =
      options.slugFilter === undefined
        ? metadata
        : metadata.filter((agent) => agent.slug === options.slugFilter);
    const agents = (
      await Promise.all(
        selected.map((agent) =>
          resolvePayload(
            agent,
            defaults,
            runtimeConnectionsById,
            knownProjectSlugs,
            stable,
            runtimeConnectionAttributionAvailable,
          ),
        ),
      )
    ).filter((agent): agent is CatalogEntry => agent !== null);
    return {
      agents:
        options.slugFilter === undefined
          ? markSecondaryBindings(agents)
          : agents,
      stable,
      revision: expectedRuntimeConfigurationRevision,
      slugKnown: options.slugFilter === undefined || selected.length > 0,
    };
  }

  function cacheEntriesFor(slugFilter?: string): CatalogEntry[] | null {
    if (!lastStableCatalog) return null;
    if (Date.now() - lastStableCatalog.capturedAtMs > CATALOG_CACHE_MAX_AGE_MS)
      return null;
    if (slugFilter === undefined) return lastStableCatalog.agents;
    const entry = lastStableCatalog.agents.find(
      (agent) => agent.slug === slugFilter,
    );
    return entry ? [entry] : null;
  }

  async function readCatalogWithRetry(options: {
    attributionTimeoutMs?: number;
    slugFilter?: string;
  }): Promise<{
    agents: CatalogEntry[];
    stable: boolean;
    servedFromCache: boolean;
    catalogAsOf?: string;
  }> {
    let read = await readCatalogOnce(options);
    for (
      let attempt = 1;
      !read.stable &&
      // A slug the metadata does not even list cannot appear by retrying —
      // but a listed slug whose spec load failed transiently keeps its
      // retries (that is precisely the mid-write case worth riding out).
      read.slugKnown &&
      attempt < CATALOG_READ_ATTEMPTS;
      attempt += 1
    ) {
      await sleep(CATALOG_RETRY_DELAY_MS);
      read = await readCatalogOnce(options);
    }
    if (read.stable) {
      if (
        options.slugFilter === undefined &&
        (lastStableCatalog === null ||
          lastStableCatalog.revision === null ||
          read.revision === null ||
          read.revision >= lastStableCatalog.revision)
      ) {
        lastStableCatalog = {
          agents: read.agents,
          revision: read.revision,
          capturedAtMs: Date.now(),
        };
      }
      return { ...read, servedFromCache: false };
    }
    const cached = cacheEntriesFor(options.slugFilter);
    if (cached && lastStableCatalog) {
      deps.logger.warn(
        'Agent catalog unstable after retries; serving the last stable catalog',
      );
      return {
        agents: cached,
        stable: false,
        servedFromCache: true,
        // No fallback here: reporting a stale response as "as of now" would
        // be the exact lie this field exists to prevent.
        catalogAsOf: new Date(lastStableCatalog.capturedAtMs).toISOString(),
      };
    }
    return { ...read, servedFromCache: false };
  }

  app.get('/', async (c) => {
    try {
      const { agents, stable, catalogAsOf } = await readCatalogWithRetry({});
      return c.json({
        success: true,
        data: agents,
        // Additive fields (typed on the SDK envelope): a mid-refresh catalog
        // names its state and, when served from cache, its capture time.
        ...(stable ? {} : { catalogState: 'reconciling' as const }),
        ...(catalogAsOf ? { catalogAsOf } : {}),
      });
    } catch (error: unknown) {
      deps.logger.error('Failed to fetch agents', {
        error: errorMessage(error),
      });
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/:slug', async (c) => {
    const slug = param(c, 'slug');
    try {
      const { agents, stable, catalogAsOf } = await readCatalogWithRetry({
        attributionTimeoutMs: deps.detailAttributionTimeoutMs ?? 1_000,
        slugFilter: slug,
      });
      const payload = agents.find((agent) => agent.slug === slug);
      if (!payload) {
        return c.json({ success: false, error: 'Agent not found' }, 404);
      }
      return c.json({
        success: true,
        data: payload,
        ...(stable ? {} : { catalogState: 'reconciling' as const }),
        ...(catalogAsOf ? { catalogAsOf } : {}),
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/:slug/binding', async (c) => {
    const slug = param(c, 'slug');
    try {
      const [metadata, defaults] = await Promise.all([
        listMetadata(),
        defaultAgentIds(),
      ]);
      const selected = metadata.find((agent) => agent.slug === slug);
      if (!selected) {
        return c.json({ success: false, error: 'Agent not found' }, 404);
      }
      // archive#3662 delta M2: both branches now carry the Station-identity
      // projection — `listMetadata`/`loadAgent` are the service's, so this
      // endpoint can no longer answer with a binding the identity cannot have
      // (or "unbound" while the runtime runs it on Codex). `station chat`
      // picks its managed-vs-external session read model from this answer.
      const spec = defaults.has(slug)
        ? defaultSpec(selected)
        : await deps.loadAgent(slug);
      const agentConnectionId = spec.execution?.agentConnectionId;
      let engineId: EngineId | undefined;
      if (agentConnectionId) {
        const connections = await safeRuntimeConnections();
        engineId = connections?.find(
          (connection) => connection.id === agentConnectionId,
        )?.engineId;
      }
      return c.json({
        success: true,
        data: {
          ...(agentConnectionId ? { agentConnectionId } : {}),
          ...(engineId ? { engineId } : {}),
        },
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
