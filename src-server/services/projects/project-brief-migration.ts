/**
 * #5062: copy each Project's legacy rules (the built-in `rules` knowledge
 * namespace, edited as `project-rules.md`) into the Project brief's
 * instructions, once.
 *
 * The rules only reached a Session when a vector database and an embedding
 * provider were configured, and only on Station's own engine. The brief
 * reaches every Session on every engine. The copy is lossless: the rules text
 * is appended unchanged after any instructions the Project already has, and
 * the rules documents stay where they are. When the result would pass the
 * brief's limit, nothing is copied and the rules keep working as before, so
 * the person can shorten them and the next start copies them.
 *
 * Runs lazily, the first time a Session starts in the Project while the
 * `project-coordination` preview is on (`project-coordination-runtime.ts`).
 * `instructionsMigratedAt` records the copy. After it, the `rules` namespace
 * no longer injects (`KnowledgeService.getInjectContext`), so the same text
 * never reaches a Session twice.
 */
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { PROJECT_INSTRUCTIONS_MAX_CHARS } from '@kontourai/station-contracts/project-session-context';

export const LEGACY_RULES_NAMESPACE = 'rules';
const LEGACY_RULES_FILENAME = 'project-rules.md';

export interface ProjectBriefMigrationDeps {
  listRulesDocuments(
    projectSlug: string,
  ): Promise<readonly { id: string; filename: string; createdAt?: string }[]>;
  readRulesDocument(projectSlug: string, docId: string): Promise<string>;
  saveBrief(
    projectSlug: string,
    update: Pick<ProjectConfig, 'instructions' | 'instructionsMigratedAt'>,
  ): Promise<void>;
  now?: () => Date;
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

export type ProjectBriefMigrationOutcome =
  | 'already-migrated'
  | 'no-rules'
  | 'migrated'
  | 'too-long'
  | 'failed';

/** Migrate one Project. Never throws. */
export async function migrateProjectRulesToBrief(
  project: Pick<
    ProjectConfig,
    'slug' | 'instructions' | 'instructionsMigratedAt'
  >,
  deps: ProjectBriefMigrationDeps,
): Promise<ProjectBriefMigrationOutcome> {
  if (project.instructionsMigratedAt) return 'already-migrated';
  const now = (deps.now ?? (() => new Date()))().toISOString();
  try {
    const documents = [...(await deps.listRulesDocuments(project.slug))].sort(
      (a, b) =>
        Number(b.filename === LEGACY_RULES_FILENAME) -
          Number(a.filename === LEGACY_RULES_FILENAME) ||
        (a.createdAt ?? '').localeCompare(b.createdAt ?? ''),
    );
    const texts: string[] = [];
    for (const document of documents) {
      const text = (
        await deps.readRulesDocument(project.slug, document.id)
      ).trim();
      if (text) texts.push(text);
    }
    if (texts.length === 0) {
      await deps.saveBrief(project.slug, { instructionsMigratedAt: now });
      return 'no-rules';
    }
    const instructions = [project.instructions?.trim(), ...texts]
      .filter((part): part is string => !!part)
      .join('\n\n');
    if (instructions.length > PROJECT_INSTRUCTIONS_MAX_CHARS) {
      deps.warn?.(
        'Project rules are longer than the brief allows; left as rules',
        { projectSlug: project.slug, length: instructions.length },
      );
      return 'too-long';
    }
    await deps.saveBrief(project.slug, {
      instructions,
      instructionsMigratedAt: now,
    });
    return 'migrated';
  } catch (error) {
    deps.warn?.('Project rules were not copied into the brief', {
      projectSlug: project.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}
