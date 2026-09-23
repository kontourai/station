/**
 * D5 against the REAL Project membership service and store: only the Station
 * operator and Project admins/owners may view or drive a browser session.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { ProjectManifestStore } from '../../projects/project-manifest-store.js';
import {
  type ProjectMembershipAuthority,
  ProjectMembershipService,
} from '../../projects/project-membership-service.js';
import {
  ProjectMembershipRefusal,
  ProjectMembershipStore,
} from '../../projects/project-membership-store.js';
import { ProjectService } from '../../projects/project-service.js';
import {
  createBrowserOperatorAuthorizer,
  createBrowserProjectAuthorizer,
} from '../browser-access.js';

const owner = humanPrincipal('deployment', 'owner', 'Owner');
const admin = humanPrincipal('deployment', 'admin', 'Admin');
const contributor = humanPrincipal('deployment', 'contributor', 'Contributor');
const viewer = humanPrincipal('deployment', 'viewer', 'Viewer');
const stranger = humanPrincipal('deployment', 'stranger', 'Stranger');

/** Principal ids are namespaced; derive a plain, valid mailbox for each. */
const emailOf = (principal: PrincipalRef) =>
  `${principal.id.replace(/[^a-z0-9]/gi, '-')}@example.test`;

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const home = mkdtempSync(join(tmpdir(), 'station-browser-access-'));
  roots.push(home);
  const storage = new FileStorageAdapter(home);
  const manifests = new ProjectManifestStore(home, storage);
  const projects = new ProjectService(storage, manifests);
  const project = await projects.createProject({
    name: 'Alpha',
    slug: 'alpha',
  });
  const beta = await projects.createProject({ name: 'Beta', slug: 'beta' });
  const db = new DatabaseSync(join(home, 'access.sqlite'));
  databases.push(db);
  const service = new ProjectMembershipService(
    'station-one',
    storage,
    manifests,
    new ProjectMembershipStore(db, 'station-one'),
  );
  // The request carries who is calling; the test maps a request to its actor.
  const actors = new WeakMap<
    Request,
    { principal: PrincipalRef; operator: boolean }
  >();
  const authorityFor = (request: Request): ProjectMembershipAuthority => ({
    current: async () => {
      const actor = actors.get(request);
      if (!actor) throw new ProjectMembershipRefusal('forbidden');
      return {
        principal: actor.principal,
        verifiedEmails: [emailOf(actor.principal)],
      };
    },
    operator: async () => {
      if (!actors.get(request)?.operator)
        throw new ProjectMembershipRefusal('forbidden');
    },
  });
  const requestAs = (principal: PrincipalRef, operator = false) => {
    const request = new Request('http://station.test/api/browser/sessions');
    actors.set(request, { principal, operator });
    return request;
  };
  // Owner enables sharing and invites each role; each invitee accepts.
  const ownerRequest = requestAs(owner, true);
  const enabled = await service.enable(
    'alpha',
    project.id,
    authorityFor(ownerRequest),
  );
  for (const [principal, role] of [
    [admin, 'admin'],
    [contributor, 'contributor'],
    [viewer, 'viewer'],
  ] as const) {
    const offer = await service.invite(
      enabled.scope,
      {
        email: emailOf(principal),
        role,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      authorityFor(ownerRequest),
    );
    await service.accept(offer.token, authorityFor(requestAs(principal)));
  }
  const deps = {
    operator: (request: Request) => authorityFor(request).operator(),
    authority: authorityFor,
    membership: service,
  };
  return {
    alpha: project.id,
    beta: beta.id,
    scope: enabled.scope,
    ownerAuthority: authorityFor(ownerRequest),
    authorize: createBrowserProjectAuthorizer(deps),
    authorizeOperator: createBrowserOperatorAuthorizer(deps),
    requestAs,
    service,
  };
}

describe('browser access (D5) with the real membership service', () => {
  test('Project owner and admin are admitted as project-admin for view and drive', async () => {
    const h = await harness();
    for (const principal of [owner, admin]) {
      for (const purpose of ['view', 'drive'] as const) {
        expect(
          await h.authorize(h.requestAs(principal), h.alpha, purpose),
        ).toEqual({
          kind: 'project-admin',
          principalId: principal.id,
        });
      }
    }
  });

  test('a contributor, a viewer and a non-member get nothing', async () => {
    const h = await harness();
    for (const principal of [contributor, viewer, stranger]) {
      for (const purpose of ['view', 'drive'] as const) {
        expect(
          await h.authorize(h.requestAs(principal), h.alpha, purpose),
        ).toBeUndefined();
      }
    }
  });

  test('admin standing does not carry to another Project', async () => {
    const h = await harness();
    expect(
      await h.authorize(h.requestAs(admin), h.beta, 'drive'),
    ).toBeUndefined();
  });

  test('the Station operator is admitted for any Project, and only it for acquisition', async () => {
    const h = await harness();
    expect(
      await h.authorize(h.requestAs(stranger, true), h.beta, 'drive'),
    ).toEqual({
      kind: 'operator',
    });
    expect(await h.authorizeOperator(h.requestAs(stranger, true))).toBe(true);
    expect(await h.authorizeOperator(h.requestAs(admin))).toBe(false);
  });

  test('without Project sharing configured, only the operator is admitted', async () => {
    const authorize = createBrowserProjectAuthorizer({
      operator: async () => {
        throw new ProjectMembershipRefusal('forbidden');
      },
      authority: () => ({
        current: async () => ({ principal: admin, verifiedEmails: [] }),
        operator: async () => {},
      }),
    });
    expect(
      await authorize(new Request('http://x/'), 'alpha', 'view'),
    ).toBeUndefined();
  });

  test('an error while resolving membership is a refusal, never an admission', async () => {
    const authorize = createBrowserProjectAuthorizer({
      operator: async () => {
        throw new Error('operator check exploded');
      },
      membership: {
        readableProjectAdmissions: async () => {
          throw new Error('membership store unavailable');
        },
      },
      authority: () => ({
        current: async () => ({ principal: admin, verifiedEmails: [] }),
        operator: async () => {},
      }),
    });
    expect(
      await authorize(new Request('http://x/'), 'alpha', 'drive'),
    ).toBeUndefined();
  });

  test('a revoked admin gets nothing', async () => {
    const h = await harness();
    const member = (
      await h.service.administration('alpha', h.ownerAuthority)
    ).members.find((entry) => entry.principal.id === admin.id)!;
    await h.service.changeMember(
      h.scope,
      admin.id,
      member.revision,
      { role: 'admin', status: 'revoked' },
      h.ownerAuthority,
    );
    expect(
      await h.authorize(h.requestAs(admin), h.alpha, 'drive'),
    ).toBeUndefined();
  });

  test('review S5: standing is keyed by canonical Project ID, never the slug', async () => {
    const h = await harness();
    // The slug string is not an ID: passing it grants nothing.
    expect(
      await h.authorize(h.requestAs(admin), 'alpha', 'drive'),
    ).toBeUndefined();
    expect(
      await h.authorize(h.requestAs(admin), h.alpha, 'drive'),
    ).toMatchObject({
      kind: 'project-admin',
    });
  });
});
