import type { AgentPluginAuthor } from './agent-plugin.js';

/** Inert authoring contract; a declaration does not activate an experience. */
export const SKILL_EXPERIENCE_SCHEMA_1_0 =
  'https://kontour.ai/schemas/agent-plugins/skill-experience/1.0/schema.json' as const;

export interface SkillExperienceContributionV1 {
  version: '1.0';
  id: string;
  /** Package-root-relative JSON file in io.kontourai.station/experiences/. */
  source: string;
}

/** Author expectations, never host-observed installation provenance or trust. */
export interface SkillExperienceSourceV1 {
  id: string;
  name: string;
  path: string;
  sha256: string;
  dependsOn?: string[];
  /** Original library mapping; bundled Skills retain portable discovery paths. */
  upstream?: { repository: string; revision: string; path: string };
}

export type SkillExperienceProvenanceV1 =
  | { origin: 'skill-declared'; skillRef: string; explanation: string }
  | {
      origin: 'reviewer-inferred' | 'station-added';
      explanation: string;
    };

interface SkillExperienceInputBaseV1 {
  id: string;
  label: string;
  description?: string;
  required: boolean;
  provenance: SkillExperienceProvenanceV1;
}

export type SkillExperienceInputV1 =
  | (SkillExperienceInputBaseV1 & {
      kind: 'text';
      default?: string;
      minLength?: number;
      maxLength: number;
    })
  | (SkillExperienceInputBaseV1 & {
      kind: 'single-choice';
      default?: string;
      options: Array<{ value: string; label: string }>;
    })
  | (SkillExperienceInputBaseV1 & {
      kind: 'attachments';
      maxCount: number;
    });

/** Complete v1 author definition. Execution and session state have other owners. */
export interface SkillExperienceDefinitionV1 {
  $schema: typeof SKILL_EXPERIENCE_SCHEMA_1_0;
  schemaVersion: '1.0';
  id: string;
  version: string;
  title: string;
  purpose: string;
  example: string;
  authors: Array<AgentPluginAuthor & { name: string }>;
  /** The owning plugin name/version comes from plugin.json. */
  skills: SkillExperienceSourceV1[];
  /** Required by execution when several bundled Skills are declared. */
  entrySkillId?: string;
  /** Optional explicit user-selected stages within this same package. */
  transitions?: Array<{
    experienceId: string;
    label: string;
    provenance: SkillExperienceProvenanceV1;
  }>;
  requiredContext: Array<{
    kind: 'project' | 'conversation';
    required: boolean;
    provenance: SkillExperienceProvenanceV1;
  }>;
  /** Requirements describe suitability; they grant no tools or resource access. */
  capabilities: Array<
    'conversation' | 'project-read' | 'file-read' | 'artifact-output'
  >;
  inputs: SkillExperienceInputV1[];
  interaction: {
    pattern: 'interview' | 'transform' | 'inspection';
    questionRounds?: {
      answerKinds: Array<'text' | 'single-choice' | 'multi-choice'>;
      maxQuestionsPerRound: number;
    };
    stopConditions: string[];
    unsupportedBehavior: string[];
  };
  outputs: Array<{
    id: string;
    label: string;
    kind: 'markdown' | 'json' | 'files' | 'decision-summary';
    required: boolean;
    provenance: SkillExperienceProvenanceV1;
  }>;
  presentation: {
    modes: Array<'guided' | 'alongside'>;
    defaultMode: 'guided' | 'alongside';
    richView?: { version: '1.0'; kind: 'workspace-pane'; descriptorId: string };
  };
}

/** Host-observed package identity. A catalog entry is not execution authority. */
export interface SkillExperienceIdentityV1 {
  pluginId: string;
  pluginVersion: string;
  experienceId: string;
  incarnation: string;
  materialization: string;
  contentDigest: string;
  definitionDigest: string;
}

export interface InstalledSkillExperienceV1 {
  identity: SkillExperienceIdentityV1;
  definition: SkillExperienceDefinitionV1;
}

export interface SkillExperienceInventoryV1 {
  /** Advertised only when canonical foreground execution is installed. */
  executionContract?: '1.0';
  experiences: InstalledSkillExperienceV1[];
  diagnostics: Array<{
    pluginId: string;
    code: 'unavailable' | 'definition-invalid';
    message: string;
  }>;
}

/** An explicit user selection; the host revalidates every identity and input. */
export interface SkillExperienceStartInputV1 {
  identity: SkillExperienceIdentityV1;
  inputs: Record<string, string>;
  expectedPreviousInvocationEventId?: string;
  /** Indices into the canonical attachment array, never file paths or authority. */
  attachmentInputs?: Record<string, number[]>;
}

/** Immutable presentation snapshot for one canonical foreground dispatch. */
export interface SkillExperienceInvocationV1 {
  version: '1.0';
  identity: SkillExperienceIdentityV1;
  definition: SkillExperienceDefinitionV1;
  inputs: Record<string, string>;
  clientTurnId: string;
  attachmentInputs?: Record<string, number[]>;
  previousInvocationEventId?: string;
  /** Describes the host's question bridge; actual questions require request.opened. */
  questionnaireDelivery: 'canonical-request' | 'chat-fallback';
}

/** Bounded server-owned event metadata; its snapshot remains with the Session store. */
export interface SkillExperienceInvocationReferenceV1 {
  version: '1.0';
  invocationId: string;
  snapshotSessionId: string;
  snapshotDigest: string;
  identity: SkillExperienceIdentityV1;
}

export interface SkillExperienceSessionInvocationV1 {
  eventId: string;
  threadId: string;
  turnId?: string;
  reference?: SkillExperienceInvocationReferenceV1;
  snapshot: SkillExperienceInvocationV1 | null;
  availability: {
    status: 'available' | 'source-unavailable' | 'snapshot-unavailable';
    message?: string;
  };
}

export interface SkillExperienceSessionViewV1 {
  current: SkillExperienceSessionInvocationV1 | null;
  history: SkillExperienceSessionInvocationV1[];
  hasMore: boolean;
  nextCursor?: string;
}
