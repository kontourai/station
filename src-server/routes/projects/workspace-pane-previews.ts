import { resolve } from 'node:path';
import {
  parseWorkspaceFileExistenceRequest,
  parseWorkspaceFilePreviewRequest,
  WORKSPACE_FILE_EXISTENCE_MAX_PATHS,
  WORKSPACE_FILE_PREVIEW_MAX_PATH_LENGTH,
  type WorkspaceFileExistenceRequest,
  type WorkspaceFilePreviewRequest,
} from '@kontourai/station-contracts/workspace-file-preview';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import { WorkspaceFilePreviewService } from '../../services/projects/workspace-file-preview-service.js';
import { expandTilde } from '../../utils/paths.js';
import { getBody, param, validate } from '../schemas/schemas.js';

/**
 * A session's thread id. When present the read targets that session's own
 * directory (an isolated worktree), not the project checkout (#2476).
 */
const threadField = z.string().min(1).max(200).optional();

const workspaceFilePreviewSchema = z
  .object({
    path: z.string(),
    thread: threadField,
    lineRange: z
      .object({
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  })
  .strict();

// HTML/PDF attachments are still a read, but POST keeps the selected
// workspace-relative path out of URLs, history, proxy keys, and referrers.
// Keep this leaf narrower than the regular preview request: line ranges have
// no meaning for an attachment handoff.
const workspaceFilePreviewDownloadSchema = z
  .object({ path: z.string(), thread: threadField })
  .strict();

// Which of a message's path mentions resolve to previewable files. The body
// bound admits the declared maximum of maximum-length paths plus JSON framing.
const workspaceFileExistenceSchema = z
  .object({
    paths: z
      .array(z.string().max(WORKSPACE_FILE_PREVIEW_MAX_PATH_LENGTH))
      .max(WORKSPACE_FILE_EXISTENCE_MAX_PATHS),
    thread: threadField,
  })
  .strict();
const WORKSPACE_FILE_EXISTENCE_MAX_BODY_BYTES =
  WORKSPACE_FILE_EXISTENCE_MAX_PATHS *
    (WORKSPACE_FILE_PREVIEW_MAX_PATH_LENGTH * 3 + 4) +
  64;

function encodeRfc5987Filename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Resolves the directory a session's files live in, for a caller allowed to
 * read that session: its isolated worktree, or `undefined` when it runs in the
 * project checkout. `null` refuses — the session is not the caller's to read
 * or not this project's — and is never answered from the checkout instead,
 * which would show a different copy of the file under a truthful name.
 */
export type SessionWorkspaceDirectory = (
  c: Context,
  projectSlug: string,
  thread: string,
) => Promise<string | undefined | null>;

/** Project-bound, read-only file-preview route. */
export function createWorkspacePanePreviewRoutes(
  projectService: Pick<ProjectService, 'getProject'>,
  previewService = new WorkspaceFilePreviewService(),
  sessionWorkspaceDirectory?: SessionWorkspaceDirectory,
) {
  const app = new Hono();

  /** The slug, or a 400 response. */
  const slugOf = (c: Context): string | Response => {
    try {
      const slug = param(c, 'slug');
      assertSafeLayoutPathSegment('project slug', slug);
      return slug;
    } catch {
      return c.json({ success: false, error: 'Invalid project slug' }, 400);
    }
  };

  /**
   * The directory a read targets: the session's own when `thread` names one,
   * else the project checkout. `undefined` when there is none to read.
   */
  const directoryFor = async (
    c: Context,
    slug: string,
    thread: string | undefined,
  ): Promise<string | undefined> => {
    if (thread) {
      const own = sessionWorkspaceDirectory
        ? await sessionWorkspaceDirectory(c, slug, thread)
        : null;
      if (own === null) return undefined;
      if (own !== undefined) return resolve(expandTilde(own));
    }
    try {
      // EXPAND: the preview service realpaths this. Raw, every file in the
      // pane rendered "unreadable" and every download 404'd — silently, and
      // indistinguishably from a genuinely unreadable file (archive#3155).
      const configured = (await projectService.getProject(slug))
        .workingDirectory;
      return configured ? resolve(expandTilde(configured)) : undefined;
    } catch {
      return undefined;
    }
  };

  app.post(
    '/download',
    validate(workspaceFilePreviewDownloadSchema, { maxBodyBytes: 4096 }),
    async (c) => {
      const slug = slugOf(c);
      if (typeof slug !== 'string') return slug;
      const { path, thread } = getBody(c) as { path: string; thread?: string };
      const workingDirectory = await directoryFor(c, slug, thread);
      if (!workingDirectory) {
        return c.json(
          { success: false, error: 'Project workspace is unavailable' },
          404,
        );
      }

      const download = previewService.download(workingDirectory, { path });
      if (!download) {
        // Do not disclose existence, workspace paths, or non-HTML/PDF contents
        // through a route whose only contract is a bounded attachment handoff.
        return c.json(
          { success: false, error: 'File handoff is unavailable' },
          404,
        );
      }
      return c.body(Uint8Array.from(download.bytes), 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeRfc5987Filename(download.filename)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': 'sandbox',
      });
    },
  );

  app.post(
    '/exists',
    validate(workspaceFileExistenceSchema, {
      maxBodyBytes: WORKSPACE_FILE_EXISTENCE_MAX_BODY_BYTES,
    }),
    async (c) => {
      const slug = slugOf(c);
      if (typeof slug !== 'string') return slug;
      let request: WorkspaceFileExistenceRequest;
      try {
        request = parseWorkspaceFileExistenceRequest(getBody(c));
      } catch {
        return c.json(
          { success: false, error: 'Invalid file existence request' },
          400,
        );
      }
      const workingDirectory = await directoryFor(c, slug, request.thread);
      // A project (or session) with no readable workspace has no previewable
      // files; that is an empty answer, not an error the chat would render.
      return c.json({
        success: true,
        data: {
          files: workingDirectory
            ? previewService.existingFiles(workingDirectory, request.paths)
            : [],
        },
      });
    },
  );

  app.post(
    '/',
    validate(workspaceFilePreviewSchema, { maxBodyBytes: 4096 }),
    async (c) => {
      const slug = slugOf(c);
      if (typeof slug !== 'string') return slug;

      let request: WorkspaceFilePreviewRequest;
      try {
        request = parseWorkspaceFilePreviewRequest(getBody(c));
      } catch {
        return c.json(
          { success: false, error: 'Invalid file preview request' },
          400,
        );
      }

      const workingDirectory = await directoryFor(c, slug, request.thread);
      if (!workingDirectory) {
        return c.json(
          { success: false, error: 'Project workspace is unavailable' },
          404,
        );
      }

      try {
        return c.json({
          success: true,
          data: previewService.preview(workingDirectory, request),
        });
      } catch {
        // Deliberately do not mirror rejected filesystem input or host paths.
        return c.json(
          { success: false, error: 'Invalid file preview path' },
          400,
        );
      }
    },
  );

  return app;
}
