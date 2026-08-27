import type { AgentId } from './agent-identity.js';
import type { EnvironmentRef } from './execution-target.js';
import type { KnowledgeNamespaceConfig } from './knowledge.js';
import type { WorkspaceIsolationMode } from './workspace-isolation.js';

export interface ProjectConfig {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  description?: string;
  workingDirectory?: string;
  /** Default workspace mode for newly started project threads. */
  defaultWorkspaceIsolation?: WorkspaceIsolationMode;
  /** Environment used when project execution does not select one explicitly. */
  defaultEnvironment?: EnvironmentRef;
  defaultProviderId?: string;
  defaultModel?: string;
  defaultEmbeddingProviderId?: string;
  defaultEmbeddingModel?: string;
  similarityThreshold?: number;
  topK?: number;
  agents?: AgentId[];
  knowledgeNamespaces?: KnowledgeNamespaceConfig[];
  /**
   * Server-owned explicit sidebar position (station#3315). Assigned by the
   * reorder operation; projects without one list after positioned ones, in
   * name order, so an unordered workspace stays deterministic.
   */
  position?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMetadata {
  id: string;
  slug: string;
  name: string;
  icon?: string;
  description?: string;
  hasWorkingDirectory: boolean;
  workingDirectory?: string;
  layoutCount: number;
  hasKnowledge: boolean;
  defaultProviderId?: string;
  /** See {@link ProjectConfig.position}; the list route returns projects sorted by it. */
  position?: number;
}

export interface ProjectIconCandidate {
  /** Path relative to the selected workspace; never exposes another directory. */
  relativePath: string;
  /** Same-origin, in-memory image payload. Station never uploads discovered artwork. */
  dataUrl: string;
  mediaType: string;
  source: 'manifest' | 'favicon' | 'app-icon' | 'logo';
}

/**
 * The one derivation of "that project name is already taken", shared by the
 * server (`POST /api/projects`'s 409) and by the New Project modal's pre-POST
 * check (4-HOME-007). Both sides answer the same sentence from the same
 * inputs, so the modal cannot promise something the route would contradict.
 *
 * It lives in contracts rather than in either half because both halves are
 * consumers: `src-server/routes/projects/projects.ts` computes it from the
 * project store, `src-ui`'s `useNewProjectSlugAvailability` from the already
 * cached `['projects']` list.
 */
export interface ProjectSlugConflict {
  /** The slug the request would have created, which is already in use. */
  takenSlug: string;
  /** The first free `<slug>-N`, computed from the SAME set of taken slugs. */
  suggestedSlug: string;
}

/**
 * First unused `<base>-2`, `<base>-3`, … for a base slug that is taken.
 * Mirrors `ProjectService.createProject`'s own suffix loop for a caller that
 * omits a slug, so a suggestion and an auto-derived slug never disagree.
 */
export function nextAvailableProjectSlug(
  baseSlug: string,
  takenSlugs: Iterable<string>,
): string {
  const taken = new Set(takenSlugs);
  if (!taken.has(baseSlug)) return baseSlug;
  let suffix = 2;
  while (taken.has(`${baseSlug}-${suffix}`)) suffix += 1;
  return `${baseSlug}-${suffix}`;
}

/**
 * Resolves a create request against the project slugs that exist, or
 * `undefined` when the slug is free. `undefined` means "nothing is taken",
 * never "unknown" — a caller that has not loaded the project list must not
 * call this at all rather than read a false clearance from it.
 */
export function findProjectSlugConflict(
  slug: string,
  takenSlugs: Iterable<string>,
): ProjectSlugConflict | undefined {
  const taken = new Set(takenSlugs);
  if (!taken.has(slug)) return undefined;
  return {
    takenSlug: slug,
    suggestedSlug: nextAvailableProjectSlug(slug, taken),
  };
}

/** The sentence both halves render for {@link findProjectSlugConflict}. */
export function describeProjectSlugConflict(
  name: string,
  conflict: ProjectSlugConflict,
): string {
  return `A project called '${name}' already exists. The slug '${conflict.suggestedSlug}' is available.`;
}
