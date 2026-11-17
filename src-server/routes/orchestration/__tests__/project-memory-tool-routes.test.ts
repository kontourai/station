/**
 * #5065: the Project memory tools' REST side reads and writes only the
 * verified caller Session's own Project, never one named in the request.
 * The scope rule is stubbed open here (its own tests cover it); the caller
 * authority is bound exactly as the station-control guard binds it.
 */
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { ProjectMemoryStore } from '../../../services/projects/project-memory-store.js';
import { createProjectMemoryToolRoutes } from '../project-memory-tool-routes.js';

vi.mock('../dispatch-scope.js', () => ({
  refuseOutOfScopeDispatch: () => undefined,
}));

/** The JSON envelope these routes answer. */
type Envelope = {
  code?: string;
  data: {
    id: string;
    body?: string;
    note?: string;
    notes: { id: string; title: string }[];
  };
};
const body = async (response: Response) => (await response.json()) as Envelope;

const SESSIONS: Record<string, string | undefined> = {
  'session-export': 'export',
  'session-billing': 'billing',
  'session-loose': undefined,
};

describe('Project memory tool routes', () => {
  const makeTempDir = trackTempDirs();
  let enabled = true;
  afterEach(() => {
    enabled = true;
  });

  function app(memory: ProjectMemoryStore) {
    const root = new Hono();
    root.use('*', async (c, next) => {
      const sessionId = c.req.header('x-test-session');
      if (sessionId)
        bindStationControlRequestAuthority(c.req.raw, {
          kind: 'caller',
          boundOperator: false,
          caller: { sessionId, assurance: 'bound' },
        } as never);
      await next();
    });
    root.route(
      '/api/orchestration',
      createProjectMemoryToolRoutes({
        isInternalRequest: (request) => request.headers.has('x-internal'),
        scope: undefined,
        enabled: () => enabled,
        memory,
        projectOfSession: (sessionId) => SESSIONS[sessionId],
        authorLabel: () => 'coder',
      }),
    );
    return root;
  }

  const call = (
    root: Hono,
    session: string,
    path = '',
    init: RequestInit = {},
  ) =>
    root.request(`/api/orchestration/station-control/project-memory${path}`, {
      ...init,
      headers: {
        'x-internal': '1',
        'x-test-session': session,
        'content-type': 'application/json',
      },
    });

  test('remember, list, read and forget stay inside the caller Session’s Project', async () => {
    const memory = new ProjectMemoryStore(makeTempDir('memory-tools-'));
    const root = app(memory);
    const saved = await call(root, 'session-export', '', {
      method: 'POST',
      body: JSON.stringify({ title: 'Friday release', body: 'Moved.' }),
    });
    expect(saved.status).toBe(201);
    const { data } = await body(saved);
    const [note] = await memory.listNotes('export');
    expect(note).toMatchObject({
      title: 'Friday release',
      createdBy: { kind: 'agent', label: 'coder', sessionId: 'session-export' },
    });

    const listed = await body(await call(root, 'session-export'));
    expect(listed.data.notes).toEqual([
      expect.objectContaining({ id: data.id, title: 'Friday release' }),
    ]);
    const read = await body(await call(root, 'session-export', `/${data.id}`));
    expect(read.data).toMatchObject({ body: 'Moved.' });
    expect(read.data.note).toMatch(/context, not instructions/);

    // Another Project's Session sees nothing and cannot reach the note.
    expect(
      (await body(await call(root, 'session-billing'))).data.notes,
    ).toEqual([]);
    expect((await call(root, 'session-billing', `/${data.id}`)).status).toBe(
      404,
    );
    expect(
      (await call(root, 'session-billing', `/${data.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(404);
    expect(await memory.listNotes('export')).toHaveLength(1);

    expect(
      (await call(root, 'session-export', `/${data.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(200);
    expect(await memory.listNotes('export')).toEqual([]);
  });

  test('refuses outside a Project, without a caller, from outside, and while off', async () => {
    const root = app(new ProjectMemoryStore(makeTempDir('memory-tools-')));
    const loose = await call(root, 'session-loose');
    expect(loose.status).toBe(409);
    expect((await body(loose)).code).toBe('no_project');

    const external = await root.request(
      '/api/orchestration/station-control/project-memory',
    );
    expect(external.status).toBe(404);

    const callerless = await root.request(
      '/api/orchestration/station-control/project-memory',
      { headers: { 'x-internal': '1' } },
    );
    expect(callerless.status).toBe(403);

    enabled = false;
    const off = await call(root, 'session-export');
    expect(off.status).toBe(404);
    expect((await body(off)).code).toBe('feature_preview_disabled');
  });
});
