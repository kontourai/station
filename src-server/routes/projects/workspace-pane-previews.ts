import { resolve } from 'node:path';
import {
  parseWorkspaceFilePreviewRequest,
  type WorkspaceFilePreviewRequest,
} from '@kontourai/station-contracts/workspace-file-preview';
import { Hono } from 'hono';
import { z } from 'zod/v3';
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import { WorkspaceFilePreviewService } from '../../services/projects/workspace-file-preview-service.js';
import { expandTilde } from '../../utils/paths.js';
import { getBody, param, validate } from '../schemas/schemas.js';

const workspaceFilePreviewSchema = z
  .object({
    path: z.string(),
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
  .object({ path: z.string() })
  .strict();

function encodeRfc5987Filename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Project-bound, read-only file-preview route. */
export function createWorkspacePanePreviewRoutes(
  projectService: Pick<ProjectService, 'getProject'>,
  previewService = new WorkspaceFilePreviewService(),
) {
  const app = new Hono();

  app.post(
    '/download',
    validate(workspaceFilePreviewDownloadSchema, { maxBodyBytes: 4096 }),
    async (c) => {
      let slug: string;
      try {
        slug = param(c, 'slug');
        assertSafeLayoutPathSegment('project slug', slug);
      } catch {
        return c.json({ success: false, error: 'Invalid project slug' }, 400);
      }
      const { path } = getBody(c) as { path: string };

      let workingDirectory: string | undefined;
      try {
        // EXPAND: the preview service realpaths this. Raw, every file in the
        // pane rendered "unreadable" and every download 404'd — silently, and
        // indistinguishably from a genuinely unreadable file (archive#3155).
        const configured = (await projectService.getProject(slug))
          .workingDirectory;
        workingDirectory = configured
          ? resolve(expandTilde(configured))
          : configured;
      } catch {
        return c.json(
          { success: false, error: 'Project workspace is unavailable' },
          404,
        );
      }
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
    '/',
    validate(workspaceFilePreviewSchema, { maxBodyBytes: 4096 }),
    async (c) => {
      let slug: string;
      try {
        slug = param(c, 'slug');
        assertSafeLayoutPathSegment('project slug', slug);
      } catch {
        return c.json({ success: false, error: 'Invalid project slug' }, 400);
      }

      let workingDirectory: string | undefined;
      try {
        // EXPAND: the preview service realpaths this. Raw, every file in the
        // pane rendered "unreadable" and every download 404'd — silently, and
        // indistinguishably from a genuinely unreadable file (archive#3155).
        const configured = (await projectService.getProject(slug))
          .workingDirectory;
        workingDirectory = configured
          ? resolve(expandTilde(configured))
          : configured;
      } catch {
        return c.json(
          { success: false, error: 'Project workspace is unavailable' },
          404,
        );
      }
      if (!workingDirectory) {
        return c.json(
          { success: false, error: 'Project workspace is unavailable' },
          404,
        );
      }

      let request: WorkspaceFilePreviewRequest;
      try {
        request = parseWorkspaceFilePreviewRequest(getBody(c));
      } catch {
        return c.json(
          { success: false, error: 'Invalid file preview request' },
          400,
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
