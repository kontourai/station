import { randomUUID } from 'node:crypto';
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  type OperationalEventEnvelope,
} from '@kontourai/station-contracts/operational-event';

export type RuntimeLifecyclePhase = 'ready' | 'stopping';

export function createRuntimeLifecycleOperationalEvent(input: {
  phase: RuntimeLifecyclePhase;
  environmentId: string;
  version: string;
  occurredAt?: string;
  id?: string;
}): OperationalEventEnvelope {
  return {
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    id: input.id ?? `runtime-lifecycle-${randomUUID()}`,
    type: 'station.runtime.lifecycle/v1',
    producer: { id: 'station-server', version: input.version },
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    scopes: [],
    payload: {
      schema: 'station.runtime.lifecycle/v1',
      data: {
        phase: input.phase,
        environmentId: input.environmentId,
      },
    },
    privacy: 'private',
    delivery: 'durable',
  };
}
