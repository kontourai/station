/** Public preview only. A plan never grants permission to transfer or execute. */
export interface CloudMoveTarget {
  providerId: string;
  region: string;
  instanceType: string;
}

export interface CloudMoveItem {
  kind:
    | 'agent'
    | 'project'
    | 'plugin'
    | 'credentials'
    | 'history'
    | 'execution';
  id: string;
  disposition:
    | 'review-required'
    | 'reauthentication-required'
    | 'not-transferable';
  reasons: string[];
}

export interface CloudMovePreview {
  schemaVersion: 'station.cloud-move-preview/v1';
  target: CloudMoveTarget;
  sourceSchemaVersion: number;
  observation: 'non-atomic-preview';
  transferAvailable: false;
  executionResumeAvailable: false;
  items: CloudMoveItem[];
  blockers: string[];
  warnings: string[];
}
