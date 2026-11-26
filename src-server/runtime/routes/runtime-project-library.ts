import {
  createProjectLibraryRoutes,
  createSessionProjectLibraryRoutes,
  type ProjectLibraryAdmission,
  type ProjectLibraryDeps,
  type ProjectLibraryOutputsPort,
  type ProjectLibraryPreview,
  type ProjectLibraryProject,
} from '../../routes/projects/project-library-routes.js';
import { ProjectLibraryUploads } from '../../services/projects/project-library-uploads.js';

/**
 * #5067: what the Project Library's two route factories take, or nothing on
 * a hosted Station. The runtime calls the factories itself, at the mount, so
 * the pairing-scope leaf scan reads every Library leaf.
 */
export function composeProjectLibraryDeps(input: {
  hosted: boolean;
  homeDir: string;
  preview: ProjectLibraryPreview;
  outputs?: ProjectLibraryOutputsPort;
  readTask(
    taskId: string,
  ): { title: string; createdAt: string; projectId: string } | null;
  isInternalRequest(request: Request): boolean;
  projectById(projectId: string): ProjectLibraryProject | undefined;
  authorize(
    request: Request,
    slug: string,
  ): Promise<ProjectLibraryAdmission | undefined>;
}) {
  if (input.hosted) return undefined;
  const deps: ProjectLibraryDeps = {
    uploads: new ProjectLibraryUploads({ homeDir: input.homeDir }),
    preview: input.preview,
    ...(input.outputs ? { outputs: input.outputs } : {}),
    readTask: input.readTask,
  };
  return {
    /** For `createProjectLibraryRoutes`, mounted at `/api/projects`. */
    project: {
      ...deps,
      authorize: (request: Request, slug: string) =>
        input.isInternalRequest(request)
          ? Promise.resolve(undefined)
          : input.authorize(request, slug),
    },
    /** For `createSessionProjectLibraryRoutes`, mounted at `/api/orchestration`. */
    session: {
      ...deps,
      isInternalRequest: input.isInternalRequest,
      projectById: input.projectById,
    },
  };
}

/**
 * #5067: the Project Library's two mounts, or nothing on a hosted Station,
 * built from {@link composeProjectLibraryDeps}. Tests and the capability-flag
 * probe mount these; the runtime calls the factories at its own mount.
 */
export function composeProjectLibraryRoutes(
  input: Parameters<typeof composeProjectLibraryDeps>[0],
) {
  const deps = composeProjectLibraryDeps(input);
  if (!deps) return undefined;
  return {
    /** Mount at `/api/projects`. */
    projectRoutes: createProjectLibraryRoutes(deps.project),
    /** Mount at `/api/orchestration`. */
    sessionRoutes: createSessionProjectLibraryRoutes(deps.session),
  };
}
