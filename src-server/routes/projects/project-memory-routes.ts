/**
 * #5065: Project memory notes, read and edited in Project settings › Memory.
 *
 * `GET    /api/projects/:slug/memory`       the index (notes without bodies)
 * `GET    /api/projects/:slug/memory/:id`   one note
 * `POST   /api/projects/:slug/memory`       save a note
 * `PUT    /api/projects/:slug/memory/:id`   change a note
 * `DELETE /api/projects/:slug/memory/:id`   forget a note
 *
 * Behind the `project-coordination` Feature Preview (a typed 404 while off).
 * Memory is the Project owner's until multiplayer Projects (#3278) decide
 * its audience, so every leaf requires the Station operator. Agents reach
 * the same store through Station Control tools, not these routes.
 */
import {
  PROJECT_MEMORY_NOTE_ID_PATTERN,
  type ProjectMemoryNoteAuthor,
  parseProjectMemoryNoteWrite,
} from '@kontourai/station-contracts/project-session-context';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  PROJECT_MEMORY_FULL_MESSAGE,
  ProjectMemoryLimitError,
  type ProjectMemoryStore,
} from '../../services/projects/project-memory-store.js';

const MAX_BODY_BYTES = 32 * 1024;

export interface ProjectMemoryRouteDeps {
  enabled(): boolean;
  memory: ProjectMemoryStore;
  projectExists(slug: string): boolean;
  /** The operator as a note author, or `undefined` for anyone else. */
  authorize(request: Request): Promise<ProjectMemoryNoteAuthor | undefined>;
}

function previewDisabled(c: Context) {
  return c.json(
    {
      success: false,
      code: 'feature_preview_disabled',
      previewId: 'project-coordination',
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews',
      error: 'Enable Project brief, memory and models in Feature previews.',
    },
    404,
  );
}

export function createProjectMemoryRoutes(deps: ProjectMemoryRouteDeps) {
  const app = new Hono();

  /** Preview, Project and caller checks every leaf shares. */
  async function admit(
    c: Context,
  ): Promise<
    | { ok: true; slug: string; author: ProjectMemoryNoteAuthor }
    | { ok: false; response: Response }
  > {
    if (!deps.enabled()) return { ok: false, response: previewDisabled(c) };
    const slug = c.req.param('slug') ?? '';
    if (!slug || !deps.projectExists(slug))
      return {
        ok: false,
        response: c.json({ success: false, error: 'Project not found' }, 404),
      };
    const author = await deps.authorize(c.req.raw);
    if (!author)
      return {
        ok: false,
        response: c.json(
          {
            success: false,
            code: 'restricted',
            error: "Only this Project's owner can see its memory.",
          },
          403,
        ),
      };
    return { ok: true, slug, author };
  }

  async function readWrite(c: Context) {
    const body = await readBoundedRequestBody(c.req.raw, MAX_BODY_BYTES);
    if (body.status !== 'ok')
      return {
        ok: false as const,
        response: c.json(
          { success: false, error: 'The note is too large or unreadable.' },
          body.status === 'too-large' ? 413 : 400,
        ),
      };
    let value: unknown;
    try {
      value = JSON.parse(body.body);
    } catch {
      return {
        ok: false as const,
        response: c.json({ success: false, error: 'Invalid note' }, 400),
      };
    }
    const parsed = parseProjectMemoryNoteWrite(value);
    if (!parsed.ok)
      return {
        ok: false as const,
        response: c.json({ success: false, error: parsed.reason }, 400),
      };
    return { ok: true as const, write: parsed.write };
  }

  const noteId = (c: Context) => {
    const id = c.req.param('id') ?? '';
    return PROJECT_MEMORY_NOTE_ID_PATTERN.test(id) ? id : undefined;
  };

  app.get('/:slug/memory', async (c) => {
    c.header('Cache-Control', 'no-store');
    const admitted = await admit(c);
    if (!admitted.ok) return admitted.response;
    const notes = await deps.memory.listSummaries(admitted.slug);
    return c.json({
      success: true,
      data: { projectSlug: admitted.slug, notes },
    });
  });

  app.get('/:slug/memory/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const admitted = await admit(c);
    if (!admitted.ok) return admitted.response;
    const id = noteId(c);
    const note = id ? await deps.memory.getNote(admitted.slug, id) : undefined;
    if (!note) return c.json({ success: false, error: 'Note not found' }, 404);
    return c.json({ success: true, data: note });
  });

  app.post('/:slug/memory', async (c) => {
    const admitted = await admit(c);
    if (!admitted.ok) return admitted.response;
    const body = await readWrite(c);
    if (!body.ok) return body.response;
    try {
      const note = await deps.memory.createNote(
        admitted.slug,
        body.write,
        admitted.author,
      );
      return c.json({ success: true, data: note }, 201);
    } catch (error) {
      if (error instanceof ProjectMemoryLimitError)
        return c.json(
          {
            success: false,
            code: error.code,
            error: PROJECT_MEMORY_FULL_MESSAGE,
          },
          409,
        );
      throw error;
    }
  });

  app.put('/:slug/memory/:id', async (c) => {
    const admitted = await admit(c);
    if (!admitted.ok) return admitted.response;
    const id = noteId(c);
    if (!id) return c.json({ success: false, error: 'Note not found' }, 404);
    const body = await readWrite(c);
    if (!body.ok) return body.response;
    const note = await deps.memory.updateNote(
      admitted.slug,
      id,
      body.write,
      admitted.author,
    );
    if (!note) return c.json({ success: false, error: 'Note not found' }, 404);
    return c.json({ success: true, data: note });
  });

  app.delete('/:slug/memory/:id', async (c) => {
    const admitted = await admit(c);
    if (!admitted.ok) return admitted.response;
    const id = noteId(c);
    if (!id || !(await deps.memory.deleteNote(admitted.slug, id)))
      return c.json({ success: false, error: 'Note not found' }, 404);
    return c.json({ success: true });
  });

  return app;
}
