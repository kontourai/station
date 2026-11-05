/**
 * #4520: what the machine's managed policy says about engines, for the
 * engine pages. Reads `GET /api/settings/managed-policy` and decodes only the
 * organization, the support link and the value-free engine summary.
 *
 * Imports only `managed-policy-engines`, never the full `managed-policy`
 * module, which carries the settings registries and would grow the initial
 * UI bundle. A host without the route, or one that answers anything this
 * cannot decode, reads as "no managed engines": nothing is marked.
 */
import {
  type ManagedPolicyEngineSummary,
  type ManagedPolicyPinnedEngineSummary,
  managedEngineAllowed,
  managedEnginePin,
  parseManagedEngineSummary,
} from '@kontourai/station-contracts/managed-policy-engines';
import { getJson } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';

export interface ManagedEnginesView {
  organization: string;
  supportUrl: string | null;
  engines: ManagedPolicyEngineSummary;
}

/** The engine part of a `ManagedPolicyStatus` body, or null. */
export function decodeManagedEngines(body: unknown): ManagedEnginesView | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const { state, summary } = data as { state?: unknown; summary?: unknown };
  if (state !== 'loaded' || typeof summary !== 'object' || summary === null)
    return null;
  const { organization, supportUrl, engines } = summary as {
    organization?: unknown;
    supportUrl?: unknown;
    engines?: unknown;
  };
  if (typeof organization !== 'string' || engines === undefined) return null;
  const parsed = parseManagedEngineSummary(engines);
  if (!parsed) return null;
  return {
    organization,
    supportUrl: typeof supportUrl === 'string' ? supportUrl : null,
    engines: parsed,
  };
}

/**
 * The policy id of an engine row: Station's own agent is the engine
 * `station` and the policy id `station-agent`; an ACP connection is `acp`.
 */
export function managedEngineIdFor(
  engineId: string | undefined,
  isAcpConnection: boolean,
): string | undefined {
  if (isAcpConnection) return 'acp';
  if (engineId === 'station') return 'station-agent';
  return engineId;
}

export interface ManagedEngineState {
  organization: string;
  supportUrl: string | null;
  /** The policy does not let this engine (or this registry agent) run. */
  disallowed: boolean;
  pin: ManagedPolicyPinnedEngineSummary | null;
}

export function managedEngineState(
  view: ManagedEnginesView | null | undefined,
  engine: string | undefined,
  options: { registryAgent?: boolean } = {},
): ManagedEngineState | null {
  if (!view || engine === undefined) return null;
  const disallowed =
    !managedEngineAllowed(
      { allowed: view.engines.allowed ?? undefined },
      engine,
    ) ||
    (engine === 'acp' &&
      options.registryAgent === true &&
      !view.engines.acpRegistryAgents);
  const pin = managedEnginePin(view.engines, engine);
  if (!disallowed && !pin) return null;
  return {
    organization: view.organization,
    supportUrl: view.supportUrl,
    disallowed,
    pin,
  };
}

export function useManagedEngines(): ManagedEnginesView | null {
  const scope = useHostRequestAuthorityScope();
  const query = useQuery({
    queryKey: [
      'managed-policy-engines',
      scope?.apiBase ?? null,
      scope?.authorityKey ?? null,
    ],
    enabled: Boolean(scope?.isCurrent()),
    retry: false,
    // Fixed for the server's lifetime.
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const response = await getJson(
        `${scope?.apiBase ?? ''}/api/settings/managed-policy`,
        {
          signal,
          ...(scope ? { requestScope: scope } : {}),
          maxResponseBytes: 64 * 1024,
        },
      );
      if (!response.ok) return null;
      try {
        return decodeManagedEngines(await response.json());
      } catch {
        return null;
      }
    },
  });
  return query.data ?? null;
}
