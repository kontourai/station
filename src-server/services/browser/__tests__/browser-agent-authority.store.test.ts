/**
 * D5 for browser tools against the REAL Project membership store (#90 S7):
 * the principal id an agent session records for its owner is the same key
 * the store holds members under, so an admin/owner is admitted by id and a
 * contributor, an outsider, a revoked admin or another Project's admin is
 * not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { afterEach, describe, expect, test } from 'vitest';
import { ProjectMembershipStore } from '../../projects/project-membership-store.js';
import { createBrowserPrincipalAuthorizer } from '../browser-agent-authority.js';

const owner = humanPrincipal('deployment', 'owner-subject', 'Owner');
const admin = humanPrincipal('deployment', 'admin-subject', 'Admin');
const contributor = humanPrincipal('deployment', 'contrib-subject', 'Contrib');
const outsider = humanPrincipal('deployment', 'outsider-subject', 'Outsider');
const scope: ProjectMembershipScope = {
  stationId: 'station-one',
  localProjectId: 'local-one',
  localProjectSlug: 'example',
  portableProjectId: 'prj_shared',
};

const databases: DatabaseSync[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'station-browser-d5-'));
  roots.push(root);
  const db = new DatabaseSync(join(root, 'membership.sqlite'));
  databases.push(db);
  const store = new ProjectMembershipStore(db, scope.stationId, () =>
    Date.parse('2026-09-12T12:00:00.000Z'),
  );
  store.enable(scope, owner);
  const join_ = (
    who: typeof admin,
    role: 'admin' | 'contributor',
    email: string,
  ) => {
    const offered = store.invite(scope, owner, {
      email,
      role,
      expiresAt: '2026-09-12T13:00:00.000Z',
    });
    store.accept(offered.token, who, [email]);
  };
  join_(admin, 'admin', 'admin@example.test');
  join_(contributor, 'contributor', 'contrib@example.test');
  const authorize = createBrowserPrincipalAuthorizer({
    isOperatorPrincipal: (id) => id === 'human:local:operator',
    membership: {
      admissionsForResolvedPrincipal: (id) =>
        store.readableProjectAdmissionsForPrincipalId(id),
    },
  });
  return { store, authorize };
}

describe('browser D5 over the membership store', () => {
  test('an admin and the owner are admitted by the id their sessions record', async () => {
    const { authorize } = harness();
    // Session ownership records carry the principal's id string, the same
    // `human:<provider>:<subject>` key the store keys members by.
    expect(admin.id).toMatch(/^human:deployment:/);
    expect(await authorize(admin.id, 'local-one')).toEqual({
      kind: 'project-admin',
      principalId: admin.id,
    });
    expect(await authorize(owner.id, 'local-one')).toEqual({
      kind: 'project-admin',
      principalId: owner.id,
    });
  });

  test('a contributor, an outsider and another Project get nothing', async () => {
    const { authorize } = harness();
    expect(await authorize(contributor.id, 'local-one')).toBeUndefined();
    expect(await authorize(outsider.id, 'local-one')).toBeUndefined();
    expect(await authorize(admin.id, 'local-two')).toBeUndefined();
    expect(await authorize('', 'local-one')).toBeUndefined();
  });

  test('a revoked admin is no longer admitted', async () => {
    const { store, authorize } = harness();
    const revision = store.require(scope, admin, 'view').revision;
    store.changeMember(scope, owner, admin.id, revision, {
      role: 'admin',
      status: 'revoked',
    });
    expect(await authorize(admin.id, 'local-one')).toBeUndefined();
  });
});
