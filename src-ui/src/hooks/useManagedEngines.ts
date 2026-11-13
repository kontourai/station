/**
 * #4520: what the machine's managed policy says about engines, for the
 * engine pages.
 *
 * Reads `summary.engines` from the app's managed-policy summary
 * (`useManagedPolicySummary`, from `ManagedPolicyProvider`), the one client
 * path every managed-policy surface reads: one SDK status query per Station,
 * decoded only by `parseManagedPolicyStatus` in
 * `@kontourai/station-contracts/managed-policy-status`. A host without the
 * route reads as no policy, and a status that cannot be decoded as nothing
 * managed: nothing is marked. The server enforces the policy either way.
 */

import {
  type ManagedPolicyEngineSummary,
  type ManagedPolicyPinnedEngineSummary,
  managedEngineAllowed,
  managedEnginePin,
} from '@kontourai/station-contracts/managed-policy-engines';
import type { ManagedPolicySummary } from '@kontourai/station-contracts/managed-policy-status';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useCallback } from 'react';
import { useManagedPolicySummary } from '../contexts/ManagedPolicyContext';
import { connectionEngineId } from '../utils/execution';
import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  useACPConnectionRegistry,
  useACPConnections,
} from './useACPConnections';

export interface ManagedEnginesView {
  organization: string;
  supportUrl: string | null;
  engines: ManagedPolicyEngineSummary;
}

/** The engine part of a decoded summary, or null when it limits no engine. */
export function managedEnginesView(
  summary: ManagedPolicySummary | null | undefined,
): ManagedEnginesView | null {
  if (!summary?.engines) return null;
  return {
    organization: summary.organization,
    supportUrl: summary.supportUrl,
    engines: summary.engines,
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
  return managedEnginesView(useManagedPolicySummary());
}

/**
 * The managed-policy state of one engine connection, as the Engines list,
 * the engine detail and the section rail all read it: an ACP connection is
 * the policy engine `acp`, and a public-registry ACP agent is refused when the
 * policy turns registry agents off — while its status still reads `ready`.
 */
export function useManagedEngineStateFor(): (
  connection: AgentConnectionView,
) => ManagedEngineState | null {
  const managedEngines = useManagedEngines();
  const { data: acpBridgeConnections = [] } = useACPConnections() as {
    data?: ACPConnectionInfo[];
  };
  const { data: acpRegistryEntries = [] } = useACPConnectionRegistry() as {
    data?: ACPConnectionRegistryEntry[];
  };
  return useCallback(
    (connection: AgentConnectionView) => {
      const isAcp = acpBridgeConnections.some(
        (entry) => entry.id === connection.id,
      );
      return managedEngineState(
        managedEngines,
        managedEngineIdFor(connectionEngineId(connection), isAcp),
        {
          registryAgent:
            isAcp &&
            acpRegistryEntries.some(
              (entry) =>
                entry.id === connection.id &&
                entry.installed === true &&
                entry.source === 'registry',
            ),
        },
      );
    },
    [managedEngines, acpBridgeConnections, acpRegistryEntries],
  );
}
