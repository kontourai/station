/**
 * Agent Routes - CRUD operations for agents
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  type AgentEngineValidationFinding,
  type AuthoredCapabilityFlags,
  agentEngineValidationFindings,
} from '@kontourai/station-contracts/agent-validation';
import { resolveEngineCapabilityMatrix } from '@kontourai/station-contracts/engine-capability-matrix';
import {
  type AgentOwnershipFinding,
  agentOwnershipFinding,
} from '@kontourai/station-contracts/project-reference-integrity';
import { Hono } from 'hono';
import { isExternalEngineBoundAgent } from '../../runtime/agents/agent-engine-classification.js';
import type { AgentConfigurationMutationRunner } from '../../runtime/types.js';
import {
  type AgentService,
  type EnrichedAgent,
  StationEngineIsAppSettingError,
} from '../../services/agents/agent-service.js';
import type { SkillService } from '../../services/agents/skill-service.js';
import { agentOps } from '../../telemetry/metrics.js';
import {
  agentCreateSchema,
  agentMaterializeEngineSchema,
  agentUpdateSchema,
  errorMessage,
  getBody,
  param,
  validate,
} from '../schemas/schemas.js';
import {
  type ConfigurationMutationResult,
  captureConfigurationMutation,
  configurationActivationPayload,
  configurationMutationStatus,
} from '../system/configuration-activation.js';
import type { RuntimeConnectionSummary } from './enriched-agents.js';

/**
 * Builds enriched-shaped entries for persisted agents that are NOT in the
 * registered (enriched) set — the agents that failed model resolution and were
 * silently dropped before registering with VoltAgent. Each is marked
 * `available: false` with the concrete resolution reason (or a generic
 * fallback when the resolver is absent) so it stops being invisible (#chat).
 *
 * archive#3121 — with one exception, because "not in the registered set" has
 * two causes, not one. An agent bound to an EXTERNAL engine (Claude Code,
 * Codex, an ACP connection) is deliberately skipped from VoltAgent
 * registration (`runtime-agent-registry.ts`, archive#954/#977), so it lands
 * here by design rather than by failure. `resolveAgentAvailability` is a
 * Station-engine model-resolution probe — "is there an enabled LLM provider
 * connection with a resolvable model" — and an external engine has no
 * model-provider concept at all, so running it on such a record reported a
 * perfectly runnable agent as `available: false, unavailableReason: 'No
 * enabled LLM provider connection is configured.'` on any home without a
 * model connection. That is what station-control's `list_agents` tool reads
 * (it forwards this route's body verbatim), so a delegating agent was told a
 * working agent was unavailable.
 *
 * The classification reuses `isExternalEngineBoundAgent` — the same
 * classifier the cold-boot registry and the reload lifecycle use to decide
 * this exact skip — rather than re-deriving the rule here.
 *
 * External-engine records therefore OMIT `available`/`unavailableReason`
 * entirely, which is the established "this route makes no availability
 * claim" shape (registered agents omit them too, and consumers key on
 * `available === false`). This route deliberately does no connection I/O on
 * the list path, so it cannot honestly evaluate external readiness: an
 * external agent whose bound connection is missing/disabled/unready is
 * simply not marked here. `GET /api/agents` (`enriched-agents.ts`) is the
 * authority on that — it short-circuits on connection readiness
 * (`isHonestlyAvailableConnectedAgent`) and derives the honest external
 * reason (`externalEngineUnavailableReason`) before any model reasoning.
 * Omitting a claim is strictly smaller than asserting a false one, and it
 * keeps this function's two callers (`GET /` here and `/api/boot`'s
 * aggregate in `runtime-routes.ts`) producing identical catalogs without
 * plumbing a connections fetcher into either.
 */
export async function deriveAgentCatalog(
  agentService: AgentService,
  enrichedAgents: EnrichedAgent[],
  resolveAgentAvailability?: (spec: AgentSpec) => string | null,
): Promise<EnrichedAgent[]> {
  const registeredSlugs = new Set(enrichedAgents.map((agent) => agent.slug));
  const storeAgents = await agentService.listAgents();
  const storeOnly: EnrichedAgent[] = [];
  for (const metadata of storeAgents) {
    if (registeredSlugs.has(metadata.slug)) {
      continue;
    }
    let spec: AgentSpec;
    try {
      spec = await agentService.loadAgentSpec(metadata.slug);
    } catch {
      continue;
    }
    const externalEngineBound = isExternalEngineBoundAgent(spec);
    const reason = externalEngineBound
      ? null
      : (resolveAgentAvailability?.(spec) ?? null);
    storeOnly.push({
      id: metadata.slug,
      slug: metadata.slug,
      name: metadata.name ?? spec.name ?? metadata.slug,
      prompt: spec.prompt,
      description: spec.description ?? metadata.description,
      model: spec.model,
      region: spec.region,
      guardrails: spec.guardrails,
      maxSteps: spec.maxSteps,
      icon: spec.icon,
      commands: spec.commands,
      toolsConfig: spec.tools,
      execution: spec.execution,
      updatedAt: metadata.updatedAt,
      ...(externalEngineBound
        ? {}
        : {
            available: false,
            unavailableReason: reason ?? 'Agent is not currently launchable.',
          }),
      ...(spec.project !== undefined ? { project: spec.project } : {}),
    });
  }
  return [...enrichedAgents, ...storeOnly];
}

function validateSkills(
  skills: string[] | undefined,
  skillService: SkillService,
): string | null {
  if (!skills || skills.length === 0) return null;
  const installed = new Set(skillService.listSkills().map((s) => s.name));
  const unknown = skills.filter((s) => !installed.has(s));
  if (unknown.length > 0) {
    return `Unknown skills: ${unknown.join(', ')}`;
  }
  return null;
}

export function createAgentRoutes(
  agentService: AgentService,
  skillService: SkillService,
  applyAgentConfigurationMutation: AgentConfigurationMutationRunner,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getVoltAgent: () => { getAgents(): any[] | Promise<any[]> } | undefined,
  /**
   * Returns the reason a persisted agent spec is not launchable (the model
   * resolution error), or `null` when it resolves. Threaded from the runtime
   * so `GET /` can surface store-only agents with a concrete
   * `unavailableReason` and `POST /` can attach a non-blocking warning, both
   * without changing model-resolution semantics (#chat). Optional so unit
   * tests can omit it; when absent, store-only agents fall back to a generic
   * unavailable reason.
   */
  resolveAgentAvailability?: (spec: AgentSpec) => string | null,
  /**
   * Station#975 (unification) D-3: fetches the current runtime
   * (agent-engine) connections so POST/PUT can compute
   * `validation.findings` — capability surfaces the saved spec authors
   * that its bound engine cannot deliver (the same pure
   * `agentEngineValidationFindings` the editor uses, so the messages are
   * byte-identical). Optional so unit tests can omit it; when absent, the
   * response omits `validation` entirely (this feature was never asked
   * for). When it IS provided but the fetch rejects or doesn't settle
   * within the bound below, the response is additively honest about that
   * rather than silently indistinguishable from "nothing undeliverable":
   * `validation: { findings: [], degraded: true }` — `findings: []` here
   * means "unknown", not "verified clean". `validation` is omitted only
   * when the fetch actually succeeded and found nothing undeliverable.
   * Never a 500 or a stalled save either way — attribution is a
   * nice-to-have on top of an already-saved agent, matching
   * `enriched-agents.ts`'s `safeRuntimeConnections` fail-open discipline.
   * The timeout matters specifically here (unlike the GET list route):
   * `listRuntimeConnections()` can do live host discovery, and this
   * dependency now sits on the POST/PUT hot path — a slow or wedged probe
   * must never hold the actual agent-save response hostage. The
   * underlying fetch is also single-flighted (see
   * `sharedRuntimeConnectionsFetch` below): concurrent/back-to-back saves
   * while one discovery call is already in flight reuse it instead of
   * each starting their own, so a wedged probe can't accumulate duplicate
   * wedged work under repeated saves.
   */
  getRuntimeConnections?: () => Promise<RuntimeConnectionSummary[]>,
  /**
   * §3.3 orphan visibility (archive#1004, unification slice 7): known
   * project slugs, used to append an ownership finding to a save response
   * when the saved spec's `project` names a nonexistent project (the A1
   * preserved-orphan case — save-time already allowed it; this surfaces
   * it). Optional so unit tests can omit it; fail-open on a fetch failure
   * (same discipline as `getRuntimeConnections` above) — never a 500, the
   * finding is simply omitted.
   */
  getProjectSlugs?: () => string[] | Promise<string[]>,
) {
  const app = new Hono();

  const VALIDATION_FINDINGS_TIMEOUT_MS = 2_000;

  // Single-flight state for the raw (un-raced) `getRuntimeConnections()`
  // call — module-instance-scoped (one per `createAgentRoutes(...)` app),
  // not per-request, so overlapping requests share it.
  let inFlightConnectionsFetch: Promise<RuntimeConnectionSummary[]> | null =
    null;

  function sharedRuntimeConnectionsFetch(): Promise<
    RuntimeConnectionSummary[]
  > {
    if (!inFlightConnectionsFetch) {
      // Non-null: only called from computeValidationOutcome, which already
      // checked getRuntimeConnections truthy before calling this.
      const fetchPromise = getRuntimeConnections!();
      inFlightConnectionsFetch = fetchPromise;
      // Always clears (fulfilled or rejected), so the NEXT save after this
      // one settles starts a fresh fetch rather than reusing a stale
      // result forever. Also swallows a rejection here so it's never
      // "unhandled" even if every racing caller already moved on via the
      // timeout branch below.
      fetchPromise
        .catch(() => {})
        .finally(() => {
          if (inFlightConnectionsFetch === fetchPromise) {
            inFlightConnectionsFetch = null;
          }
        });
    }
    return inFlightConnectionsFetch;
  }

  type ValidationOutcome =
    | { kind: 'omit' }
    | { kind: 'findings'; findings: AgentEngineValidationFinding[] }
    | { kind: 'degraded' };

  async function computeValidationOutcome(
    spec: AgentSpec,
  ): Promise<ValidationOutcome> {
    if (!getRuntimeConnections) return { kind: 'omit' };
    let connections: RuntimeConnectionSummary[] | null;
    try {
      connections = await Promise.race([
        sharedRuntimeConnectionsFetch(),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), VALIDATION_FINDINGS_TIMEOUT_MS),
        ),
      ]);
    } catch {
      connections = null;
    }
    if (!connections) {
      return { kind: 'degraded' };
    }
    const agentConnectionId = spec.execution?.agentConnectionId;
    const connection = agentConnectionId
      ? connections.find((entry) => entry.id === agentConnectionId)
      : undefined;
    const matrix = resolveEngineCapabilityMatrix(agentConnectionId, connection);
    const authored: AuthoredCapabilityFlags = {
      prompt: !!spec.prompt?.trim(),
      skills: !!spec.skills && spec.skills.length > 0,
      tools: !!spec.tools?.mcpServers && spec.tools.mcpServers.length > 0,
      commands: !!spec.commands && Object.keys(spec.commands).length > 0,
    };
    const engineDisplayName = connection?.name || matrix.engineId;
    const findings = agentEngineValidationFindings(
      matrix,
      authored,
      engineDisplayName,
    );
    return findings.length > 0
      ? { kind: 'findings', findings }
      : { kind: 'omit' };
  }

  /**
   * §3.3 orphan visibility fail-open: `undefined` means "unknown — omit the
   * finding", distinct from a real, empty project catalog (`[]`, which
   * would legitimately orphan-mark every owned agent). Same
   * degrade-never-hide discipline as `enriched-agents.ts`'s
   * `safeProjectSlugs`.
   */
  async function safeProjectSlugsForSave(): Promise<Set<string> | undefined> {
    if (!getProjectSlugs) return undefined;
    try {
      return new Set(await getProjectSlugs());
    } catch {
      return undefined;
    }
  }

  async function computeOwnershipFinding(
    spec: AgentSpec,
  ): Promise<AgentOwnershipFinding | undefined> {
    const knownProjectSlugs = await safeProjectSlugsForSave();
    if (!knownProjectSlugs) return undefined;
    return agentOwnershipFinding(spec.project, knownProjectSlugs);
  }

  function validationPayload(
    outcome: ValidationOutcome,
    ownershipFinding?: AgentOwnershipFinding,
  ):
    | {
        validation: {
          findings: (AgentEngineValidationFinding | AgentOwnershipFinding)[];
          degraded?: true;
        };
      }
    | Record<string, never> {
    if (outcome.kind === 'degraded') {
      return {
        validation: {
          findings: ownershipFinding ? [ownershipFinding] : [],
          degraded: true,
        },
      };
    }
    const findings: (AgentEngineValidationFinding | AgentOwnershipFinding)[] = [
      ...(outcome.kind === 'findings' ? outcome.findings : []),
      ...(ownershipFinding ? [ownershipFinding] : []),
    ];
    if (findings.length === 0) return {};
    return { validation: { findings } };
  }

  // List all agents (enriched registered set merged with the persisted store,
  // so agents that failed model resolution — and were therefore never
  // registered with VoltAgent — are still visible as `available: false`).
  app.get('/', async (c) => {
    try {
      const voltAgent = getVoltAgent();
      if (!voltAgent) {
        return c.json(
          { success: false, error: 'VoltAgent not initialized' },
          500,
        );
      }
      const coreAgents = await voltAgent.getAgents();
      const enrichedAgents = await agentService.getEnrichedAgents(coreAgents);
      const agents = await deriveAgentCatalog(
        agentService,
        enrichedAgents,
        resolveAgentAvailability,
      );
      return c.json({
        success: true,
        data: agents,
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  /**
   * The status a failed Agent mutation deserves.
   *
   * 400 stays the default — a malformed or unacceptable body. A submitted
   * engine binding for the reserved `station` identity is different: the
   * request is well-formed, it just names a field this identity does not own
   * (archive#3662 delta-2 HIGH), so it is a CONFLICT with the app-level
   * setting that does own it. The distinction matters to a client: 400 says
   * "fix your payload", 409 says "this value lives somewhere else", and the
   * message names where.
   */
  function mutationErrorStatus(error: unknown): 400 | 409 {
    return error instanceof StationEngineIsAppSettingError ? 409 : 400;
  }

  // Create new agent
  app.post('/', validate(agentCreateSchema), async (c) => {
    try {
      const body = getBody(c);
      const skillError = validateSkills(body.skills, skillService);
      if (skillError) {
        return c.json({ success: false, error: skillError }, 400);
      }
      const mutation = await captureConfigurationMutation(
        applyAgentConfigurationMutation,
        (beginMutation) => {
          beginMutation();
          return agentService.createAgent(body);
        },
        {
          resolveAgentSlug: (created) => created.slug,
          // DEFER, as every agent mutation does. An earlier round switched
          // this to 'wait' so `GET /agents/:slug/tools` would answer 200
          // straight away; that moved runtime activation inside the
          // serialized configuration queues, where a stalled activation
          // wedges every later mutation and shutdown. The 409 that motivated
          // it is solved where it actually lives instead: the runtime records
          // the slug as awaiting reconciliation, and the tools route reports
          // 503 "activating" until it is live.
          activationMode: 'defer',
        },
      );
      const { slug, spec: created } = mutation.value;
      agentOps.add(1, { op: 'create' });
      // The create itself succeeds even when the new spec won't resolve a
      // launchable model — but surface a non-blocking warning so the user
      // isn't left wondering why the agent never appears as chattable (#chat).
      //
      // archive#3121: the probe behind `resolveAgentAvailability`
      // (`resolveManagedAvailabilityReason`) resolves a STATION-ENGINE model
      // identity, so it reports "No enabled LLM provider connection is
      // configured." for a spec that never wanted one. Applied
      // unconditionally, every Agent bound to Claude Code/Codex/ACP created on
      // a home with no LLM provider — the whole population of the picker's
      // Enable and the first-run engines chapter — was warned "saved but not
      // launchable" while `GET /agents` reported that same Agent available,
      // because the enriched projection serves it and `deriveAgentCatalog`
      // only applies this reason to store-only records. Same skip, same shared
      // classifier, as the cold-boot registry and the reload lifecycle
      // (archive#977) — an external-engine-bound record has no Station-engine
      // model to resolve, so the probe has nothing to say about it.
      const unavailableReason = isExternalEngineBoundAgent(created)
        ? null
        : (resolveAgentAvailability?.(created) ?? null);
      const warnings = unavailableReason
        ? [`Agent saved but not launchable: ${unavailableReason}`]
        : undefined;
      // Station#975 D-3: save stays 2xx — a definition is portable data
      // even when the bound engine can't deliver every authored surface.
      const [validationOutcome, ownershipFinding] = await Promise.all([
        computeValidationOutcome(created),
        computeOwnershipFinding(created),
      ]);
      return c.json(
        {
          success: true,
          data: { slug, ...created },
          ...(warnings ? { warnings } : {}),
          ...validationPayload(validationOutcome, ownershipFinding),
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 201),
      );
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        mutationErrorStatus(error),
      );
    }
  });

  /**
   * Materialize a detected engine's Agent — find-or-create, one row per
   * engine (archive#3027 follow-up).
   *
   * Every "turn this engine on" affordance posts HERE rather than POSTing a
   * hand-built definition: the picker's Enable, first run's "Set up N", and
   * (through the same service call) boot-time adoption and ACP connect. A
   * caller that built its own draft had to invent a name, and the name it
   * invented ("Claude Code Agent") became a SECOND row beside the engine's
   * own. Naming and identity are resolved from the registry projection
   * inside the service, so a second call from any surface — or a second
   * device — returns the existing row instead of creating a sibling.
   */
  app.post(
    '/materialize-engine',
    validate(agentMaterializeEngineSchema),
    async (c) => {
      try {
        const { engineId } = getBody(c) as { engineId: string };
        const mutation = await captureConfigurationMutation(
          applyAgentConfigurationMutation,
          (beginMutation) => {
            beginMutation();
            return agentService.materializeEngineAgent(engineId);
          },
          {
            resolveAgentSlug: (result) => result.slug,
            // Same as `POST /`: the durable write returns immediately and the
            // row reports "activating" until reconciliation makes it live.
            activationMode: 'defer',
          },
        );
        const { slug, created, spec } = mutation.value;
        if (created) agentOps.add(1, { op: 'create' });
        // Same non-blocking warning derivation as `POST /`, including its
        // archive#3121 skip: an external-engine-bound spec has no
        // Station-engine model to resolve, so probing it would manufacture a
        // false "not launchable" for the whole population this route serves.
        // It is not dead code — the `station` identity IS Station-engine
        // bound, and on a home with no LLM provider connection this is the
        // only place that says so.
        const unavailableReason = isExternalEngineBoundAgent(spec)
          ? null
          : (resolveAgentAvailability?.(spec) ?? null);
        const warnings = unavailableReason
          ? [`Agent saved but not launchable: ${unavailableReason}`]
          : undefined;
        return c.json(
          {
            success: true,
            data: { slug, ...spec },
            created,
            ...(warnings ? { warnings } : {}),
            ...configurationActivationPayload(mutation.activation),
          },
          configurationMutationStatus(mutation.activation, created ? 201 : 200),
        );
      } catch (error: unknown) {
        return c.json({ success: false, error: errorMessage(error) }, 400);
      }
    },
  );

  // Update existing agent
  app.put('/:slug', validate(agentUpdateSchema), async (c) => {
    try {
      const slug = param(c, 'slug');
      const updates = getBody(c);
      const skillError = validateSkills(updates.skills, skillService);
      if (skillError) {
        return c.json({ success: false, error: skillError }, 400);
      }
      const mutation = await captureConfigurationMutation(
        applyAgentConfigurationMutation,
        (beginMutation) => {
          beginMutation();
          return agentService.updateAgent(slug, updates);
        },
        { resolveAgentSlug: () => slug, activationMode: 'defer' },
      );
      agentOps.add(1, { op: 'update' });
      const [validationOutcome, ownershipFinding] = await Promise.all([
        computeValidationOutcome(mutation.value),
        computeOwnershipFinding(mutation.value),
      ]);
      return c.json(
        {
          success: true,
          data: mutation.value,
          ...validationPayload(validationOutcome, ownershipFinding),
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      return c.json(
        { success: false, error: errorMessage(error) },
        mutationErrorStatus(error),
      );
    }
  });

  // Delete agent
  app.delete('/:slug', async (c) => {
    const slug = param(c, 'slug');
    try {
      const mutation: ConfigurationMutationResult<{
        success: boolean;
        error?: string;
      }> = await captureConfigurationMutation(
        applyAgentConfigurationMutation,
        (beginMutation) => agentService.deleteAgent(slug, beginMutation),
        { resolveAgentSlug: () => slug, activationMode: 'defer' },
      );

      const result = mutation.value;
      if (!result.success) {
        return c.json({ success: false, error: result.error }, 400);
      }
      agentOps.add(1, { op: 'delete' });
      return c.json(
        {
          success: true,
          ...configurationActivationPayload(mutation.activation),
        },
        configurationMutationStatus(mutation.activation, 200),
      );
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  return app;
}
