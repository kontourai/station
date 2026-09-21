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
  return (slug) => resolver.resolveProjectExecutionRoot(slug);
}
