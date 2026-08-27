import type { RuntimeContext } from '../types.js';

export interface RuntimeConfigurationLease {
  agentConfigurationRevision: number;
  providerLaunchabilityRevision: number;
  appConfigLaunchabilityRevision: number;
}

type RuntimeConfigurationLeaseSource = {
  configLoader: Pick<
    RuntimeContext['configLoader'],
    'getLaunchabilityRevision'
  >;
  getAgentConfigurationRevision: RuntimeContext['getAgentConfigurationRevision'];
  commitAgentConfigurationRead: RuntimeContext['commitAgentConfigurationRead'];
  providerService: Pick<
    RuntimeContext['providerService'],
    'getLaunchabilityRevision'
  >;
};

export class RuntimeConfigurationConflictError extends Error {
  constructor() {
    super(
      'Agent or model configuration changed during the request. Retry the request.',
    );
    this.name = 'RuntimeConfigurationConflictError';
  }
}

export function captureRuntimeConfigurationLease(
  source: RuntimeConfigurationLeaseSource,
): RuntimeConfigurationLease | null {
  const agentConfigurationRevision = source.getAgentConfigurationRevision();
  if (agentConfigurationRevision === null) return null;
  return {
    agentConfigurationRevision,
    providerLaunchabilityRevision:
      source.providerService.getLaunchabilityRevision(),
    appConfigLaunchabilityRevision:
      source.configLoader.getLaunchabilityRevision(),
  };
}

export function runtimeConfigurationLeaseIsCurrent(
  source: RuntimeConfigurationLeaseSource,
  lease: RuntimeConfigurationLease,
): boolean {
  return (
    source.getAgentConfigurationRevision() ===
      lease.agentConfigurationRevision &&
    source.providerService.getLaunchabilityRevision() ===
      lease.providerLaunchabilityRevision &&
    source.configLoader.getLaunchabilityRevision() ===
      lease.appConfigLaunchabilityRevision
  );
}

export function requireCurrentRuntimeConfiguration(
  source: RuntimeConfigurationLeaseSource,
  lease: RuntimeConfigurationLease | null,
): asserts lease is RuntimeConfigurationLease {
  if (!lease || !runtimeConfigurationLeaseIsCurrent(source, lease)) {
    throw new RuntimeConfigurationConflictError();
  }
}

export async function requireStableRuntimeConfigurationAcross<T>(
  source: RuntimeConfigurationLeaseSource,
  lease: RuntimeConfigurationLease | null,
  operation: () => Promise<T>,
): Promise<T> {
  requireCurrentRuntimeConfiguration(source, lease);
  return source.commitAgentConfigurationRead(
    lease.agentConfigurationRevision,
    async () => {
      requireCurrentRuntimeConfiguration(source, lease);
      const result = await operation();
      requireCurrentRuntimeConfiguration(source, lease);
      return result;
    },
  );
}
