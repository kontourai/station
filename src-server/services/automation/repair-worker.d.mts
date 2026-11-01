import type { IsolatedRepairBudget } from '@kontourai/station-contracts/isolated-repair';
import type { RepairExecutionProfile } from './repair-store.js';
export interface RepairWorkerIdentity {
  containerName: string;
  ownerId: string;
  runId: string;
}
export interface RepairWorkerInput extends RepairWorkerIdentity {
  home: string;
  profile: RepairExecutionProfile;
  directory: string;
  workspace: string;
  sourceRoot: string;
  bindingDigest: string;
  instructions: string;
  observation: Readonly<Record<string, string>>;
  budget: IsolatedRepairBudget;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
}
export interface RepairWorkerEvidence {
  receipt: {
    container_removed: boolean;
    storage_violation: unknown;
    terminal: { status: number | null; timeout: boolean; overflow: boolean };
    provider_thread_id: string | null;
    observed: {
      execution_owner: string;
      invocation_id: string;
      image: string;
      argv_model: string;
      host_setup: { station_repair_binding: string };
    };
  };
  provider: {
    transportMode: string;
    counters: {
      forwarded: number;
      max_requests: number;
      total_forwarded: number;
    };
    evidence: unknown[];
  };
  outboundConfinement: string;
  hostUidMapping: string;
}
export function observeRepairWorker(
  identity: RepairWorkerIdentity,
  options?: { remove?: boolean },
): Promise<void>;
export function executeDockerRepair(
  input: RepairWorkerInput,
): Promise<RepairWorkerEvidence>;
