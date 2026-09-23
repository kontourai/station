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
