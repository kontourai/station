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

export interface WorkspacePackageReceipt {
  schemaVersion: 'station.workspace-package-receipt/v1';
  head: string;
  branch: string | null;
  fileCount: number;
  indexEntryCount: number;
  untrackedIgnoredFiles: 'omitted';
  gitHistory: 'HEAD-ancestry-only';
  otherRefs: 'omitted';
  capture: 'source-quiescence-required';
  sourceGitConfiguration: 'content-policy-only';
  executionAuthorityTransferred: false;
  credentialEnrollment: 'not-performed';
}

export interface WorkspacePackageInspection extends WorkspacePackageReceipt {
  files: Array<{
    path: string;
    bytes: number;
    executable: boolean;
    sha256: string;
  }>;
  gitObjectValidation: 'performed-during-import';
}

export interface WorkspacePackageVerification extends WorkspacePackageReceipt {
  workspace: string;
  verified: true;
  verification: 'HEAD-branch-index-policy-working-files';
  packageSha256: string;
  verifiedAt: string;
  gitObjectValidation: 'performed-in-isolated-import';
  executableModeVerification: 'passed' | 'unavailable-on-windows';
}

/** Observation of an enrolled process, never a transferable ownership grant. */
export interface CloudMoveTargetObservation {
  schemaVersion: 'station.cloud-target-observation/v1';
  targetOrigin: string;
  environmentId: string;
  instanceId: string;
  bootId: string;
  sha: string;
  observedAt: string;
  executionAuthorityTransferred: false;
  executionResumeAvailable: false;
}

/** Controller-local enrollment observation, never a lease or physical-home proof. */
export interface PairedHomeIdentityObservation {
  schemaVersion: 'station.paired-home-identity/v1';
  controllerEnvironmentId: string;
  pairedDeviceId: string;
  scope: 'personal';
  executionAuthorityTransferred: false;
  executionResumeAvailable: false;
}

/** Personal controller decisions only: these records never enable execution. */
export type PersonalHomeDecisionObservation = {
  schemaVersion: 'station.personal-home-decision/v1';
  executionAuthorityTransferred: false;
  executionResumeAvailable: false;
} & (
  | {
      kind: 'owner-binding';
      channelId: string;
      homeRef: string;
      policyRevision: string;
      revision: number;
    }
  | {
      kind: 'transfer-decision';
      channelId: string;
      operationId: string;
      sourceHomeRef: string;
      targetHomeRef: string;
      policyRevision: string;
      expectedRevision: number;
      phase: 'prepared' | 'source-closed' | 'target-ready' | 'committed';
    }
);

/** Authenticated personal room observation. Not a lease or hardware attestation. */
export interface HomeTransferRoomIdentityObservation {
  schemaVersion: 'station.home-transfer-room-identity/v1';
  environmentId: string;
  pairedDeviceId: string;
  taskId: string;
  channelId: string;
  nonce: string;
  executionAuthorityTransferred: false;
  executionResumeAvailable: false;
}

/** Operator-approved personal mapping, revalidated against a live remote probe. */
export interface HomeTransferRoomBindingObservation {
  schemaVersion: 'station.home-transfer-room-binding/v1';
  channelId: string;
  controllerEnvironmentId: string;
  controllerDeviceId: string;
  remoteEnvironmentId: string;
  remoteTaskId: string;
  remotePairedDeviceId: string;
  executionAuthorityTransferred: false;
  executionResumeAvailable: false;
}
