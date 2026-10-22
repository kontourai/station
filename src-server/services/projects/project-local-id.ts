/**
 * One Project identity for comparisons (#4003 verifier V1).
 *
 * A Task's `projectId`, and so the room execution binding dispatch writes
 * from it, is whatever the Task's creator named: TaskGraph's UI ingress
 * records the Project slug, newer callers its opaque id. A Session's Station
 * Control scope carries the Project's opaque id (`localProjectId`). The two
 * are the same Project only when both resolve to the same Project record, so
 * every comparison between them goes through this lookup instead of a string
 * compare. An identity no current Project carries resolves to nothing.
 */
export interface ProjectIdentityLookup {
  listProjects(): ReadonlyArray<{ readonly id: string; readonly slug: string }>;
}

/**
 * The opaque id of the Project `identity` (an id or a slug) names, if any.
 * An exact id match wins over a slug match, so a slug that equals another
 * Project's id cannot make the answer depend on list order.
 */
export function localProjectIdFor(
  projects: ProjectIdentityLookup,
  identity: string,
): string | undefined {
  const listed = projects.listProjects();
  return (
    listed.find((project) => project.id === identity)?.id ??
    listed.find((project) => project.slug === identity)?.id
  );
}
