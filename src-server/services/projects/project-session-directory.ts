import type { ProjectManifestSource } from './project-manifest-store.js';
import { ProjectManifestStore } from './project-manifest-store.js';
import { ProjectResourceResolver } from './project-resource-resolver.js';

/** Resolve a new engine start on this Station. Reading never attaches or repairs. */
export function createProjectSessionDirectoryResolver(
  homeDir: string,
  source: ProjectManifestSource,
): (slug: string) => Promise<string | undefined> {
  const manifests = new ProjectManifestStore(homeDir, source);
  const resolver = new ProjectResourceResolver({ homeDir, source, manifests });
  return async (slug) => {
    const result = await resolver.resolveProjectResource(slug);
    if (result.state === 'bound') return result.path;
    if (result.state === 'unbound') {
      const project = source.getProject(slug);
      const manifest = manifests.readProjectManifest(slug);
      // An organizational Project has no intended checkout. An imported Git
      // Project without a binding must be repaired, never launched in HOME.
      const resource = manifest?.repos.find(
        (entry) => entry.id === result.resourceId,
      );
      // Presence only: path expansion and filesystem reads belong to the resolver above.
      if (
        !project.workingDirectory &&
        (!manifest || resource?.kind === 'local-only')
      )
        return undefined;
    }
    throw new Error(
      `Project '${slug}' cannot start here (${result.state}): ${result.reason}`,
    );
  };
}
