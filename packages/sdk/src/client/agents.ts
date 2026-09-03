/**
 * Canonical agent-CRUD + list fetchers (#167 Wave 1). One HTTP-call
 * implementation per operation, shared by the SDK's `agentAdmin.ts` hooks
 * (thin wrappers around these), `packages/cli`'s `agents` verbs, and
 * `station-control-agent-tools.ts`.
 */
import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

export interface AgentEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** Stable machine-readable refusal cause, when the route provides one. */
  code?: string;
  /**
   * Present when the runtime is mid-reconciliation and the catalog was
   * served from the last stable read (station#1574). `catalogAsOf` carries
   * that read's capture time so consumers can render staleness honestly.
   */
  catalogState?: 'reconciling';
  catalogAsOf?: string;
}

/** An Agent route refusal whose stable code is safe for callers to branch on. */
export type AgentResponseError = Error & { readonly code?: string };

function agentResponseError(
  result: AgentEnvelope<unknown>,
  fallback: string,
): AgentResponseError {
  return Object.assign(new Error(apiErrorMessage(result, fallback)), {
    code: result.code,
  });
}

/**
 * `GET /api/agents` — the enriched agents list (VoltAgent data + display
 * metadata). Used by the SDK's `useAgentsQuery` hook and by the CLI's
 * `agents list` verb (`packages/cli/src/commands/core.ts`,
 * `resourceSpecs.agents.collectionPath`). Distinct from `fetchAgentsBare`
 * below by design — see the #167 plan's "Plan" section: the audit found two
 * genuinely different "list agents" shapes server-side and #167 is a
 * client-refactor, not a route-reconciliation PR, so both fetchers stay.
 */
export interface AgentCatalogProjection {
  agents: EnrichedAgentProjection[];
  /**
   * `'reconciling'` means these rows came from the LAST STABLE catalog, not
   * from a read of the runtime as it is now (station#1574 — the route serves
   * a snapshot rather than blocking). Their readiness words describe a
   * configuration that may already be gone.
   */
  catalogState?: 'reconciling';
  /** When that snapshot was captured. Absent on a live read. */
  catalogAsOf?: string;
}

/**
 * station#3751: the envelope, not just its `data`.
 *
 * `fetchAgentsEnriched` returned `Promise<EnrichedAgentProjection[]>` — an
 * array with nowhere to carry `catalogState`, so the flag the route has
 * emitted since #1574 was read off the wire and dropped one line later. The
 * Agents rail then rendered a stale snapshot's readiness words with nothing
 * saying they were stale: on a cold start an agent bound to a MISSING engine
 * reads "Ready" until the enriched projection answers. A state word rendered
 * before the server computed it, because the field that says so had no way
 * through the client.
 */
export async function fetchAgentCatalog(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<AgentCatalogProjection> {
  const response = await getJson(`${apiBase}/api/agents`, opts);
  const result = (await response.json()) as AgentEnvelope<
    EnrichedAgentProjection[]
  >;
  if (!result.success) {
    throw new Error(result.error);
  }
  return toAgentCatalogProjection(result);
}

/**
 * The ONE envelope → `['agents']` cache-value derivation (station#3824).
 *
 * `useAgentsQuery` caches an `AgentCatalogProjection` and reads `data.agents`
 * off it. `seedBootPayload` wrote `/api/boot`'s agents section straight into
 * the same key, and since #3751 changed that cached shape from a bare array
 * to this projection, the seeded value no longer had an `.agents` — so the
 * accelerator seeded a value the hook could not read, and the Agents rail was
 * EMPTY at first paint until `/api/agents` answered. That is the exact window
 * the boot payload exists to close.
 *
 * A second copy of this mapping is what let the two drift apart, so both the
 * fetcher above and the boot seeder call this instead of spreading the
 * envelope themselves. `catalogState`/`catalogAsOf` are omitted when the
 * envelope does not carry them — absent means "live read" (see the type), and
 * a caller that did not compute staleness must not assert freshness either
 * way; it simply makes no claim.
 */
export function toAgentCatalogProjection(
  envelope: Pick<
    AgentEnvelope<EnrichedAgentProjection[]>,
    'data' | 'catalogState' | 'catalogAsOf'
  >,
): AgentCatalogProjection {
  return {
    agents: envelope.data ?? [],
    ...(envelope.catalogState ? { catalogState: envelope.catalogState } : {}),
    ...(envelope.catalogAsOf ? { catalogAsOf: envelope.catalogAsOf } : {}),
  };
}

export async function fetchAgentsEnriched(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<EnrichedAgentProjection[]> {
  return (await fetchAgentCatalog(apiBase, opts)).agents;
}

/**
 * `GET /agents` — the bare/raw VoltAgent listing. Only
 * `station-control-agent-tools.ts`'s `list_agents` tool calls this today,
 * via `api('/agents')`, which forwards the parsed JSON body untouched
 * (no success/throw check) as the MCP tool result. This fetcher preserves
 * that exact raw-passthrough contract rather than introducing a new
 * throw-on-failure behavior for station-control's only consumer of this
 * route; a Wave 2B/3 caller that instead wants unwrap-or-throw semantics
 * should not assume this fetcher provides them.
 */
export async function fetchAgentsBare(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await getJson(`${apiBase}/agents`, opts);
  return response.json();
}

/**
 * `GET /api/agents/:slug` — the enriched single-agent lookup used by the
 * CLI's `agents get` verb (`core.ts`, `resourceSpecs.agents.getPath`), which
 * dispatches through `requestJson` (unwrap success/data, else throw
 * `error || message || 'Request failed with HTTP <status>'`). No SDK hook
 * or station-control tool calls this exact route today (station-control's
 * `get_agent` hits the bare `/agents/:slug` CRUD route instead — flagged as
 * a plan-drift note for Wave 2B, not folded in here since the plan's task
 * text for this wave does not name a bare single-agent-get fetcher).
 */
export async function getAgent(
  apiBase: string,
  slug: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await getJson(
    `${apiBase}/api/agents/${encodeURIComponent(slug)}`,
    opts,
  );
  let payload: AgentEnvelope<unknown> | null = null;
  try {
    payload = (await response.json()) as AgentEnvelope<unknown>;
  } catch {
    if (!response.ok) {
      throw new Error(`Request failed with HTTP ${response.status}`);
    }
    throw new Error('Expected JSON response');
  }
  if (!response.ok || !payload.success) {
    throw new Error(
      apiErrorMessage(payload, `Request failed with HTTP ${response.status}`),
    );
  }
  return payload.data;
}

/**
 * `POST /agents` — create an agent. Consumed (post-#167) by the SDK's
 * `createAgent` (thin wrapper, exact original default error preserved),
 * the CLI's `agents create` verb, and station-control's `create_agent` tool
 * (which forwards the raw envelope today via `api()` — Wave 2B must adapt
 * that call site to catch this function's thrown errors, since this
 * fetcher preserves the SDK's original unwrap-or-throw contract rather than
 * station-control's raw-passthrough one).
 */
export interface AgentCreateResult {
  /** The created spec (`{ slug, ...spec }`), as `createAgentRaw` returns. */
  data: unknown;
  /**
   * Non-blocking server warnings from the create envelope (e.g. "Agent
   * saved but not launchable: …"). The save itself stays 2xx — a definition
   * is portable data even when it cannot launch — so a caller that starts a
   * session off the create response must read these (station#3027 Enable).
   */
  warnings?: string[];
}

/** `POST /agents` preserving the envelope's non-blocking `warnings`. */
export async function createAgentDetailed(
  apiBase: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<AgentCreateResult> {
  const response = await mutateJson(`${apiBase}/agents`, 'POST', opts, body);
  const result = (await response.json()) as AgentEnvelope<unknown> & {
    warnings?: string[];
  };
  if (!result.success) {
    throw agentResponseError(result, 'Failed to create agent');
  }
  return {
    data: result.data,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}

/**
 * `POST /agents/materialize-engine` — find-or-create the ONE Agent bound to
 * a detected engine's connection. `created` distinguishes "this call made
 * it" from "it already existed", which is what lets a batch report honestly
 * without a second read.
 */
export async function materializeEngineAgent(
  apiBase: string,
  engineId: string,
  opts?: ClientRequestOptions,
): Promise<{ data: unknown; created: boolean; warnings?: string[] }> {
  const response = await mutateJson(
    `${apiBase}/agents/materialize-engine`,
    'POST',
    opts,
    { engineId },
  );
  const result = (await response.json()) as AgentEnvelope<unknown> & {
    created?: boolean;
    warnings?: string[];
  };
  if (!result.success) {
    throw agentResponseError(result, 'Failed to set up engine agent');
  }
  return {
    data: result.data,
    created: result.created === true,
    ...(result.warnings ? { warnings: result.warnings } : {}),
  };
}

export async function createAgentRaw(
  apiBase: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  return (await createAgentDetailed(apiBase, body, opts)).data;
}

/** `PUT /agents/:slug` — update an agent. See `createAgentRaw` docblock for
 * the same SDK-unwrap-or-throw-vs-station-control-raw-passthrough note. */
export async function updateAgentRaw(
  apiBase: string,
  slug: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await mutateJson(
    `${apiBase}/agents/${encodeURIComponent(slug)}`,
    'PUT',
    opts,
    body,
  );
  const result = (await response.json()) as AgentEnvelope<unknown>;
  if (!result.success) {
    throw agentResponseError(result, 'Failed to update agent');
  }
  return result.data;
}

/** `DELETE /agents/:slug` — delete an agent. See `createAgentRaw` docblock. */
export async function deleteAgentRaw(
  apiBase: string,
  slug: string,
  opts?: ClientRequestOptions,
): Promise<unknown> {
  const response = await mutateJson(
    `${apiBase}/agents/${encodeURIComponent(slug)}`,
    'DELETE',
    opts,
  );
  const result = (await response.json()) as AgentEnvelope<unknown>;
  if (!result.success) {
    throw agentResponseError(result, 'Failed to delete agent');
  }
  return result.data;
}
