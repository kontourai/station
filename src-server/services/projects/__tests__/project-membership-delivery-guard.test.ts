/**
 * #488 guest-administration delivery guards.
 *
 * The route checks in `project-membership-routes.ts` authorize the EFFECT;
 * `guardProjectResponse` + `currentManagementAdmission` /
 * `currentScopeAdmission` authorize DELIVERY, re-resolved fresh before the
 * first byte and every queued chunk. These tests prove, through the REAL
 * routes + REAL service + REAL store (the only double is the identity
 * seam, flipped mid-flight to simulate a revocation landing between the
 * service check and release):
 *
 * - an invite token created before its inviter's revocation is never
 *   released afterwards, the committed invitation is neither retried nor
 *   rolled back, and the refusal leaks no token bytes;
 * - an authorized self-demotion still delivers its contentless
 *   `{ changed: true }` acknowledgement (the old `manage-members`
 *   permission must not be re-required after the effect);
 * - a queued-release revocation of the `GET .../access` admin view
 *   answers causeless 404 without member bytes;
 * - the transport-internal delivery descriptor never ships in API payloads;
 * - owner-only transfer, owner immutability, stale revisions, wrong
 *   scopes, and same-slug replacements keep their existing verdicts
 *   through the guarded routes.
 */
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

const owner = humanPrincipal('deployment', 'owner-subject', 'Owner');
const admin = humanPrincipal('deployment', 'admin-subject', 'Admin');
const stranger = humanPrincipal('deployment', 'stranger-subject', 'Stranger');
const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

interface FlippingAccess {
  access: ProjectMembershipAuthority;
  /** After `flipAt` `current()` calls, report `flipped` instead of `actor`. */
  armFlip(flipAt: number, flipped: typeof owner): void;
}

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'station-project-delivery-'));
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
  let calls = 0;
  let flipAt = Number.POSITIVE_INFINITY;
  let flipped: typeof owner = stranger;
  const access: ProjectMembershipAuthority = {
    current: vi.fn(async () => {
      calls += 1;
      const principal = calls >= flipAt ? flipped : actor;
      return { principal, verifiedEmails: [] };
    }),
    operator: vi.fn(async () => {
      if (!operator) throw new ProjectMembershipRefusal('forbidden');
    }),
  };
  const app = new Hono();
  app.route(
    '/api/projects',
    createProjectMembershipRoutes(service, () => access),
  );
  const setActor = (value: typeof owner, isOperator = false) => {
    actor = value;
    operator = isOperator;
  };
  const flipping: FlippingAccess = {
    access,
    armFlip: (at: number, to: typeof owner) => {
      calls = 0;
      flipAt = at;
      flipped = to;
    },
  };
  return {
    db,
    storage,
    projects,
    project,
    store,
    service,
    access,
    flipping,
    app,
    setActor,
  };
}

const invitation = () => ({
  email: null as string | null,
  role: 'viewer' as const,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});
const post = (app: Hono, path: string, body: unknown) =>
  app.request(`/api/projects/example/access${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('guest-administration delivery guards', () => {
  test('an invite token created before revocation is never released, and the effect is committed exactly once', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    // Promote a second admin who will invite, then lose manage-members
    // mid-flight: the route's own capture + service check run as admin
    // (calls 1-3), every release recheck runs demoted (calls 4+).
    const adminOffer = await h.service.invite(
      view.scope,
      { ...invitation(), role: 'admin' },
      h.access,
    );
    h.setActor(admin);
    await h.service.accept(adminOffer.token, h.access);
    h.setActor(owner, true);
    expect(h.store.require(view.scope, admin, 'manage-members').role).toBe(
      'admin',
    );
    h.setActor(admin);
    // Flip to a demoted identity (same device, manage-members gone) for
    // the release rechecks. `changeMember` is not used here — the flip
    // simulates an independent revocation landing after the service check.
    h.flipping.armFlip(4, stranger);
    const response = await post(h.app, '/invitations', {
      scope: view.scope,
      ...invitation(),
    });
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain('invitation');
    expect(text).not.toContain('token');
    // Committed exactly once, never retried by the guard: the invitation
    // exists in the store despite the refused delivery.
    h.setActor(owner, true);
    const pending = h.store
      .administration(view.scope, owner)
      .invitations.filter((entry) => entry.status === 'pending');
    expect(pending).toHaveLength(1);
  });

  test('an authorized self-demotion still delivers its contentless acknowledgement', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    const adminOffer = await h.service.invite(
      view.scope,
      { ...invitation(), role: 'admin' },
      h.access,
    );
    h.setActor(admin);
    await h.service.accept(adminOffer.token, h.access);
    const self = h.store.require(view.scope, admin, 'manage-members');
    const response = await post(h.app, '/members', {
      scope: view.scope,
      principalId: admin.id,
      revision: self.revision,
      role: 'viewer',
      status: 'active',
    });
    // 200, not a false "uncommitted" 404: the old manage-members
    // permission is not re-required after its own effect.
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { changed: true },
    });
    // Downgrade is immediate: the demoted admin can no longer manage.
    expect((await h.app.request('/api/projects/example/access')).status).toBe(
      403,
    );
  });

  test('a queued-release revocation refuses the admin view without member bytes', async () => {
    const h = await harness();
    await h.service.enable('example', h.project.id, h.access);
    // Service read (calls 1-2) passes as owner; the release recheck
    // (calls 3+) runs as a stranger: same causeless 404 the transport
    // answers when membership ends before delivery.
    h.flipping.armFlip(3, stranger);
    const response = await h.app.request('/api/projects/example/access');
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain(owner.id);
    expect(text).not.toContain('members');
  });

  test('management delivery requires the exact scope: wrong project and replacement refuse', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    // Wrong-project scope through the guarded route.
    const wrong = await post(h.app, '/invitations', {
      scope: { ...view.scope, localProjectSlug: 'other' },
      ...invitation(),
    });
    expect(wrong.status).toBe(409);
    // Same-slug replacement: the captured scope no longer matches the
    // live incarnation, so the fresh delivery check refuses.
    await h.storage.projectRevision('example').remove();
    const replacement = await h.projects.createProject({
      name: 'Replacement',
      slug: 'example',
    });
    expect(replacement.id).not.toBe(h.project.id);
    expect(
      await h.service.currentManagementAdmission(
        view.scope,
        h.access,
        owner.id,
      ),
    ).toBe(false);
    expect(
      await h.service.currentScopeAdmission(view.scope, h.access, owner.id),
    ).toBe(false);
  });

  test('actor swap refuses both delivery checks without leaking', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    h.setActor(stranger);
    expect(
      await h.service.currentManagementAdmission(
        view.scope,
        h.access,
        owner.id,
      ),
    ).toBe(false);
    expect(
      await h.service.currentScopeAdmission(view.scope, h.access, owner.id),
    ).toBe(false);
  });

  test('owner transfer stays owner-only and the owner record is immutable', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    const adminOffer = await h.service.invite(
      view.scope,
      { ...invitation(), role: 'admin' },
      h.access,
    );
    h.setActor(admin);
    await h.service.accept(adminOffer.token, h.access);
    // Admin cannot take ownership...
    expect(
      (
        await post(h.app, '/transfer', {
          scope: view.scope,
          recipientId: admin.id,
        })
      ).status,
    ).toBe(403);
    // ...cannot edit the owner record (an admin's authority does not
    // cover the owner's full action set, so the grant check refuses)...
    const ownerMember = h.store.require(view.scope, owner, 'manage-members');
    expect(
      (
        await post(h.app, '/members', {
          scope: view.scope,
          principalId: owner.id,
          revision: ownerMember.revision,
          role: 'viewer',
          status: 'active',
        })
      ).status,
    ).toBe(403);
    // ...and cannot mint the owner role (schema admits viewer,
    // contributor, admin only).
    expect(
      (
        await post(h.app, '/invitations', {
          scope: view.scope,
          email: null,
          role: 'owner',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    // The owner can transfer; the acknowledgement is contentless and
    // carries no delivery descriptor.
    h.setActor(owner, true);
    const transferred = await post(h.app, '/transfer', {
      scope: view.scope,
      recipientId: admin.id,
    });
    expect(transferred.status, await transferred.clone().text()).toBe(200);
    expect(await transferred.json()).toEqual({
      success: true,
      data: { changed: true },
    });
  });

  test('stale revisions conflict and payloads never carry the delivery descriptor', async () => {
    const h = await harness();
    const view = await h.service.enable('example', h.project.id, h.access);
    const adminOffer = await h.service.invite(
      view.scope,
      { ...invitation(), role: 'admin' },
      h.access,
    );
    h.setActor(admin);
    await h.service.accept(adminOffer.token, h.access);
    h.setActor(owner, true);
    const member = h.store.require(view.scope, admin, 'view');
    const stale = await post(h.app, '/members', {
      scope: view.scope,
      principalId: admin.id,
      revision: member.revision + 99,
      role: 'viewer',
      status: 'active',
    });
    expect(stale.status).toBe(409);
    const offered = await post(h.app, '/invitations', {
      scope: view.scope,
      ...invitation(),
    });
    expect(offered.status).toBe(200);
    const body = (await offered.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('guard');
    expect(JSON.stringify(body)).not.toContain('guard');
    expect(Object.keys(body.data as object).sort()).toEqual([
      'invitation',
      'token',
    ]);
  });
});
