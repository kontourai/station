/**
 * Project Library transport (#5067). The Library is a projection: uploads are
 * read from the Project's Library folder and Task outputs from the Task output
 * store. Nothing is copied between them.
 *
 * Two mounts share one projection:
 * - `/api/projects/:slug/library…` for a person operating the Project;
 * - `/api/orchestration/station-control/project-library…` for a Session's own
 *   Project, derived from the verified station-control caller (never from the
 *   request), so every Session in a Project can read what people added.
 */
import {
  PROJECT_LIBRARY_UPLOAD_MAX_BYTES,
  PROJECT_LIBRARY_V1,
  type ProjectLibraryPage,
  type ProjectLibraryTaskOutput,
  sortProjectLibraryItems,
} from '@kontourai/station-contracts/project-library';
import type { TaskOutputRecord } from '@kontourai/station-contracts/task-graph';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBodyBytes } from '../../security/bounded-request-body.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  ProjectLibraryNotFoundError,
  ProjectLibraryPathError,
  ProjectLibraryTooLargeError,
  type ProjectLibraryUploads,
} from '../../services/projects/project-library-uploads.js';
import {
  type TaskOutputDeclarationSource,
  TaskOutputNotFoundError,
} from '../../services/projects/task-output-module.js';
import { isBoundedSafePng } from '../../services/projects/workspace-file-preview-service.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'project-library-routes' });
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;
/** Text a Session may read through station-control, per call. */
const SESSION_READ_MAX_TEXT_BYTES = 256 * 1024;

export interface ProjectLibraryOutputsPort {
  listForProject(projectKeys: readonly string[]): Promise<
    readonly (TaskOutputRecord & {
      taskCreatedAt?: string;
      declaredBy?: TaskOutputDeclarationSource;
    })[]
  >;
  readContentForProject(
    projectKeys: readonly string[],
    outputId: string,
  ): Promise<{ output: TaskOutputRecord; bytes: Buffer }>;
}

/** A Project as the Library sees it: uploads key on `id`; Tasks name it by id or slug. */
export interface ProjectLibraryProject {
  id: string;
  slug: string;
}

const projectKeys = (project: ProjectLibraryProject) =>
  project.slug === project.id ? [project.id] : [project.id, project.slug];

/** The `project-library` Feature Preview's branch selector. */
export interface ProjectLibraryPreview {
  select<T>(branches: { enabled: () => T; disabled: () => T }): T;
}

const PROJECT_LIBRARY_PREVIEW_ID = 'project-library';

/** The typed refusal every Library route answers while the preview is off. */
function previewDisabled(c: Context) {
  return c.json(
    {
      success: false,
      error:
        'Enable Project Library in Settings → Advanced → Feature previews.',
      code: 'feature_preview_disabled',
      previewId: PROJECT_LIBRARY_PREVIEW_ID,
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews',
    },
    404,
    NO_STORE,
  );
}

/** Off: refuse before any Library work, read or write. */
function gated(
  preview: ProjectLibraryPreview,
  handler: (c: Context) => Promise<Response>,
) {
  return (c: Context) =>
    preview.select({
      enabled: () => handler(c),
      disabled: () => Promise.resolve(previewDisabled(c)),
    });
}

export interface ProjectLibraryDeps {
  uploads: ProjectLibraryUploads;
  preview: ProjectLibraryPreview;
  /** Absent: this Station keeps no Task outputs (hosted), so none are listed. */
  outputs?: ProjectLibraryOutputsPort;
  readTask(
    taskId: string,
  ): { title: string; createdAt: string; projectId: string } | null;
}

/** The Library page for one Project: uploads and Task outputs, newest first. */
async function readProjectLibrary(
  deps: ProjectLibraryDeps,
  project: ProjectLibraryProject,
): Promise<ProjectLibraryPage> {
  const keys = projectKeys(project);
  let partial = false;
  const [uploads, outputs] = await Promise.all([
    deps.uploads.list(project.id).catch((error) => {
      logger.warn('Project Library uploads unreadable', {
        error: error instanceof Error ? error.message : 'non-Error thrown',
      });
      partial = true;
      return { uploads: [], truncated: false };
    }),
    deps.outputs
      ? deps.outputs.listForProject(keys).catch((error) => {
          logger.warn('Project Library Task outputs unreadable', {
            error: error instanceof Error ? error.message : 'non-Error thrown',
          });
          partial = true;
          return [];
        })
      : Promise.resolve([]),
  ]);
  const taskOutputs = outputs.map((output): ProjectLibraryTaskOutput => {
    const task = deps.readTask(output.taskId);
    // The same Task, not merely the same id: a Task recreated under a reused
    // id does not adopt the deleted Task's files.
    const present =
      task !== null &&
      keys.includes(task.projectId) &&
      (output.taskCreatedAt === undefined ||
        output.taskCreatedAt === task.createdAt);
    return {
      kind: 'task-output',
      outputId: output.id,
      taskId: output.taskId,
      title: output.title,
      fileName: output.materialization.fileName,
      sourcePath: output.source.relativePath,
      mediaType: output.materialization.mediaType,
      byteLength: output.materialization.byteLength,
      contentAvailable: output.materialization.contentAvailable,
      createdAt: output.createdAt,
      task: present
        ? { state: 'present', title: task.title }
        : { state: 'orphaned' },
      ...(output.declaredBy ? { sessionId: output.declaredBy.sessionId } : {}),
    };
  });
  return {
    version: PROJECT_LIBRARY_V1,
    projectId: project.id,
    items: sortProjectLibraryItems([...uploads.uploads, ...taskOutputs]),
    partial,
    truncated: uploads.truncated,
  };
}

function contentResponse(
  bytes: Buffer,
  mediaType: string,
  fileName: string,
  etag?: string,
): Response {
  // Only plain text, JSON and a strictly validated PNG are ever inline; any
  // other type downloads, so Station never renders or runs a Library file.
  const textPreview =
    mediaType === 'text/plain' ||
    mediaType === 'text/markdown' ||
    mediaType === 'text/csv' ||
    mediaType === 'application/json';
  const safePng = mediaType === 'image/png' && isBoundedSafePng(bytes);
  const type = textPreview || safePng ? mediaType : 'application/octet-stream';
  const safeName =
    fileName.replace(/[\r\n"]/g, '').replace(/[^A-Za-z0-9._-]/g, '_') ||
    'library-file';
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      ...(etag ? { ETag: `"${etag}"` } : {}),
      ...NO_STORE,
      'Content-Disposition': `${textPreview || safePng ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      ...(safePng ? { 'X-Station-Safe-Preview': 'image/png' } : {}),
    },
  });
}

function respondError(c: Context, error: unknown) {
  if (error instanceof ProjectLibraryPathError)
    return c.json(
      {
        success: false,
        code: 'library-path-invalid',
        error:
          'This path cannot be in the Library. Hidden files and node_modules are skipped.',
      },
      400,
      NO_STORE,
    );
  if (error instanceof ProjectLibraryTooLargeError)
    return c.json(
      {
        success: false,
        code: 'library-file-too-large',
        error: `Library files can be up to ${PROJECT_LIBRARY_UPLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
      },
      413,
      NO_STORE,
    );
  if (
    error instanceof ProjectLibraryNotFoundError ||
    error instanceof TaskOutputNotFoundError
  )
    return c.json(
      { success: false, error: 'Library file not found' },
      404,
      NO_STORE,
    );
  logger.error('Project Library request failed', {
    error: error instanceof Error ? error.message : 'non-Error thrown',
  });
  return c.json(
    { success: false, error: 'Library is unavailable' },
    503,
    NO_STORE,
  );
}

export interface ProjectLibraryAdmission {
  project: ProjectLibraryProject;
  isCurrent(): boolean | Promise<boolean>;
}

/** Person-facing routes, mounted at `/api/projects`. */
export function createProjectLibraryRoutes(
  deps: ProjectLibraryDeps & {
    authorize(
      request: Request,
      slug: string,
    ): Promise<ProjectLibraryAdmission | undefined>;
  },
) {
  const app = new Hono();
  const notFound = (c: Context) =>
    c.json({ success: false, error: 'Project not found' }, 404, NO_STORE);
  const admit = async (c: Context) => {
    const slug = c.req.param('slug');
    if (!slug) return undefined;
    const admission = await deps.authorize(c.req.raw, slug);
    if (!admission || !(await admission.isCurrent())) return undefined;
    return admission;
  };
  const pathParam = (c: Context) => c.req.query('path') ?? '';

  app.get(
    '/:slug/library',
    gated(deps.preview, async (c) => {
      const admission = await admit(c);
      if (!admission) return notFound(c);
      try {
        const page = await readProjectLibrary(deps, admission.project);
        if (!(await admission.isCurrent())) return notFound(c);
        return c.json({ success: true, data: page }, 200, NO_STORE);
      } catch (error) {
        return respondError(c, error);
      }
    }),
  );

  app.get(
    '/:slug/library/uploads/content',
    gated(deps.preview, async (c) => {
      const admission = await admit(c);
      if (!admission) return notFound(c);
      try {
        const { upload, bytes } = await deps.uploads.read(
          admission.project.id,
          pathParam(c),
        );
        if (!(await admission.isCurrent())) return notFound(c);
        return contentResponse(
          bytes,
          upload.mediaType,
          upload.relativePath.slice(upload.relativePath.lastIndexOf('/') + 1),
        );
      } catch (error) {
        return respondError(c, error);
      }
    }),
  );

  app.put(
    '/:slug/library/uploads',
    gated(deps.preview, async (c) => {
      const admission = await admit(c);
      if (!admission) return notFound(c);
      const declared = c.req.header('content-length');
      if (
        declared !== undefined &&
        (!/^\d+$/.test(declared) ||
          Number(declared) > PROJECT_LIBRARY_UPLOAD_MAX_BYTES)
      )
        return respondError(c, new ProjectLibraryTooLargeError('too large'));
      const body = await readBoundedRequestBodyBytes(
        c.req.raw,
        PROJECT_LIBRARY_UPLOAD_MAX_BYTES,
      );
      if (body.status === 'too-large')
        return respondError(c, new ProjectLibraryTooLargeError('too large'));
      const bytes =
        body.status === 'ok'
          ? body.bytes
          : body.status === 'no-body'
            ? new Uint8Array()
            : undefined;
      if (!bytes)
        return c.json(
          { success: false, error: 'The upload did not finish. Try again.' },
          400,
          NO_STORE,
        );
      try {
        if (!(await admission.isCurrent())) return notFound(c);
        const upload = await deps.uploads.write(
          admission.project.id,
          pathParam(c),
          bytes,
        );
        return c.json({ success: true, data: upload }, 201, NO_STORE);
      } catch (error) {
        return respondError(c, error);
      }
    }),
  );

  app.delete(
    '/:slug/library/uploads',
    gated(deps.preview, async (c) => {
      const admission = await admit(c);
      if (!admission) return notFound(c);
      try {
        await deps.uploads.remove(admission.project.id, pathParam(c));
        return c.json(
          { success: true, data: { deleted: true } },
          200,
          NO_STORE,
        );
      } catch (error) {
        return respondError(c, error);
      }
    }),
  );

  app.get(
    '/:slug/library/outputs/:outputId/content',
    gated(deps.preview, async (c) => {
      const admission = await admit(c);
      if (!admission) return notFound(c);
      if (!deps.outputs) return respondError(c, new TaskOutputNotFoundError());
      try {
        const { output, bytes } = await deps.outputs.readContentForProject(
          projectKeys(admission.project),
          c.req.param('outputId') ?? '',
        );
        if (!(await admission.isCurrent())) return notFound(c);
        return contentResponse(
          bytes,
          output.materialization.mediaType,
          output.materialization.fileName,
          output.materialization.digest,
        );
      } catch (error) {
        return respondError(c, error);
      }
    }),
  );

  return app;
}

/**
 * The Session side, mounted at `/api/orchestration`. Only Station's own
 * station-control tool code reaches it; the Project is the one Station
 * recorded for the calling Session when it started.
 */
export function createSessionProjectLibraryRoutes(
  deps: ProjectLibraryDeps & {
    isInternalRequest(request: Request): boolean;
    /** The Project with this id now, if it still exists. */
    projectById(projectId: string): ProjectLibraryProject | undefined;
  },
) {
  const app = new Hono();
  const callerProject = (
    c: Context,
  ): { project: ProjectLibraryProject } | { refusal: Response } => {
    if (!deps.isInternalRequest(c.req.raw))
      return {
        refusal: c.json({ error: { code: 'not_found' } }, 404, NO_STORE),
      };
    const authority = stationControlRequestAuthority(c.req.raw);
    if (authority?.kind !== 'caller')
      return {
        refusal: c.json(
          stationControlRefusalBody(
            stationControlRefusal('station_control_caller_required'),
          ),
          403,
          NO_STORE,
        ),
      };
    // Only the Project Station stamped on the Session when it started: a slug
    // looked up now could name a different Project that reused it.
    const projectId =
      authority.caller.projectIdSource === 'session-record'
        ? authority.caller.localProjectId
        : undefined;
    const project = projectId ? deps.projectById(projectId) : undefined;
    if (!project)
      return {
        refusal: c.json(
          {
            success: false,
            code: 'no_project',
            error:
              'This session was not started in a Project, so it has no Project Library. Start a new session in the Project.',
          },
          409,
          NO_STORE,
        ),
      };
    return { project };
  };

  app.get(
    '/station-control/project-library',
    gated(deps.preview, async (c) => {
      const caller = callerProject(c);
      if ('refusal' in caller) return caller.refusal;
      try {
        return c.json(
          {
            success: true,
            data: await readProjectLibrary(deps, caller.project),
          },
          200,
          NO_STORE,
        );
      } catch (error) {
        return respondError(c, error);
      }
    }),
  );

  app.get(
    '/station-control/project-library/file',
    gated(deps.preview, async (c) => {
      const caller = callerProject(c);
      if ('refusal' in caller) return caller.refusal;
      const path = c.req.query('path');
      const outputId = c.req.query('outputId');
      if ((path === undefined) === (outputId === undefined))
        return c.json(
          {
            success: false,
            code: 'library_file_target_invalid',
            error: 'Name exactly one of path (an upload) or outputId.',
          },
          400,
          NO_STORE,
        );
      try {
        let bytes: Buffer;
        let mediaType: string;
        let name: string;
        if (path !== undefined) {
          const read = await deps.uploads.read(caller.project.id, path);
          bytes = read.bytes;
          mediaType = read.upload.mediaType;
          name = read.upload.relativePath;
        } else {
          if (!deps.outputs) throw new TaskOutputNotFoundError();
          const read = await deps.outputs.readContentForProject(
            projectKeys(caller.project),
            outputId!,
          );
          bytes = read.bytes;
          mediaType = read.output.materialization.mediaType;
          name = read.output.materialization.fileName;
        }
        const text = isReadableText(bytes);
        return c.json(
          {
            success: true,
            data: text
              ? {
                  name,
                  mediaType,
                  byteLength: bytes.byteLength,
                  encoding: 'utf-8',
                  truncated: bytes.byteLength > SESSION_READ_MAX_TEXT_BYTES,
                  text: bytes
                    .subarray(0, SESSION_READ_MAX_TEXT_BYTES)
                    .toString('utf8'),
                }
              : {
                  name,
                  mediaType,
                  byteLength: bytes.byteLength,
                  encoding: 'base64',
                  truncated: bytes.byteLength > SESSION_READ_MAX_TEXT_BYTES,
                  base64: bytes
                    .subarray(0, SESSION_READ_MAX_TEXT_BYTES)
                    .toString('base64'),
                },
          },
          200,
          NO_STORE,
        );
      } catch (error) {
        return respondError(c, error);
      }
    }),
  );

  return app;
}

/** UTF-8 with no NUL in the first 8 KiB reads as text. */
function isReadableText(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8 * 1024);
  if (head.includes(0)) return false;
  try {
    // `stream` tolerates a multi-byte character cut by the bound.
    new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, SESSION_READ_MAX_TEXT_BYTES),
      { stream: bytes.byteLength > SESSION_READ_MAX_TEXT_BYTES },
    );
    return true;
  } catch {
    return false;
  }
}
