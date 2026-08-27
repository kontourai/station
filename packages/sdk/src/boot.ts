import type { QueryClient } from '@tanstack/react-query';
import { _getApiBase } from './api';
import { toAgentCatalogProjection } from './client/agents';
import { authenticatedFetch } from './client/http';

// These keys MUST equal the hooks' own registered query keys. They live
// here (lazy chunk) rather than in the entry-graph domain modules because
// exporting constructors from those modules costs entry bytes the budget
// cannot absorb; the binding is enforced by boot.test.tsx's runtime
// binding test, which renders each hook and asserts its ACTUAL cache key
// equals the seed key below — a hook key change reds that test.
const authStatusQueryKey = () => ['auth-status'] as const;
const configQueryKey = () => ['config'] as const;
const serverCapabilitiesQueryKey = () => ['system-capabilities'] as const;
const brandingQueryKey = () => ['branding'] as const;
const agentsQueryKey = () => ['agents'] as const;
const projectsQueryKey = () => ['projects'] as const;
const modelsQueryKey = () => ['model-catalog'] as const;

/** Test seam: the exact keys seedBootPayload writes, for the runtime
 * binding test that proves each equals its hook's registered key. */
export const BOOT_SEED_KEYS = {
  auth: authStatusQueryKey(),
  config: configQueryKey(),
  capabilities: serverCapabilitiesQueryKey(),
  branding: brandingQueryKey(),
  agents: agentsQueryKey(),
  projects: projectsQueryKey(),
  models: modelsQueryKey(),
} as const;

export interface BootPayload {
  version: number;
  sections: Record<string, { data?: any; error?: true }>;
}

interface BootRequest {
  startedAt: number;
  apiBase: string;
}

export async function fetchBootPayload(): Promise<BootPayload> {
  const apiBase = await _getApiBase();
  return fetchBootPayloadAt(apiBase);
}

async function fetchBootPayloadAt(apiBase: string): Promise<BootPayload> {
  const response = await authenticatedFetch(`${apiBase}/api/boot`);
  if (!response.ok)
    throw new Error('Could not load Station’s startup information');
  return response.json() as Promise<BootPayload>;
}

/** Seeds only complete sections, using the exact keys consumed by the hooks. */
export async function seedBootPayload(
  queryClient: QueryClient,
  payload: BootPayload,
  request?: BootRequest,
): Promise<void> {
  const bootRequest = request ?? {
    startedAt: Date.now(),
    apiBase: await _getApiBase(),
  };
  if ((await _getApiBase()) !== bootRequest.apiBase) {
    console.debug(
      '[boot] discarded aggregate payload after Station connection changed',
    );
    return;
  }
  const section = (name: string) =>
    payload.sections[name]?.error ? undefined : payload.sections[name]?.data;
  const seed = (key: readonly unknown[], data: unknown) => {
    if (
      (queryClient.getQueryState(key)?.dataUpdatedAt ?? 0) <
      bootRequest.startedAt
    )
      queryClient.setQueryData(key, data);
  };
  const auth = section('auth');
  if (auth !== undefined) seed(authStatusQueryKey(), auth);
  const config = section('config');
  if (config?.success) seed(configQueryKey(), config.data);
  const capabilities = section('capabilities');
  if (capabilities !== undefined)
    seed(serverCapabilitiesQueryKey(), capabilities);
  const branding = section('branding');
  if (branding?.success) {
    const data = branding.data ?? {};
    seed(brandingQueryKey(), {
      appName: data.name || 'Station',
      logo: data.logo ?? null,
      theme: data.theme ?? null,
      welcomeMessage: data.welcomeMessage ?? null,
    });
  }
  const agents = section('agents');
  // station#3824: the value under `['agents']` is an AgentCatalogProjection,
  // not the bare array the boot envelope carries. Built through the SAME
  // mapping `fetchAgentCatalog` uses, so the seeded value and the fetched one
  // cannot drift into different shapes again.
  if (agents?.success) seed(agentsQueryKey(), toAgentCatalogProjection(agents));
  const projects = section('projects');
  if (projects?.success) seed(projectsQueryKey(), projects.data);
  const models = section('models');
  if (models?.success) seed(modelsQueryKey(), models.data);
}

export async function fetchAndSeedBootPayload(
  queryClient: QueryClient,
): Promise<void> {
  const request = { startedAt: Date.now(), apiBase: await _getApiBase() };
  const payload = await fetchBootPayloadAt(request.apiBase);
  await seedBootPayload(queryClient, payload, request);
}
