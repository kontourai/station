import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import { afterEach, describe, expect, test } from 'vitest';
import { ProjectMembershipStore } from '../project-membership-store.js';

const owner = humanPrincipal('deployment', 'owner-subject', 'Owner');
const member = humanPrincipal('deployment', 'member-subject', 'Member');
const outsider = humanPrincipal('deployment', 'outsider-subject', 'Outsider');
const scope: ProjectMembershipScope = {
  stationId: 'station-one',
  localProjectId: 'local-one',
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
  const root = mkdtempSync(join(tmpdir(), 'station-membership-'));
  roots.push(root);
  const path = join(root, 'membership.sqlite');
  let clock = Date.parse('2026-09-12T12:00:00.000Z');
  const open = () => {
    const db = new DatabaseSync(path);
    databases.push(db);
    return {
      db,
      store: new ProjectMembershipStore(db, scope.stationId, () => clock),
    };
  };
  const result = open();
  result.store.enable(scope, owner);
  return {
    ...result,
    open,
    expire: () => {
      clock += 2 * 3600_000;
    },
  };
}
const invitation = (role: 'viewer' | 'contributor' | 'admin' = 'viewer') => ({
  email: 'member@example.test',
  role,
  expiresAt: '2026-09-12T13:00:00.000Z',
});

describe('Project membership and invitation authority', () => {
  test('invitation eligibility grants nothing until the exact verified recipient accepts once', () => {
    const { store, db, open } = harness();
    const offered = store.invite(scope, owner, invitation());
    expect(store.mayRegister(offered.token, 'member@example.test')).toBe(true);
    expect(() => store.require(scope, member, 'view')).toThrow('forbidden');
    expect(() =>
      store.accept(offered.token, member, ['other@example.test']),
    ).toThrow('invitation_invalid');
    expect(store.administration(scope, owner).invitations[0]?.status).toBe(
      'pending',
    );
    expect(
      store.accept(offered.token, member, ['member@example.test']),
    ).toEqual(scope);
    expect(store.require(scope, member, 'view').role).toBe('viewer');
    for (const action of [
      'execute',
      'manage-members',
      'manage-extensions',
      'manage-compute',
    ] as const)
      expect(() => store.require(scope, member, action)).toThrow('forbidden');
    const reopened = open().store;
    expect(reopened.require(scope, member, 'view').principal.id).toBe(
      member.id,
    );
    expect(() =>
      reopened.accept(offered.token, member, ['member@example.test']),
    ).toThrow('invitation_invalid');
    expect(store.mayRegister(offered.token, 'member@example.test')).toBe(false);
    expect(
      JSON.stringify(db.prepare('SELECT * FROM project_invitations').all()),
    ).not.toContain(offered.token);
  });

  test('current inviter authority, expiration and cancellation are checked again at acceptance', () => {
    const { store, expire } = harness();
    const admin = store.invite(scope, owner, invitation('admin'));
    store.accept(admin.token, member, ['member@example.test']);
    const delegated = store.invite(scope, member, {
      ...invitation(),
      email: 'outsider@example.test',
    });
    const revision = store.require(scope, member, 'manage-members').revision;
    store.changeMember(scope, owner, member.id, revision, {
      role: 'viewer',
      status: 'active',
    });
    expect(store.mayRegister(delegated.token, 'outsider@example.test')).toBe(
      false,
    );
    expect(() =>
      store.accept(delegated.token, outsider, ['outsider@example.test']),
    ).toThrow('forbidden');
    const cancelled = store.invite(scope, owner, invitation());
    store.revokeInvitation(scope, owner, cancelled.invitation.id);
    expect(() =>
      store.accept(cancelled.token, outsider, ['member@example.test']),
    ).toThrow('invitation_invalid');
    const expired = store.invite(scope, owner, invitation());
    expire();
    expect(
      store
        .administration(scope, owner)
        .invitations.find((item) => item.id === expired.invitation.id)?.status,
    ).toBe('expired');
    expect(() =>
      store.accept(expired.token, outsider, ['member@example.test']),
    ).toThrow('invitation_invalid');
  });

  test('administration requires current Project scope and preserves the last owner until ownership transfers', () => {
    const { store } = harness();
    expect(() => store.administration(scope, outsider)).toThrow('forbidden');
    expect(() => store.enable(scope, outsider)).toThrow('forbidden');
    expect(() =>
      store.changeMember(scope, owner, owner.id, 1, {
        role: 'viewer',
        status: 'revoked',
      }),
    ).toThrow('conflict');
    expect(store.require(scope, owner, 'manage-members').role).toBe('owner');
    const offered = store.invite(scope, owner, invitation('admin'));
    store.accept(offered.token, member, ['member@example.test']);
    expect(() =>
      store.require(
        { ...scope, localProjectId: 'another-local-id' },
        member,
        'view',
      ),
    ).toThrow('forbidden');
    expect(() =>
      store.require(
        { ...scope, portableProjectId: 'unrelated' },
        member,
        'view',
      ),
    ).toThrow('forbidden');
    expect(() =>
      store.require({ ...scope, stationId: 'another-station' }, member, 'view'),
    ).toThrow('forbidden');
    expect(() => store.transferOwnership(scope, member, owner.id)).toThrow(
      'forbidden',
    );
    store.transferOwnership(scope, owner, member.id);
    expect(store.require(scope, member, 'manage-compute').role).toBe('owner');
    expect(store.require(scope, owner, 'manage-members').role).toBe('admin');
    expect(() => store.require(scope, owner, 'manage-extensions')).toThrow(
      'forbidden',
    );
  });

  test('revocation and stale management revisions are enforced across separate store connections', () => {
    const { store, open } = harness();
    const offer = store.invite(scope, owner, invitation('contributor'));
    store.accept(offer.token, member, ['member@example.test']);
    const second = open().store;
    const revision = second.require(scope, member, 'execute').revision;
    store.changeMember(scope, owner, member.id, revision, {
      role: 'contributor',
      status: 'revoked',
    });
    expect(() => second.require(scope, member, 'view')).toThrow('forbidden');
    expect(() =>
      second.changeMember(scope, owner, member.id, revision, {
        role: 'admin',
        status: 'active',
      }),
    ).toThrow('conflict');
    expect(() => second.administration(scope, member)).toThrow('forbidden');
  });

  test('corrupt principal records cannot borrow another member key and a different Station cannot open the authority', () => {
    const { store, db } = harness();
    const row = db
      .prepare('SELECT record FROM project_members WHERE principal_id=?')
      .get(owner.id);
    const stored = JSON.parse(String(row!.record));
    stored.principal = outsider;
    db.prepare('UPDATE project_members SET record=? WHERE principal_id=?').run(
      JSON.stringify(stored),
      owner.id,
    );
    expect(() => store.require(scope, owner, 'manage-members')).toThrow(
      'unavailable',
    );
    expect(() => new ProjectMembershipStore(db, 'another-station')).toThrow(
      'unavailable',
    );
  });

  test('unreadable schema state is preserved instead of silently creating missing authority tables', () => {
    const { db } = harness();
    db.exec('DROP TABLE project_invitations');
    expect(() => new ProjectMembershipStore(db, scope.stationId)).toThrow(
      'unavailable',
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name='project_invitations'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT version FROM project_access_authority').get()?.version,
    ).toBe('station.project-membership/v1');
  });
});
