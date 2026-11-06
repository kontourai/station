/**
 * #4521: VoltAgent's own remote observability under `limits.telemetry: false`.
 *
 * The pinned `@voltagent/core` reads `VOLTAGENT_PUBLIC_KEY` and
 * `VOLTAGENT_SECRET_KEY` itself, registers a global VoltOps client, and its
 * default observability carries a trace processor and a log processor that
 * export to that client's `/api/public/otel/v1/{traces,logs}` as soon as a
 * client exists. An agent with no global observability builds that default
 * for itself on its first span, so the replacement is registered before any
 * agent is created and handed to `new VoltAgent(...)` as well.
 *
 * The replacement keeps VoltAgent's local trace store and WebSocket stream,
 * which Station's observability routes read; it only drops the two remote
 * processors (`voltOpsSync` sampling `never`). It is built directly rather
 * than through `createVoltAgentObservability`, which would pick the
 * serverless variant VoltAgent re-points at the VoltOps client on every
 * request.
 */
import { AgentRegistry, VoltAgentObservability } from '@voltagent/core';
import { telemetryAllowedByManagedPolicy } from '../../security/managed-capability-limits.js';

/**
 * Under the limit, register and return VoltAgent observability with no remote
 * export; otherwise undefined, leaving VoltAgent's default in place. Call
 * before any agent is created.
 */
export function installManagedVoltAgentObservability():
  | VoltAgentObservability
  | undefined {
  if (telemetryAllowedByManagedPolicy()) return undefined;
  const registry = AgentRegistry.getInstance();
  // A reload re-runs initialization; keep the instance already registered.
  const existing = registry.getGlobalObservability();
  if (existing && localOnly.has(existing))
    return existing as VoltAgentObservability;
  const observability = new VoltAgentObservability({
    serviceName: 'voltagent',
    voltOpsSync: { sampling: { strategy: 'never' } },
  });
  localOnly.add(observability);
  registry.setGlobalObservability(observability);
  return observability;
}

const localOnly = new WeakSet<object>();
