export type ProjectSupervisionWait =
  | 'actionable'
  | 'working'
  | 'child'
  | 'approval'
  | 'capacity'
  | 'quota'
  | 'paused'
  | 'unknown'
  | 'failed'
  | 'cancelled'
  | 'completed';
export interface ProjectSupervisionIntent {
  key: string;
  projectId: string;
  taskId: string;
  taskCreatedAt: string;
  ownerUserId: string;
  coordinatorConversationId: string;
  generation: number;
  state: 'active' | 'paused' | 'cancelled';
  policy: {
    maxWakes: number;
    maxNoProgressWakes: number;
    minIntervalMs: number;
    stopAt: number;
  };
  observation?: ProjectSupervisionObservation;
  attention?: string;
}
export interface ProjectSupervisionObservation {
  taskId: string;
  taskCreatedAt: string;
  ownerUserId: string;
  coordinatorConversationId: string;
  wait: ProjectSupervisionWait;
  reason: string;
  actionKey: string;
  cursor: string;
  checkpointRevision: string;
  sourceBinding: string;
  nextEligibleAt?: number;
  uncertainEffect: boolean;
}
export interface ProjectSupervisionWake {
  id: string;
  intentKey: string;
  generation: number;
  actionKey: string;
  ownerUserId: string;
  conversationId: string;
  observation: ProjectSupervisionObservation;
  state: 'pending' | 'queued' | 'attention';
  createdAt: number;
  nextEligibleAt: number;
  reason?: string;
}
export interface ProjectSupervisionView {
  intent: ProjectSupervisionIntent | null;
  coordinatorConversationId?: string;
  serverNow: number;
  wakes: ProjectSupervisionWake[];
}
