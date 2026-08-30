import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import type {
  ConnectionStatus,
  Prerequisite,
} from '@kontourai/station-contracts/tool';
import {
  getProviderAdapterRegistrationProvenance,
  type ProviderAdapterShape,
} from '../../providers/adapter-shape.js';
import { adapterReadiness } from '../../telemetry/metrics.js';

export type RuntimeAdapterReadinessState =
  | 'configured'
  | 'runtime_connection_missing'
  | 'unavailable_prerequisites'
  | 'unusable_for_chat';

export interface RuntimeAdapterReadiness {
  state: RuntimeAdapterReadinessState;
  ready: boolean;
  enabled: boolean;
  engineId: EngineId;
  provider: string;
  capabilities: string[];
  prerequisites: Prerequisite[];
  missingPrerequisites: Prerequisite[];
  reason?: string;
}

export function requiredMissingPrerequisites(
  prerequisites: Prerequisite[],
): Prerequisite[] {
  return prerequisites.filter(
    (prerequisite) =>
      prerequisite.category === 'required' &&
      prerequisite.status !== 'installed',
  );
}

export function hasRequiredMissingPrerequisites(
  prerequisites: Prerequisite[],
): boolean {
  return requiredMissingPrerequisites(prerequisites).length > 0;
}

export function resolveRuntimeAdapterReadiness({
  adapter,
  engineId,
  enabled,
  prerequisites,
}: {
  adapter: ProviderAdapterShape;
  engineId: EngineId;
  enabled: boolean;
  prerequisites: Prerequisite[];
}): RuntimeAdapterReadiness {
  const capabilities = [...adapter.metadata.capabilities];
  const missingPrerequisites = requiredMissingPrerequisites(prerequisites);
  const record = (
    state: RuntimeAdapterReadinessState,
    reason: string,
  ): void => {
    const builtin =
      getProviderAdapterRegistrationProvenance(adapter) === 'builtin';
    adapterReadiness.add(1, {
      adapter_id: builtin ? adapter.provider : 'plugin',
      runtime_type: builtin ? engineId : 'plugin',
      state,
      reason,
      source: builtin ? 'builtin' : 'plugin',
    });
  };
  if (!enabled) {
    record('runtime_connection_missing', 'disabled');
    return {
      state: 'runtime_connection_missing',
      ready: false,
      enabled,
      engineId,
      provider: adapter.provider,
      capabilities,
      prerequisites,
      missingPrerequisites,
      reason: 'Runtime connection is disabled.',
    };
  }
  if (missingPrerequisites.length > 0) {
    record('unavailable_prerequisites', 'missing_required_prerequisites');
    return {
      state: 'unavailable_prerequisites',
      ready: false,
      enabled,
      engineId,
      provider: adapter.provider,
      capabilities,
      prerequisites,
      missingPrerequisites,
      reason: 'Required runtime prerequisites are missing.',
    };
  }
  if (!capabilities.includes('agent-runtime')) {
    record('unusable_for_chat', 'missing_agent_runtime_capability');
    return {
      state: 'unusable_for_chat',
      ready: false,
      enabled,
      engineId,
      provider: adapter.provider,
      capabilities,
      prerequisites,
      missingPrerequisites,
      reason: 'Runtime does not expose agent chat execution.',
    };
  }
  record('configured', 'ready');
  return {
    state: 'configured',
    ready: true,
    enabled,
    engineId,
    provider: adapter.provider,
    capabilities,
    prerequisites,
    missingPrerequisites,
  };
}

export function connectionStatusFromRuntimeReadiness(
  readiness: Pick<RuntimeAdapterReadiness, 'enabled' | 'state'>,
): ConnectionStatus {
  if (!readiness.enabled) return 'disabled';
  if (readiness.state === 'unavailable_prerequisites') {
    return 'missing_prerequisites';
  }
  if (readiness.state === 'unusable_for_chat') {
    return 'degraded';
  }
  return 'ready';
}
