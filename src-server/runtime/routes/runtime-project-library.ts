import {
  createProjectLibraryRoutes,
  createSessionProjectLibraryRoutes,
  type ProjectLibraryAdmission,
  type ProjectLibraryOutputsPort,
  type ProjectLibraryPreview,
  type ProjectLibraryProject,
} from '../../routes/projects/project-library-routes.js';
import { ProjectLibraryUploads } from '../../services/projects/project-library-uploads.js';

/**
 * #5067: the Project Library's two mounts, or nothing on a hosted Station.
 * Uploads live in the Station home and Task outputs are a personal-home
 * store, so a hosted tenant has neither; `servesProjectLibrary` withdraws
 * the handshake flag from the same fact.
 */
export function composeProjectLibraryRoutes(input: {
  hosted: boolean;
  homeDir: string;
  /** Selected at every route; off answers the typed preview refusal. */
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
  const deps = {
    uploads: new ProjectLibraryUploads({ homeDir: input.homeDir }),
    preview: input.preview,
    ...(input.outputs ? { outputs: input.outputs } : {}),
    readTask: input.readTask,
  };
  return {
    /** Mount at `/api/projects`. */
    projectRoutes: createProjectLibraryRoutes({
      ...deps,
      authorize: (request, slug) =>
        input.isInternalRequest(request)
          ? Promise.resolve(undefined)
          : input.authorize(request, slug),
    }),
    /** Mount at `/api/orchestration`. */
    sessionRoutes: createSessionProjectLibraryRoutes({
      ...deps,
      isInternalRequest: input.isInternalRequest,
      projectById: input.projectById,
    }),
  };
}
