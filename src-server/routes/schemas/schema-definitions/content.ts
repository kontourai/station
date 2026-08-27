import { parseMcpToolRef } from '@kontourai/station-contracts/layout';
import {
  SKILL_COMMAND_NAME_PATTERN,
  SKILL_COMMAND_NAME_RULE,
} from '@kontourai/station-contracts/skill-command';
import {
  SETUP_IMPORT_MAX_ITEMS,
  SETUP_IMPORT_MAX_SOURCE_ID_LENGTH,
  SETUP_IMPORT_MAX_TARGET_NAME_LENGTH,
} from '@kontourai/station-shared/setup-import-bounds';
import { z } from 'zod/v3';
import {
  AUTHORED_ARTIFACT_MAX_CHARS,
  authoredArtifactBudgetMessage,
} from '../../../../src-shared/authored-artifact-limits.js';

/** Mirrors `SkillSourceContext` in `@kontourai/station-contracts/catalog`. */
const skillSourceContextSchema = z.object({
  kind: z.enum(['agent', 'plugin', 'user', 'asset']),
  agentSlug: z.string().optional(),
  conversationId: z.string().optional(),
  action: z.enum(['provider-capability-to-skill']).optional(),
  convertedAt: z.string().optional(),
  asset: z
    .object({
      kind: z.enum(['skill', 'provider-capability']),
      id: z.string(),
      name: z.string(),
      owner: z.enum(['user', 'registry', 'plugin', 'provider']),
      providerId: z.string().optional(),
      connectionId: z.string().optional(),
    })
    .optional(),
});

/**
 * `command.enabled` is the DECLARATION that a skill is runnable as `/command`.
 * `command.name` is constrained to the shape a user can actually type after a
 * slash — a name with spaces or capitals could never be matched, so accepting
 * one would store a command nobody can invoke.
 *
 * `legacyIds` and `origin` are deliberately NOT accepted here: both are written
 * by the writer that knows (a registry install, `station doctor
 * --migrate-playbooks`), and a
 * client-supplied `origin` would be a provenance label nothing derived.
 */
const skillCommandSchema = z.object({
  enabled: z.boolean(),
  name: z
    .string()
    .min(1)
    .max(100)
    // The rule and its sentence come from the contract, not from a second
    // copy of the regex here: the editor field checks the same rule and says
    // the same thing, so a word this schema will refuse is never offered
    // (station#3737).
    .regex(SKILL_COMMAND_NAME_PATTERN, { message: SKILL_COMMAND_NAME_RULE })
    .optional(),
  global: z.boolean().optional(),
});

const skillVariableSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  default: z.string().max(2000).optional(),
});

export const localSkillCreateSchema = z.object({
  name: z.string().min(1).max(200),
  body: z
    .string()
    .min(1)
    .max(AUTHORED_ARTIFACT_MAX_CHARS, {
      message: authoredArtifactBudgetMessage('Skill body'),
    }),
  description: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  agent: z.string().optional(),
  global: z.boolean().optional(),
  command: skillCommandSchema.optional(),
  variables: z.array(skillVariableSchema).max(50).optional(),
  provenance: z
    .object({
      createdFrom: skillSourceContextSchema.optional(),
      updatedFrom: skillSourceContextSchema.optional(),
    })
    .optional(),
  /**
   * Written by `mcp-manager.ts` onto an AGENT-authored `update_skill` call and
   * honoured only for a request carrying the internal API token. Declared here
   * so it is an accepted input rather than an extra zod strips on the way to a
   * route that would then have nothing to record (review M2).
   */
  _sourceContext: skillSourceContextSchema.optional(),
});

export const localSkillUpdateSchema = localSkillCreateSchema
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field is required',
  });

export const skillOutcomeSchema = z.object({
  outcome: z.enum(['success', 'failure']),
});

/**
 * `POST /api/skills/import` — N markdown files in one request, so an import
 * cannot half-succeed silently across N separate POSTs with no shared result.
 */
export const skillImportSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1).max(512),
        content: z
          .string()
          .min(1)
          .max(AUTHORED_ARTIFACT_MAX_CHARS, {
            message: authoredArtifactBudgetMessage('Skill body'),
          }),
      }),
    )
    .min(1)
    .max(50),
});

/** Existing-agent setup import has no caller-controlled filesystem root. */
export const setupImportPreviewSchema = z.object({
  sourceId: z.literal('codex-prompts'),
});

export const setupImportTargetReviewSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(SETUP_IMPORT_MAX_SOURCE_ID_LENGTH),
        action: z.enum(['import', 'skip']),
        targetName: z
          .string()
          .min(1)
          .max(SETUP_IMPORT_MAX_TARGET_NAME_LENGTH)
          .optional(),
      }),
    )
    .min(1)
    .max(SETUP_IMPORT_MAX_ITEMS)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (seen.has(item.id))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: 'Each preview item may appear once.',
          });
        seen.add(item.id);
        if (item.action === 'import' && !item.targetName)
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'targetName'],
            message: 'Import requires an explicit target name.',
          });
      }
    }),
});

export const setupImportApplySchema = z.object({
  witnessId: z.string().uuid(),
});

export const guidanceConversionSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
  })
  .optional();

// Projects
const projectEnvironmentRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current') }),
  z.object({ kind: z.literal('saved'), id: z.string().trim().min(1).max(512) }),
]);

export const projectCreateSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().optional(),
    workingDirectory: z.string().optional(),
    description: z.string().optional(),
    defaultEnvironment: projectEnvironmentRefSchema.optional(),
  })
  .passthrough();

export const projectUpdateSchema = projectCreateSchema.partial();

/** station#3315: the full desired sidebar order, as project slugs. */
export const projectReorderSchema = z
  .object({
    order: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const mcpToolRefSchema = z.string().refine((ref) => parseMcpToolRef(ref), {
  message: 'MCP tool refs must use <serverId>/<toolName>',
});

const layoutComponentRefSchema = z.union([
  z.string().min(1),
  z
    .object({
      kind: z.literal('plugin-component'),
      name: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('builtin-component'),
      name: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('mcp-tool-ui'),
      ref: mcpToolRefSchema,
      resourceUri: z.string().min(1).optional(),
      displayMode: z.enum(['inline', 'fullscreen', 'pip']).optional(),
      fallbackComponent: z.string().min(1).optional(),
      initialArguments: z.record(z.unknown()).optional(),
      approvalPolicy: z.enum(['inherit', 'require', 'read-only']).optional(),
    })
    .passthrough(),
]);

const layoutConfigSchema = z.record(z.unknown()).superRefine((config, ctx) => {
  const tabs = config.tabs;
  if (tabs === undefined) return;
  if (!Array.isArray(tabs)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tabs'],
      message: 'Layout config tabs must be an array',
    });
    return;
  }

  tabs.forEach((tab, index) => {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)) return;
    if (!Object.hasOwn(tab, 'component')) return;
    const result = layoutComponentRefSchema.safeParse(
      (tab as { component?: unknown }).component,
    );
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tabs', index, 'component'],
        message: result.error.issues[0]?.message ?? 'Invalid layout component',
      });
    }
  });
});

export const projectLayoutCreateSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    type: z.string().optional(),
    config: layoutConfigSchema.optional(),
  })
  .passthrough();

export const projectLayoutUpdateSchema = projectLayoutCreateSchema
  .partial()
  .passthrough();

export const projectLayoutFromPluginSchema = z.object({
  plugin: z.string().min(1),
});

export const projectLayoutApplySchema = z.object({
  layoutId: z
    .string()
    .regex(
      /^(builtin|plugin):[a-z0-9][a-z0-9-]{0,62}(?::[a-z0-9][a-z0-9-]{0,62})?$/,
    ),
});

/**
 * station#1502 slice 4 — `POST /api/projects/:slug/bind`, the explicit repair
 * action (`docs/design/portable-project-identity.md` §3.6).
 *
 * Only non-emptiness is asserted here. The path's SHAPE is not a validation
 * question — a `~`-prefixed, relative, or absolute value are all legitimate
 * things an operator types — and its VALIDITY is a filesystem-and-git question
 * the binder answers by actually looking, refusing with the reason. Encoding a
 * path grammar here would reject real paths without making any bind safer.
 */
export const projectResourceBindSchema = z.object({
  path: z.string().min(1).max(4096),
  /**
   * WHICH resource the checkout is being bound to (station#1503 slice 5).
   * Optional: a single-repo project has nothing to name and every pre-slice-5
   * caller means the primary. Named but unknown is refused, never answered by
   * binding the primary instead.
   */
  resourceId: z.string().min(1).max(1024).optional(),
});

// Workflows
export const workflowCreateSchema = z.object({
  filename: z.string().min(1),
  content: z.string(),
});

export const workflowUpdateSchema = z.object({
  content: z.string(),
});

// Agents
export const agentCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    slug: z
      .string()
      .max(50)
      .regex(/^[a-z0-9-]*$/)
      .optional(),
    prompt: z
      .string()
      .max(AUTHORED_ARTIFACT_MAX_CHARS, {
        message: authoredArtifactBudgetMessage('Agent system prompt'),
      })
      .optional(),
    description: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    region: z.string().max(50).optional(),
    maxSteps: z.number().int().nonnegative().optional(),
    icon: z.string().max(10).optional(),
  })
  .passthrough();

export const agentUpdateSchema = agentCreateSchema
  .partial()
  .passthrough()
  .refine((value) => !Object.hasOwn(value, 'prompts'), {
    message: 'prompts is no longer supported; bind skills by name',
  });

/**
 * `POST /agents/materialize-engine` — the ONE find-or-create path for a
 * detected engine's Agent. The body is an engine CONNECTION id, never an
 * authored name: the display name is resolved server-side from the same
 * registry projection the catalog renders, which is what stops the UI paths
 * from each inventing their own "<engine> Agent" sibling.
 */
export const agentMaterializeEngineSchema = z.object({
  engineId: z.string().min(1).max(100),
});

// Knowledge
export const knowledgeUploadSchema = z.object({
  filename: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

export const knowledgeSearchSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().optional(),
  namespace: z.string().optional(),
});

export const knowledgeBulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const knowledgeUpdateSchema = z.object({
  content: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * station#1503 delta review, R1 — **`repoRoot` is deliberately ABSENT here, and
 * adding it reopens a closed hole.**
 *
 * `KnowledgeNamespaceConfig` carries an optional `repoRoot` (station#1503), and
 * a bad one — naming a repo the project does not declare — makes the project's
 * composed manifest UNREADABLE, failing the session cwd, the knowledge scan,
 * the task workspace and the resolution surface at once. The refusal for that
 * lives on the PROJECT write path (`refuseInvalidRepoAnchors` in
 * `routes/projects/projects.ts`), because that is where the declared resource
 * set is available.
 *
 * These namespace CRUD routes do NOT pass through it:
 * `POST /namespaces` / `PUT /namespaces/:nsId` → `knowledge-service.ts` →
 * `registerKnowledgeNamespace`/`updateKnowledgeNamespace` spread caller data
 * into `project.knowledgeNamespaces` and `saveProject` with no validation. They
 * are safe today ONLY because this is a plain `z.object` (strip mode) with no
 * `repoRoot` key, so the field is silently dropped before it reaches them.
 *
 * **So the safety is an omission, not a guard.** Whoever adds `repoRoot` here —
 * and someone must, for the field to be editable outside a whole-project PUT —
 * must also route these handlers through `knowledgeRepoRootProblem`
 * (`@kontourai/station-contracts/knowledge`), which is where the rule lives so
 * that both paths can share one authority.
 *
 * A guard was NOT pre-installed in those handlers: its rejection path would be
 * unreachable while this schema strips the field, and an unreachable guardrail
 * is unproven by construction — the class this repo's own delivery protocol
 * names. `knowledge-namespace-repo-root-tripwire.test.ts` fails the moment this
 * schema starts accepting `repoRoot`, which puts the reminder in front of the
 * person making the change rather than in a comment they may never open.
 */
export const knowledgeNamespaceCreateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  behavior: z.string().min(1),
  description: z.string().optional(),
  builtIn: z.boolean().optional(),
  storageDir: z.string().optional(),
  writeFiles: z.boolean().optional(),
  syncOnScan: z.boolean().optional(),
  enhance: z
    .object({
      agent: z.string().min(1),
      auto: z.boolean().optional(),
    })
    .optional(),
});

export const knowledgeNamespaceUpdateSchema =
  knowledgeNamespaceCreateSchema.partial();

// Templates
export const templateCreateSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  config: z.record(z.unknown()).optional(),
});

const proposedChangeSnapshotSchema = z.object({
  content: z.string().nullable(),
  hash: z.string().optional(),
  language: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const proposedChangeCreateSchema = z.object({
  id: z.string().optional(),
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  path: z.string().min(1),
  changeType: z.enum(['create', 'modify', 'delete', 'rename']),
  contentKind: z.enum(['code', 'markdown', 'text', 'json', 'unknown']),
  baseSnapshot: proposedChangeSnapshotSchema.nullable().optional(),
  proposedSnapshot: proposedChangeSnapshotSchema.nullable().optional(),
  sourceRuntime: z.string().min(1),
  createdAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const proposedChangeDecisionSchema = z.object({
  reason: z.string().max(2000).optional(),
  actorId: z.string().optional(),
  actorType: z.enum(['human', 'agent', 'system']).optional(),
});

export const proposedChangeBulkDecisionSchema =
  proposedChangeDecisionSchema.extend({
    ids: z.array(z.string().min(1)).min(1).max(50),
  });
