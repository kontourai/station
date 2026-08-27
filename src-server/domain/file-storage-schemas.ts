import { CLEAN_ID_PATTERN } from '@kontourai/station-contracts/agent-identity';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import type {
  LayoutConfig,
  LayoutTemplate,
} from '@kontourai/station-contracts/layout';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { z } from 'zod';
import type { ConversationRecord, DocumentRecord } from './storage-adapter.js';

const nonEmptyString = z.string().min(1);
const optionalString = z.string().optional();
const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: 'expected an ISO timestamp',
  });

const knowledgeNamespaceSchema = z
  .object({
    id: nonEmptyString,
    label: nonEmptyString,
    behavior: z.enum(['rag', 'inject']),
    description: optionalString,
    builtIn: z.boolean().optional(),
    storageDir: optionalString,
    repoRoot: z
      .object({ repoId: nonEmptyString, path: nonEmptyString })
      .strict()
      .optional(),
    writeFiles: z.boolean().optional(),
    syncOnScan: z.boolean().optional(),
    enhance: z
      .object({ agent: nonEmptyString, auto: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();

const projectSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    slug: nonEmptyString,
    icon: optionalString,
    description: optionalString,
    workingDirectory: optionalString,
    defaultWorkspaceIsolation: z.enum(['shared', 'worktree']).optional(),
    defaultEnvironment: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('current') }).strict(),
        z.object({ kind: z.literal('saved'), id: nonEmptyString }).strict(),
      ])
      .optional(),
    defaultProviderId: optionalString,
    defaultModel: optionalString,
    defaultEmbeddingProviderId: optionalString,
    defaultEmbeddingModel: optionalString,
    similarityThreshold: z.number().finite().optional(),
    topK: z.number().int().nonnegative().optional(),
    agents: z.array(z.string().regex(CLEAN_ID_PATTERN)).optional(),
    knowledgeNamespaces: z.array(knowledgeNamespaceSchema).optional(),
    position: z.number().int().nonnegative().optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const contributionSourceSchema = z
  .object({
    id: nonEmptyString,
    kind: z.enum(['builtin', 'local', 'remote']),
    source: optionalString,
  })
  .strict();

const contributionProvenanceSchema = z
  .object({
    origin: z.enum(['builtin', 'plugin', 'mcp']),
    pluginId: optionalString,
    mcpServerId: optionalString,
  })
  .strict();

const layoutSchema = z
  .object({
    id: nonEmptyString,
    projectSlug: nonEmptyString,
    type: nonEmptyString,
    name: nonEmptyString,
    slug: nonEmptyString,
    icon: optionalString,
    description: optionalString,
    catalogContribution: z
      .object({
        id: nonEmptyString,
        version: nonEmptyString,
        sourceIdentity: contributionSourceSchema,
        provenance: contributionProvenanceSchema,
      })
      .strict()
      .optional(),
    // Layout configuration is an intentional extension payload. Its outer
    // record is strict; this one field remains provider-defined data.
    config: z.record(z.string(), z.unknown()).default({}),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const conversationSchema = z
  .object({
    id: nonEmptyString,
    projectId: nonEmptyString,
    title: z.string(),
    agentSlug: nonEmptyString,
    layoutId: optionalString,
    providerId: optionalString,
    model: optionalString,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

const documentSchema = z
  .object({
    id: nonEmptyString,
    projectId: nonEmptyString,
    filename: nonEmptyString,
    mimeType: nonEmptyString,
    size: z.number().int().nonnegative(),
    source: z.enum(['upload', 'directory-scan', 'url']),
    sourceUri: optionalString,
    chunkCount: z.number().int().nonnegative(),
    status: z.enum(['pending', 'processing', 'embedded', 'error']),
    error: optionalString,
    embeddedAt: timestamp.optional(),
    createdAt: timestamp,
  })
  .strict();

const layoutTemplateSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: optionalString,
    icon: optionalString,
    type: nonEmptyString,
    config: z.record(z.string(), z.unknown()),
    createdAt: timestamp,
  })
  .strict();

const knowledgeRootSchema = z
  .object({
    id: nonEmptyString,
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('personal') }).strict(),
      z
        .object({ kind: z.literal('project'), projectSlug: nonEmptyString })
        .strict(),
    ]),
    adapterId: nonEmptyString,
    storeRoot: nonEmptyString,
    displayName: nonEmptyString,
    createdAt: timestamp,
  })
  .strict();

function parsePersisted<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const at = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
  throw new Error(
    `${label} is invalid${at}: ${issue?.message ?? 'invalid persisted value'}`,
  );
}

function parsePersistedList<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T[] {
  return parsePersisted(z.array(schema), value, label);
}

export const parseProjectConfig = (value: unknown): ProjectConfig =>
  parsePersisted(
    projectSchema as z.ZodType<ProjectConfig>,
    value,
    'project record',
  );

export const parseLayoutConfig = (value: unknown): LayoutConfig =>
  parsePersisted(
    layoutSchema as z.ZodType<LayoutConfig>,
    value,
    'layout record',
  );

export const parseConversationRecords = (
  value: unknown,
): ConversationRecord[] =>
  parsePersistedList(conversationSchema, value, 'conversation records');

export const parseDocumentRecords = (value: unknown): DocumentRecord[] =>
  parsePersistedList(documentSchema, value, 'document records');

export const parseLayoutTemplates = (value: unknown): LayoutTemplate[] =>
  parsePersistedList(layoutTemplateSchema, value, 'layout templates');

export const parseKnowledgeStoreRoots = (
  value: unknown,
): KnowledgeStoreRoot[] =>
  parsePersistedList(knowledgeRootSchema, value, 'knowledge store roots');
