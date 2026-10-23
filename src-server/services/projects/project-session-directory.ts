import { statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalPath,
  isCanonicalPathWithin,
} from '../../utils/path-containment.js';
import { ProjectBindingsStore } from './project-binding-store.js';
import type { ProjectManifestSource } from './project-manifest-store.js';
import { ProjectManifestStore } from './project-manifest-store.js';
import { ProjectResourceResolver } from './project-resource-resolver.js';

export interface RetainedProjectSessionDirectory {
  localProjectId: string;
  cwd: string;
}

/** Resolve a start or reauthorize a retained Session folder; never attach on read. */
export function createProjectSessionDirectoryResolver(
  homeDir: string,
  source: ProjectManifestSource,
): (
  slug: string,
  retained?: RetainedProjectSessionDirectory,
) => Promise<string | undefined> {
  const bindings = new ProjectBindingsStore(homeDir);
  const manifests = new ProjectManifestStore(homeDir, source);
  const resolver = new ProjectResourceResolver({
    homeDir,
    source,
    manifests,
    bindings,
  });
  return async (slug, retained) => {
    if (!retained) return resolver.resolveProjectExecutionRoot(slug);
    const project = source.getProject(slug);
    if (project.id !== retained.localProjectId)
      throw new Error('The Session Project identity changed.');
    // The stored canonical coordinate is immutable, including after a path is
    // replaced by a symlink. A fresh resource match alone cannot rebind it.
    if (
      canonicalPath(retained.cwd) !== retained.cwd ||
      !statSync(retained.cwd).isDirectory()
    )
      throw new Error('The Session workspace directory changed.');
    const manifest = manifests.readProjectManifest(slug);
    // A pre-manifest Project has only its current working-directory resource.
    const resourceIds = manifest
      ? manifest.repos.map((resource) => resource.id)
      : [undefined];
    for (const resourceId of resourceIds) {
      const binding =
        manifest && resourceId
          ? bindings.findBinding(manifest.id, resourceId)
          : undefined;
      const result = await resolver.resolveProjectResource(slug, resourceId);
      if (
        result.state === 'bound' &&
        isCanonicalPathWithin(canonicalPath(result.path), retained.cwd)
      ) {
        const currentProject = source.getProject(slug);
        const currentManifest = manifests.readProjectManifest(slug);
        const currentBinding =
          manifest && resourceId
            ? bindings.findBinding(manifest.id, resourceId)
            : undefined;
        if (
          currentProject.id !== retained.localProjectId ||
          currentProject.workingDirectory !== project.workingDirectory ||
          !isDeepStrictEqual(currentManifest?.repos, manifest?.repos) ||
          !isDeepStrictEqual(currentBinding, binding) ||
          canonicalPath(retained.cwd) !== retained.cwd
        )
          throw new Error(
            'The Session Project resource changed during verification.',
          );
        return retained.cwd;
      }
    }
    throw new Error(
      'The Session workspace is no longer an authorized Project resource.',
    );
  };
}
