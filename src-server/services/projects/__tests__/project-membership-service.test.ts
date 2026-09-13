import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { createProjectMembershipRoutes } from '../../../routes/projects/project-membership-routes.js';
import { ProjectManifestStore } from '../project-manifest-store.js';
import {
  type ProjectMembershipAuthority,
  ProjectMembershipService,
} from '../project-membership-service.js';
import {
  ProjectMembershipRefusal,
  ProjectMembershipStore,
} from '../project-membership-store.js';
import { ProjectService } from '../project-service.js';

const owner = humanPrincipal('deployment', 'owner', 'Owner');
const invitee = humanPrincipal('deployment', 'invitee', 'Invitee');
const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'station-project-membership-'));
  roots.push(home);
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const projects = new ProjectService(storage, manifests);
  const project = await projects.createProject({
    name: 'Example',
    slug: 'example',
  });
  const db = new DatabaseSync(join(home, 'access.sqlite'));
  databases.push(db);
  const store = new ProjectMembershipStore(db, 'station-one');
  const service = new ProjectMembershipService(
    'station-one',
    storage,
    manifests,
    store,
  );
  let actor = owner;
  let operator = true;
  const access: ProjectMembershipAuthority = {
    current: vi.fn(async () => ({
      principal: actor,
      verifiedEmails: actor.id === invitee.id ? ['invitee@example.test'] : [],
    })),
    operator: vi.fn(async () => {
      if (!operator) throw new ProjectMembershipRefusal('forbidden');
    }),
  };
  const app = new Hono();
  app.route(
    '/api/projects',
    createProjectMembershipRoutes(service, () => access),
  );
  return {
    storage,
    projects,
    project,
    store,
    service,
    access,
    app,
    setActor: (value: typeof owner, isOperator = false) => {
      actor = value;
      operator = isOperator;
    },
  };
}
const invitation = () => ({
  email: 'invitee@example.test',
  role: 'viewer' as const,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});
const post = (app: Hono, path: string, body: unknown) =>
  app.request(`/api/projects/example/access${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Project membership through revision and administration routes', () => {
  test('membership body limits do not capture unrelated Project API operations', async () => {
    const h = await harness();
    h.app.post('/api/projects', async (c) =>
      c.json({ length: (await c.req.text()).length }),
    );
    const response = await h.app.request('/api/projects', {
      method: 'POST',
      body: 'x'.repeat(20 * 1024),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ length: 20 * 1024 });
    expect(
      (await post(h.app, '/enable', { localProjectId: 'x'.repeat(20 * 1024) }))
        .status,
    ).toBe(413);
  });

  test('operator enables a real Project and administers invitation and member permissions through HTTP', async () => {
    const h = await harness();
    const enabled = await post(h.app, '/enable', {
      localProjectId: h.project.id,
    });
    expect(enabled.status).toBe(200);
    const view = await h.service.administration('example', h.access);
    expect(view.scope.localProjectId).toBe(h.project.id);
    const offered = await post(h.app, '/invitations', {
      scope: view.scope,
      ...invitation(),
    });
    expect(offered.status).toBe(200);
    const body = (await offered.json()) as { data: { token: string } };
    h.setActor(invitee);
    await h.service.accept(body.data.token, h.access);
    expect((await h.app.request('/api/projects/example/access')).status).toBe(
      403,
    );
    h.setActor(owner, true);
    const member = (
      await h.service.administration('example', h.access)
    ).members.find((entry) => entry.principal.id === invitee.id)!;
    const changed = await post(h.app, '/members', {
      scope: view.scope,
      principalId: invitee.id,
      revision: member.revision,
      role: 'admin',
      status: 'active',
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    h.setActor(invitee);
    expect((await h.app.request('/api/projects/example/access')).status).toBe(
      200,
    );
    expect(
      (await post(h.app, '/enable', { localProjectId: h.project.id })).status,
    ).toBe(403);
    expect(
      (
        await post(h.app, '/transfer', {
          scope: view.scope,
          recipientId: owner.id,
        })
      ).status,
    ).toBe(403);
  });

  test('a same-slug replacement cannot inherit a pending invitation or membership', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    const offered = await h.service.invite(view.scope, invitation(), h.access);
    expect(
      await h.service.mayRegister({
        invitation: offered.token,
        email: 'invitee@example.test',
      }),
    ).toBe(true);
    await h.storage.projectRevision('example').remove();
    const replacement = await h.projects.createProject({
      name: 'Replacement',
      slug: 'example',
    });
    expect(replacement.id).not.toBe(h.project.id);
    expect(
      await h.service.mayRegister({
        invitation: offered.token,
        email: 'invitee@example.test',
      }),
    ).toBe(false);
    h.setActor(invitee);
    await expect(
      h.service.accept(offered.token, h.access),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(() => h.store.require(view.scope, invitee, 'view')).toThrow(
      'forbidden',
    );
  });

  test('outsiders are refused before Project metadata reads and in-flight identity changes cannot perform a management action', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    const read = vi.spyOn(h.storage, 'projectRevision');
    h.setActor(invitee);
    await expect(
      h.service.administration('example', h.access),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(read).not.toHaveBeenCalled();
    h.setActor(owner, true);
    vi.mocked(h.access.current)
      .mockResolvedValueOnce({ principal: owner, verifiedEmails: [] })
      .mockResolvedValueOnce({
        principal: invitee,
        verifiedEmails: ['invitee@example.test'],
      });
    await expect(
      h.service.invite(view.scope, invitation(), h.access),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.store.administration(view.scope, owner).invitations).toHaveLength(
      0,
    );
  });

  test('request-supplied principals and scopes cannot redirect a management action', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    expect(
      (
        await post(h.app, '/invitations', {
          scope: view.scope,
          ...invitation(),
          principal: owner,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(h.app, '/invitations', {
          scope: { ...view.scope, localProjectSlug: 'other' },
          ...invitation(),
        })
      ).status,
    ).toBe(409);
    expect(h.store.administration(view.scope, owner).invitations).toHaveLength(
      0,
    );
  });
});
