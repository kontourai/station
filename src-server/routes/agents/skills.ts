/**
 * Skill Routes — CRUD operations for installed skills
 */

import type {
  SkillProvenance,
  SkillSourceContext,
} from '@kontourai/station-contracts/catalog';
import { type Context, Hono } from 'hono';
import { SkillCommandRefusedError } from '../../services/agents/skill-command-validation.js';
import {
  isSafeSkillName,
  parseImportedSkillMarkdown,
} from '../../services/agents/skill-metadata.js';
import type { SkillService } from '../../services/agents/skill-service.js';
import { SkillUsageUnreadableError } from '../../services/agents/skill-usage-service.js';
import { skillOps } from '../../telemetry/metrics.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  isTrustedInternalApiToken,
} from '../../utils/internal-api-token.js';
import {
  errorMessage,
  getBody,
  localSkillCreateSchema,
  localSkillUpdateSchema,
  param,
  skillCreateSchema,
  skillImportSchema,
  skillOutcomeSchema,
  validate,
} from '../schemas/schemas.js';

/**
 * A refused command word is a 409 wherever it surfaces. The refusal itself
 * lives in the SERVICE (`assertSkillCommandAllowed`), so a rename — which
 * changes the effective command word without the request naming a command at
 * all — cannot slip past a route that only inspected the request body.
 */
function writeFailure(c: Context, error: unknown) {
  if (error instanceof SkillCommandRefusedError) {
    return c.json({ success: false, error: error.publicMessage }, error.status);
  }
  return c.json({ success: false, error: errorMessage(error) }, 400);
}

/**
 * Counters that exist but cannot be read are a 503 naming the file, never a
 * silently reset store: the old value may still be recoverable by hand, and a
 * mutation that overwrote it would destroy that (review finding 4).
 */
/**
 * Split the agent/conversation provenance `mcp-manager.ts` stamps onto an
 * agent-authored `update_skill` off the editable body, and honour it ONLY for
 * a request carrying the internal API token.
 *
 * A client-supplied `_sourceContext` is dropped rather than refused, exactly
 * as the retired playbook routes handled it: an untrusted caller asserting
 * "an agent wrote this" is a provenance label nothing derived, and the field
 * is not part of the public contract to reject over.
 */
function splitSourceContext<T extends Record<string, unknown>>(
  c: Context,
  body: T,
): { data: Omit<T, '_sourceContext'>; sourceContext?: SkillSourceContext } {
  const { _sourceContext, ...data } = body;
  return {
    data,
    sourceContext: isTrustedInternalApiToken(
      c.req.header(INTERNAL_API_TOKEN_HEADER),
    )
      ? (_sourceContext as SkillSourceContext | undefined)
      : undefined,
  };
}

function usageFailure(c: Context, error: unknown) {
  if (error instanceof SkillUsageUnreadableError) {
    return c.json(
      {
        success: false,
        error: `Skill usage counters could not be read (${error.path}). They were left untouched; move or repair that file and retry.`,
      },
      503,
    );
  }
  return c.json({ success: false, error: errorMessage(error) }, 500);
}

export function createSkillRoutes(
  skillService: SkillService,
  getProjectHomeDir: () => string,
) {
  const app = new Hono();

  // List installed skills
  app.get('/', (c) => {
    skillOps.add(1, { operation: 'list' });
    return c.json({ success: true, data: skillService.listSkills() });
  });

  // Get skill detail. `:name` also resolves a `legacyId` (a migrated UUID or
  // `<plugin>:<id>` a skill records), so a caller holding an old identifier
  // keeps working without the caller knowing it moved.
  app.get('/:name', async (c) => {
    try {
      const requested = param(c, 'name');
      const name = skillService.resolveSkillName(requested) ?? requested;
      const skill = await skillService.getSkill(name);
      return c.json({ success: true, data: skill });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 404);
    }
  });

  // Install skill
  app.post('/', validate(skillCreateSchema), async (c) => {
    try {
      const body = getBody(c);
      const result = await skillService.installSkill(
        body.name,
        getProjectHomeDir(),
      );
      if (!result.success) {
        return c.json({ success: false, error: result.message }, 400);
      }
      return c.json({ success: true, data: result }, 201);
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  // Create local packaged skill
  app.post('/local', validate(localSkillCreateSchema), async (c) => {
    try {
      const body = getBody(c);
      const result = await skillService.createLocalSkill(
        body,
        getProjectHomeDir(),
      );
      if (!result.success) {
        return c.json({ success: false, error: result.message }, 400);
      }
      return c.json({ success: true, data: result }, 201);
    } catch (error: unknown) {
      return writeFailure(c, error);
    }
  });

  app.put('/:name', validate(localSkillUpdateSchema), async (c) => {
    try {
      const name = param(c, 'name');
      const { data: body, sourceContext } = splitSourceContext(c, getBody(c));
      const declaresCommandMetadata =
        body.command !== undefined || body.variables !== undefined;

      // A canonical package skill or a plugin's skill is served from a root
      // Station must not write to, so its `SKILL.md` cannot carry the
      // declaration. Refuse with the action that would make it possible rather
      // than silently writing a shadow copy into the workspace.
      if (
        declaresCommandMetadata &&
        !skillService.isSkillWritable(name, getProjectHomeDir())
      ) {
        return c.json(
          {
            success: false,
            error: `'${name}' is read-only — install it to your workspace to make it a command`,
          },
          409,
        );
      }

      // `updatedFrom` records WHO changed it; `createdFrom` is not touched,
      // because an agent editing a user's skill does not become its author.
      const updates = sourceContext
        ? {
            ...body,
            provenance: {
              ...(body.provenance as SkillProvenance | undefined),
              updatedFrom: sourceContext,
            },
          }
        : body;
      const result = await skillService.updateLocalSkill(
        name,
        updates,
        getProjectHomeDir(),
      );
      if (!result.success) {
        return c.json({ success: false, error: result.message }, 400);
      }
      return c.json({ success: true, data: result });
    } catch (error: unknown) {
      return writeFailure(c, error);
    }
  });

  // Count one use of a skill. Works for read-only skills: the counters live in
  // a side store, not in the skill package.
  app.post('/:name/run', async (c) => {
    try {
      const requested = param(c, 'name');
      const name = skillService.resolveSkillName(requested);
      if (!name) {
        return c.json(
          { success: false, error: `Skill '${requested}' not found` },
          404,
        );
      }
      const stats = await skillService.trackSkillRun(name);
      return c.json({ success: true, data: { name, stats } });
    } catch (error: unknown) {
      return usageFailure(c, error);
    }
  });

  app.post('/:name/outcome', validate(skillOutcomeSchema), async (c) => {
    try {
      const requested = param(c, 'name');
      const name = skillService.resolveSkillName(requested);
      if (!name) {
        return c.json(
          { success: false, error: `Skill '${requested}' not found` },
          404,
        );
      }
      const stats = await skillService.recordSkillOutcome(
        name,
        getBody(c).outcome,
      );
      return c.json({ success: true, data: { name, stats } });
    } catch (error: unknown) {
      return usageFailure(c, error);
    }
  });

  // Import N markdown files as local skills. Every file gets its own result
  // row — an import that partly failed says so, per file, instead of the
  // client having to reconcile N independent POSTs.
  app.post('/import', validate(skillImportSchema), async (c) => {
    const { files } = getBody(c) as {
      files: Array<{ filename: string; content: string }>;
    };
    const results: Array<{
      filename: string;
      success: boolean;
      name?: string;
      error?: string;
    }> = [];
    for (const file of files) {
      const parsed = parseImportedSkillMarkdown(file.filename, file.content);
      const name = parsed.name;
      if (!isSafeSkillName(name)) {
        results.push({
          filename: file.filename,
          success: false,
          error: 'File does not name a usable skill',
        });
        continue;
      }
      if (!parsed.body.trim()) {
        results.push({
          filename: file.filename,
          success: false,
          name,
          error: 'File has no body',
        });
        continue;
      }
      if (skillService.hasSkill(name)) {
        results.push({
          filename: file.filename,
          success: false,
          name,
          error: `Skill '${name}' already exists`,
        });
        continue;
      }
      // An imported file's own `command:` block meets the same refusal a PUT
      // does — it is raised by `createLocalSkill` and recorded as this file's
      // result row, so one bad file does not fail the others.
      try {
        const result = await skillService.createLocalSkill(
          { ...parsed, name, body: parsed.body },
          getProjectHomeDir(),
        );
        results.push({
          filename: file.filename,
          success: result.success,
          name,
          ...(result.success ? {} : { error: result.message }),
        });
      } catch (error: unknown) {
        results.push({
          filename: file.filename,
          success: false,
          name,
          error: errorMessage(error),
        });
      }
    }
    const imported = results.filter((entry) => entry.success).length;
    skillOps.add(1, { operation: 'import' });
    // 207: the per-file rows are the answer, and at least one of them failed.
    return c.json(
      { success: true, data: { imported, results } },
      imported === results.length ? 201 : 207,
    );
  });

  // Remove skill
  app.delete('/:name', async (c) => {
    try {
      const name = param(c, 'name');
      const result = await skillService.removeSkill(name, getProjectHomeDir());
      if (!result.success) {
        return c.json({ success: false, error: result.message }, 404);
      }
      skillOps.add(1, { operation: 'delete' });
      return c.json({ success: true });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  return app;
}
