/**
 * The one place a Project Session's starting context is read (#5062, #5065):
 * the Project brief from the Project record and the memory index from the
 * memory store, composed by the contracts' `composeProjectSessionContext`.
 *
 * Station's start choke point (`OrchestrationService`) calls
 * {@link ProjectSessionContextSource.resolve} once per new Session and stamps
 * the result on the start, so every engine (Station's, Claude Code, Codex,
 * ACP), delegated Sessions and scheduled runs receive the same text on their
 * first turn. A Project conversation that coordinates work (#5063) reads its
 * context through the same function.
 *
 * Every call reads the Project record and the notes from disk. There is no
 * cache: an edit or a forgotten note reaches the next Session, and a running
 * Session keeps what it started with.
 */
import { createHash } from 'node:crypto';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  composeProjectSessionContext,
  type ProjectSessionContext,
} from '@kontourai/station-contracts/project-session-context';
import type { ProjectMemoryStore } from './project-memory-store.js';

export interface ProjectSessionContextSource {
  /** What a new Session in this Project starts from; `undefined` for none. */
  resolve(projectSlug: string): Promise<ProjectSessionContext | undefined>;
}

export function createProjectSessionContextSource(deps: {
  getProject(slug: string): ProjectConfig | undefined;
  memory: Pick<ProjectMemoryStore, 'listSummaries'>;
}): ProjectSessionContextSource {
  return {
    async resolve(projectSlug) {
      const project = deps.getProject(projectSlug);
      if (!project) return undefined;
      const notes = await deps.memory.listSummaries(projectSlug);
      return composeProjectSessionContext({
        projectSlug: project.slug,
        projectName: project.name,
        ...(project.goal ? { goal: project.goal } : {}),
        ...(project.instructions ? { instructions: project.instructions } : {}),
        notes,
      });
    },
  };
}

/** sha-256 of the composed text: the turn's receipt names what it carried. */
export function projectSessionContextDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
