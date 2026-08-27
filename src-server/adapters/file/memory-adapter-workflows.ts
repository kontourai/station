import type { WorkflowStateEntry } from '@voltagent/core';

type SerializedSuspension = Omit<
  NonNullable<WorkflowStateEntry['suspension']>,
  'suspendedAt'
> & {
  suspendedAt: string;
};

export type WorkflowStateJson = Omit<
  WorkflowStateEntry,
  'createdAt' | 'updatedAt' | 'suspension'
> & {
  createdAt: string;
  updatedAt: string;
  suspension?: SerializedSuspension;
};

export function serializeWorkflowState(
  state: WorkflowStateEntry,
): WorkflowStateJson {
  const { createdAt, updatedAt, suspension, ...rest } = state;
  const base = rest as Omit<
    WorkflowStateEntry,
    'createdAt' | 'updatedAt' | 'suspension'
  >;

  return {
    ...base,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    suspension: suspension
      ? {
          ...suspension,
          suspendedAt: suspension.suspendedAt.toISOString(),
        }
      : undefined,
  };
}

export function deserializeWorkflowState(
  json: WorkflowStateJson,
): WorkflowStateEntry {
  const { createdAt, updatedAt, suspension, ...rest } = json;
  const base = rest as Omit<
    WorkflowStateEntry,
    'createdAt' | 'updatedAt' | 'suspension'
  >;

  return {
    ...base,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    suspension: suspension
      ? {
          ...suspension,
          suspendedAt: new Date(suspension.suspendedAt),
        }
      : undefined,
  };
}
