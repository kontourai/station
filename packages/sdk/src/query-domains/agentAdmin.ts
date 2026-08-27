import type {
  AppConfig,
  FirstRunState,
  FirstRunTransitionRequest,
} from '@kontourai/station-contracts/config';
import type { ConversationStatsResponse } from '@kontourai/station-contracts/runtime';
import type { SettingProvenanceEntry } from '@kontourai/station-contracts/settings-registry';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';

export {
  type UpdateAppLogLevelResult,
  updateAppLogLevel,
} from '../app-config';

import {
  type AgentCatalogProjection,
  type AgentCreateResult,
  createAgentDetailed as createAgentDetailedRaw,
  createAgentRaw,
  deleteAgentRaw,
  fetchAgentCatalog,
  materializeEngineAgent as materializeEngineAgentRaw,
  updateAgentRaw,
} from '../client/agents';

import {
  type MutationOptions,
  type QueryConfig,
  useApiMutation,
  useApiQuery,
} from '../query-core';
import { agentQueries, isAgentToolsActivatingError } from '../queryFactories';
import { useTemplatesQuery as useWorkspaceTemplatesQuery } from './acpWorkspace';

export type { AgentCreateResult } from '../client/agents';

export interface AgentTemplate {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  source?: string;
  form?: Record<string, unknown>;
}

export async function createAgent(
  agent: Record<string, unknown>,
): Promise<unknown> {
  const apiBase = await _getApiBase();
  return createAgentRaw(apiBase, agent);
}

/**
 * `createAgent` preserving the create envelope's non-blocking `warnings`
 * (station#3027 Enable). A separate function — not a change to
 * `createAgent`'s resolved shape — because `createAgent` is published SDK
 * surface and plugins reading the created spec off its result must keep
 * working.
 */
export async function createAgentDetailed(
  agent: Record<string, unknown>,
): Promise<AgentCreateResult> {
  const apiBase = await _getApiBase();
  return createAgentDetailedRaw(apiBase, agent);
}

/**
 * Find-or-create the Agent for a detected engine connection. The ONE
 * "turn this engine on" write — see the route's docblock for why every
 * caller shares it instead of POSTing its own draft definition.
 */
export async function materializeEngineAgent(
  engineId: string,
): Promise<{ data: unknown; created: boolean; warnings?: string[] }> {
  const apiBase = await _getApiBase();
  return materializeEngineAgentRaw(apiBase, engineId);
}

export async function updateAgent(
  slug: string,
  agent: Record<string, unknown>,
): Promise<unknown> {
  const apiBase = await _getApiBase();
  return updateAgentRaw(apiBase, slug, agent);
}

export async function deleteAgent(slug: string): Promise<unknown> {
  const apiBase = await _getApiBase();
  return deleteAgentRaw(apiBase, slug);
}

export async function submitToolApproval(
  approvalId: string,
  approved: boolean,
): Promise<{ success: boolean; error?: string }> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/tool-approval/${encodeURIComponent(approvalId)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    },
  );
  return (await response.json()) as { success: boolean; error?: string };
}

export function useUserQuery(alias: string, config?: QueryConfig<any>) {
  return useApiQuery(
    ['user', alias],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/users/${encodeURIComponent(alias)}`,
      );
      const result = await response.json();
      if (result.error && !result.name) {
        throw new Error(result.error);
      }
      return result;
    },
    config,
  );
}

/**
 * The agent catalog, WITH the envelope's own account of itself (station#3751).
 *
 * `['agents']` caches the projection rather than the bare array so
 * `catalogState` survives the trip to a component. `data` still projects the
 * array — every existing consumer reads it unchanged — and the two staleness
 * fields ride alongside it, so a surface can tell "these are this Station's
 * agents as they are" from "these are the last snapshot we had".
 */
export function useAgentsQuery(config?: QueryConfig<AgentCatalogProjection>) {
  const query = useApiQuery(
    ['agents'],
    async () => {
      const apiBase = await _getApiBase();
      return fetchAgentCatalog(apiBase);
    },
    config,
  );
  return {
    ...query,
    data: query.data?.agents,
    catalogState: query.data?.catalogState,
    catalogAsOf: query.data?.catalogAsOf,
  };
}

export function useCreateAgentMutation(
  options?: MutationOptions<unknown, Record<string, unknown>>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (agent: Record<string, unknown>) => createAgent(agent),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

/** `useCreateAgentMutation` resolving `AgentCreateResult` (see `createAgentDetailed`). */
export function useCreateAgentDetailedMutation(
  options?: MutationOptions<AgentCreateResult, Record<string, unknown>>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (agent: Record<string, unknown>) =>
      createAgentDetailed(agent),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

/**
 * `materializeEngineAgent` as a mutation, invalidating the agent catalog so
 * the newly-materialized row appears without a reload.
 */
export function useMaterializeEngineAgentMutation(
  options?: MutationOptions<
    { data: unknown; created: boolean; warnings?: string[] },
    string
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (engineId: string) => materializeEngineAgent(engineId),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useUpdateAgentMutation(
  options?: MutationOptions<
    unknown,
    { slug: string; agent: Record<string, unknown> }
  >,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      slug,
      agent,
    }: {
      slug: string;
      agent: Record<string, unknown>;
    }) => updateAgent(slug, agent),
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', variables.slug] });
      queryClient.invalidateQueries({
        queryKey: ['agent-tools', variables.slug],
      });
      options?.onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useDeleteAgentMutation(
  options?: MutationOptions<unknown, string>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (slug: string) => deleteAgent(slug),
    onSuccess: (data, slug) => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agent', slug] });
      queryClient.invalidateQueries({ queryKey: ['agent-tools', slug] });
      options?.onSuccess?.(data, slug);
    },
    onError: (error, slug) => {
      options?.onError?.(error as Error, slug);
    },
  });
}

export function useAgentQuery(
  agentSlug: string | undefined,
  config?: QueryConfig<any>,
) {
  return useQuery({
    ...agentQueries.agent(agentSlug!),
    ...config,
    enabled: !!agentSlug && (config?.enabled ?? true),
  });
}

export function useAgentTemplatesQuery(config?: QueryConfig<AgentTemplate[]>) {
  return useWorkspaceTemplatesQuery<AgentTemplate>('agent', config);
}

export function useModelsQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    // Dedicated safe catalog key: the broader `models` prefix also owns AWS
    // profile and pricing queries and therefore must not be persisted wholesale.
    ['model-catalog'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(`${apiBase}/api/models`);
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    config,
  );
}

export interface AwsProfilesResult {
  profiles: string[];
  available: boolean;
}

/**
 * Named AWS profile *names* parsed from `~/.aws/config`/`~/.aws/credentials`
 * (never secrets — see `src-server/providers/llm/aws-profiles.ts`), for the
 * Bedrock connection's "named profile" auth mode
 * (docs/design/connections-onboarding.md §3.1).
 */
export function useAwsProfilesQuery(config?: QueryConfig<AwsProfilesResult>) {
  return useApiQuery(
    ['models', 'aws-profiles'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/models/aws-profiles`,
      );
      const result = await response.json();
      if (!result.success) {
        throw new Error(apiErrorMessage(result, 'Failed to list AWS profiles'));
      }
      return result.data as AwsProfilesResult;
    },
    config,
  );
}

/**
 * How long the tools read keeps retrying an Agent that is still activating,
 * and how often. A create returns as soon as its write is durable, so the
 * first read after one lands mid-activation by design; retrying is the
 * difference between "the editor fills in a moment" and "the editor shows an
 * error for a state that is about to resolve itself". Bounded, because an
 * activation that never finishes must surface, not spin forever.
 */
export const AGENT_TOOLS_ACTIVATION_RETRY_MS = 15_000;
const AGENT_TOOLS_ACTIVATION_RETRY_INTERVAL_MS = 1_000;

export function useAgentToolsQuery(
  agentSlug: string | undefined,
  config?: QueryConfig<any>,
) {
  return useQuery({
    ...agentQueries.tools(agentSlug!),
    // Retry ONLY the activating case, and only within the window. Any other
    // failure keeps react-query's configured behaviour: a 409 is a real
    // answer, and retrying it would just delay saying so.
    retry: (failureCount: number, error: unknown) =>
      isAgentToolsActivatingError(error) &&
      failureCount <
        AGENT_TOOLS_ACTIVATION_RETRY_MS /
          AGENT_TOOLS_ACTIVATION_RETRY_INTERVAL_MS,
    retryDelay: AGENT_TOOLS_ACTIVATION_RETRY_INTERVAL_MS,
    ...config,
    enabled: !!agentSlug && (config?.enabled ?? true),
  });
}

/**
 * `GET /api/models/capabilities` with its provenance kept (station#3373).
 *
 * The endpoint projects one catalogue — Bedrock's `ListFoundationModels` — and
 * answers 200 with an empty list when AWS refuses the call. Reading only the
 * list therefore cannot tell "Bedrock reported no such model" from "Bedrock
 * was never asked", which is how an unconfigured Bedrock came to be rendered
 * as "no model supports images".
 */
export interface ModelCapabilitiesEnvelope {
  capabilities: any[];
  /**
   * The catalogue `capabilities` came from. A model absent from a
   * `source: 'bedrock'` envelope is simply not in Bedrock's catalogue — it
   * says nothing about a Claude Code, Codex, ACP, or Ollama model.
   */
  source: 'bedrock';
  /**
   * Whether that catalogue was actually enumerated. `false` means
   * `capabilities` is UNKNOWN, not empty — do not read an absent row as
   * "unsupported".
   */
  complete: boolean;
}

async function fetchModelCapabilitiesEnvelope(): Promise<ModelCapabilitiesEnvelope> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/api/models/capabilities`,
  );
  if (!response.ok) {
    if (response.status === 401) {
      // Transport auth, not AWS credentials: the route answers 200 for
      // those. Either way the catalogue was not read, so report it as
      // unknown rather than as an empty catalogue.
      return { capabilities: [], source: 'bedrock', complete: false };
    }
    throw new Error(
      `Failed to fetch model capabilities: ${response.statusText}`,
    );
  }
  const result = await response.json();
  return {
    capabilities: Array.isArray(result.data) ? result.data : [],
    source: 'bedrock',
    // Absent field (a server predating the envelope) reads as unknown, which
    // is the honest answer when nothing said otherwise.
    complete: result.complete === true,
  };
}

export function useModelCapabilitiesEnvelopeQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['modelCapabilities'],
    fetchModelCapabilitiesEnvelope,
    config,
  );
}

/**
 * List-only view over {@link useModelCapabilitiesEnvelopeQuery}, sharing its
 * cache entry. A consumer deciding whether a model supports something must use
 * the envelope query instead: this shape cannot express "not queryable".
 */
export function useModelCapabilitiesQuery(config?: QueryConfig<any>) {
  const query = useModelCapabilitiesEnvelopeQuery(config);
  return { ...query, data: query.data?.capabilities };
}

export function useConfigQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['config'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(`${apiBase}/config/app`);
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error);
      }
      return result.data;
    },
    config,
  );
}

/**
 * station#settings-revamp slice 3: per-field provenance for `GET
 * /config/app` (`SettingProvenanceEntry`, `@kontourai/station-contracts/
 * settings-registry`) — a separate cache key (`['config', 'provenance']`)
 * from `useConfigQuery`'s `['config']` so existing 15 flat-config consumers
 * of that hook never see a shape change. Both hooks hit the same route; the
 * provenance map is a sibling top-level field on the same response
 * (`{ success, data, provenance }`), not a separate endpoint.
 */
export function useConfigProvenanceQuery(config?: QueryConfig<any>) {
  return useApiQuery(
    ['config', 'provenance'],
    async () => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(`${apiBase}/config/app`);
      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error);
      }
      return (result.provenance ?? {}) as Record<
        string,
        SettingProvenanceEntry
      >;
    },
    config,
  );
}

/**
 * The full `PUT /config/app` payload — station#settings-revamp slice-1
 * finding 4: `data` stays the flat updated config (unchanged shape, so
 * `useConfig`-style flat-config consumers don't need touching) with
 * `ignoredKeys` attached as a sibling field, mirroring the route's own
 * `{ success, data, ignoredKeys? }` response shape rather than discarding it.
 */
export interface UpdateAppConfigResult {
  data: Record<string, unknown>;
  ignoredKeys?: Array<{ key: string; reason: 'unknown' | 'runtime-derived' }>;
}

/**
 * Plain, hook-free version of the PUT so it's testable without a React
 * render (mirrors `createAgent`/`updateAgent`/`deleteAgent` above). Typed
 * input `Partial<AppConfig>` rejects a typo'd key at compile time for SDK
 * consumers, instead of silently round-tripping it to the server to be
 * dropped as `ignored: 'unknown'`.
 */
export async function updateAppConfig(
  config: Partial<AppConfig>,
): Promise<UpdateAppConfigResult> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/config/app`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  return {
    data: result.data as Record<string, unknown>,
    ignoredKeys: result.ignoredKeys,
  };
}

export function useUpdateConfigMutation(
  options?: MutationOptions<UpdateAppConfigResult, Partial<AppConfig>>,
) {
  return useApiMutation<UpdateAppConfigResult, Partial<AppConfig>>(
    (config) => updateAppConfig(config),
    {
      invalidateKeys: [['config']],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

/**
 * Record what the person did with the guided first run (UX audit RT-02,
 * review M1).
 *
 * A separate endpoint from `updateAppConfig` because it is a TRANSITION, not a
 * setting: `POST /config/first-run` accepts only `{ status }`, refuses
 * `pending` and backward moves, and stamps the timestamp itself. The generic
 * config route refuses `firstRun` outright, so this is the only way in.
 */
export async function recordFirstRunDecision(
  next: FirstRunTransitionRequest,
): Promise<FirstRunState> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/config/first-run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(next),
  });
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error);
  }
  return result.data as FirstRunState;
}

export function useRecordFirstRunDecisionMutation(
  options?: MutationOptions<FirstRunState, FirstRunTransitionRequest>,
) {
  return useApiMutation<FirstRunState, FirstRunTransitionRequest>(
    (next) => recordFirstRunDecision(next),
    {
      invalidateKeys: [['config']],
      onSuccess: options?.onSuccess,
      onError: options?.onError,
    },
  );
}

export function useStatsQuery(
  agentSlug: string | undefined,
  conversationId: string | undefined,
  config?: QueryConfig<ConversationStatsResponse>,
) {
  return useQuery({
    ...agentQueries.stats(agentSlug || '', conversationId || ''),
    ...config,
    enabled: !!agentSlug && !!conversationId && (config?.enabled ?? true),
  });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
