/**
 * Runtime composition for the `project-coordination` Feature Preview
 * (#5062 Project brief, #5065 Project memory, #5068 Project models and
 * usage). Composed once by the runtime; every consumer (the orchestration
 * start seam, the Project routes, the Station Control tools, the knowledge
 * service's legacy rules) shares this one memory store and selects the
 * preview at its own consuming branch.
 *
 * With the preview off, Sessions start exactly as before: no brief, no
 * memory, the legacy `rules` namespace injects as it did, and the routes and
 * tools refuse.
 */
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { FeaturePreviewSelector } from '../services/feature-previews/feature-preview-registry.js';
import {
  LEGACY_RULES_NAMESPACE,
  migrateProjectRulesToBrief,
} from '../services/projects/project-brief-migration.js';
import { ProjectMemoryStore } from '../services/projects/project-memory-store.js';
import {
  createProjectSessionContextSource,
  type ProjectSessionContextSource,
} from '../services/projects/project-session-context-source.js';

export interface ProjectCoordinationRuntime {
  preview: FeaturePreviewSelector;
  enabled(): boolean;
  memory: ProjectMemoryStore;
  /** What a new Session in a Project starts from; nothing while off. */
  sessionContext: ProjectSessionContextSource;
  /** Copy a Project's legacy rules into its brief, once. Never throws. */
  migrateRules(slug: string): Promise<void>;
}

export interface ProjectCoordinationRuntimeDeps {
  /** The `project-coordination` preview, bound by the runtime. */
  preview: FeaturePreviewSelector;
  projectHomeDir: string;
  getProject(slug: string): ProjectConfig | undefined;
  saveProject(
    slug: string,
    update: Pick<ProjectConfig, 'instructions' | 'instructionsMigratedAt'>,
  ): Promise<void>;
  knowledge?: {
    listDocuments(
      slug: string,
      namespace: string,
    ): Promise<readonly { id: string; filename: string; createdAt?: string }[]>;
    getDocumentContent(
      slug: string,
      docId: string,
      namespace: string,
    ): Promise<string>;
  };
  warn(message: string, fields: Record<string, unknown>): void;
}

export function composeProjectCoordinationRuntime(
  deps: ProjectCoordinationRuntimeDeps,
): ProjectCoordinationRuntime {
  const preview = deps.preview;
  const enabled = () =>
    preview.select({ enabled: () => true, disabled: () => false });
  const memory = new ProjectMemoryStore(deps.projectHomeDir);
  const migrating = new Map<string, Promise<void>>();
  const migrateRules = (slug: string): Promise<void> => {
    const project = deps.getProject(slug);
    if (!project || project.instructionsMigratedAt) return Promise.resolve();
    const running = migrating.get(slug);
    if (running) return running;
    const knowledge = deps.knowledge;
    const run = migrateProjectRulesToBrief(project, {
      listRulesDocuments: async (projectSlug) =>
        knowledge
          ? knowledge.listDocuments(projectSlug, LEGACY_RULES_NAMESPACE)
          : [],
      readRulesDocument: async (projectSlug, docId) =>
        knowledge
          ? knowledge.getDocumentContent(
              projectSlug,
              docId,
              LEGACY_RULES_NAMESPACE,
            )
          : '',
      saveBrief: deps.saveProject,
      warn: deps.warn,
    })
      .then(() => undefined)
      .finally(() => migrating.delete(slug));
    migrating.set(slug, run);
    return run;
  };
  const source = createProjectSessionContextSource({
    getProject: deps.getProject,
    memory,
  });
  return {
    preview,
    enabled,
    memory,
    migrateRules,
    sessionContext: {
      async resolve(projectSlug) {
        if (!enabled()) return undefined;
        await migrateRules(projectSlug);
        return source.resolve(projectSlug);
      },
    },
  };
}
