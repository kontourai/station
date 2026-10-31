/** Reviewed repository guidance. Applying it never authorizes setup or execution. */
export const PROJECT_WORKING_CONFIGURATION_PREVIEW =
  'project-working-configuration';
export const PROJECT_WORKING_CONFIGURATION_VERSION =
  'station.project-working-configuration/v1';
export const PROJECT_WORKING_CONTEXT_MAX_CHARS = 2400;

export interface ProjectWorkingSource {
  path: string;
  kind: 'instructions' | 'package' | 'ci' | 'guidance';
  scope: string;
  sha256: string;
  text: string;
  shortened: boolean;
}
export interface ProjectWorkingDraft {
  rules: { sourcePath: string; text: string }[];
  validationCommands: { sourcePath: string; command: string }[];
  completionCriteria: string;
  checkpoints: string[];
  evidencePointers: string[];
}
export interface ProjectWorkingConfiguration {
  version: typeof PROJECT_WORKING_CONFIGURATION_VERSION;
  projectId: string;
  revision: number;
  sourceDigest: string;
  rootIdentity: string;
  draft: ProjectWorkingDraft;
  reviewedBy: string;
  operationId: string;
  applyDigest: string;
}
export interface ProjectWorkingConfigurationView {
  projectId: string;
  sourceDigest: string;
  rootIdentity: string;
  sources: ProjectWorkingSource[];
  omissions: string[];
  suggested: ProjectWorkingDraft;
  current: ProjectWorkingConfiguration | null;
  stale: boolean;
}
export interface ProjectWorkingConfigurationApply {
  expectedProjectId: string;
  expectedRevision: number;
  sourceDigest: string;
  operationId: string;
  draft: ProjectWorkingDraft;
}
/** A bounded, attributed data block inside the existing Task brief budget. */
export interface ProjectWorkingContext {
  state: 'reviewed' | 'unconfigured' | 'disabled';
  revision?: number;
  sourceDigest?: string;
  text: string;
  omittedRules: number;
}
