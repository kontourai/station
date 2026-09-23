/**
 * Station #90 lane D (station #122), review D5: the start-metadata key
 * carrying a session's Project identity (`ProjectConfig.id`), stamped by
 * `OrchestrationService` from this Station's own project list when the
 * session starts (`withSessionLocalProjectId`), never from caller input.
 *
 * A slug is local and reusable (`project-membership-service.ts` guards the
 * reuse case), so anything that keys authority on a Project must read this
 * recorded id rather than looking the slug up later.
 */
export const SESSION_LOCAL_PROJECT_ID_METADATA_KEY = 'localProjectId';

/**
 * Station #90 lane D (S2): stamped `true` at start when the session named a
 * Project this Station has, but its working directory could not be shown to
 * lie inside that Project. A reader must then report NO Project id rather
 * than falling back to looking the slug up: the fallback exists only for
 * sessions that predate the stamp. Restrict-only: a caller that sets it can
 * only remove its own session's Project id.
 */
export const SESSION_LOCAL_PROJECT_ID_REFUSED_METADATA_KEY =
  'localProjectIdRefused';
