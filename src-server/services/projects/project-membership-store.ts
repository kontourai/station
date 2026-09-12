import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import {
  PROJECT_MEMBER_ROLES,
  PROJECT_MEMBERSHIP_VERSION,
  type ProjectAccessAdministrationView,
  type ProjectInvitationView,
  type ProjectMemberAction,
  type ProjectMemberRole,
  type ProjectMembershipScope,
  type ProjectMemberView,
} from '@kontourai/station-contracts/project-membership';
import { z } from 'zod/v3';

export class ProjectMembershipRefusal extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'conflict'
      | 'invitation_invalid'
      | 'unavailable',
  ) {
    super(`Project access ${code}.`);
  }
}
const principalSchema = z.custom<PrincipalRef>(isPrincipalRef);
const roleSchema = z.enum(['viewer', 'contributor', 'admin', 'owner']);
const memberSchema = z
  .object({
    principal: principalSchema,
    role: roleSchema,
    status: z.enum(['active', 'revoked']),
    revision: z.number().int().positive(),
    grantedBy: principalSchema,
    updatedAt: z.string().datetime(),
  })
  .strict();
const invitationSchema = z
  .object({
    id: z.string().min(1),
    recipientEmail: z.string().email(),
    role: z.enum(['viewer', 'contributor', 'admin']),
    invitedBy: principalSchema,
    status: z.enum(['pending', 'accepted', 'revoked']),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();
type MemberRecord = z.infer<typeof memberSchema>;
type InvitationRecord = z.infer<typeof invitationSchema>;
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** One authoritative Station's membership/invitation transactions, independent of device or compute grants. */
export class ProjectMembershipStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly stationId: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!stationId.trim()) throw new ProjectMembershipRefusal('unavailable');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.transaction(() => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('project_access_authority', 'shared_projects', 'project_members', 'project_invitations')",
        )
        .all();
      if (tables.length > 0) {
        if (tables.length !== 4)
          throw new ProjectMembershipRefusal('unavailable');
        const authority = db
          .prepare(
            'SELECT station_id, version FROM project_access_authority WHERE singleton=1',
          )
          .get();
        if (
          authority?.station_id !== stationId ||
          authority.version !== PROJECT_MEMBERSHIP_VERSION
        )
          throw new ProjectMembershipRefusal('unavailable');
        return;
      }
      db.exec(`CREATE TABLE project_access_authority (singleton INTEGER PRIMARY KEY CHECK(singleton=1), station_id TEXT NOT NULL, version TEXT NOT NULL) STRICT;
        CREATE TABLE shared_projects (local_id TEXT PRIMARY KEY, portable_id TEXT NOT NULL, local_slug TEXT NOT NULL UNIQUE) STRICT;
        CREATE TABLE project_members (project_id TEXT NOT NULL REFERENCES shared_projects(local_id), principal_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(project_id, principal_id)) STRICT;
        CREATE TABLE project_invitations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES shared_projects(local_id), token_hash TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;`);
      db.prepare('INSERT INTO project_access_authority VALUES (1, ?, ?)').run(
        stationId,
        PROJECT_MEMBERSHIP_VERSION,
      );
    });
  }

  /** Caller must hold current Project revision and independently verified operator bootstrap authority. */
  enable(scope: ProjectMembershipScope, owner: PrincipalRef): void {
    this.assertScopeStation(scope);
    if (!isPrincipalRef(owner) || owner.kind !== 'human')
      throw new ProjectMembershipRefusal('forbidden');
    this.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT portable_id, local_slug FROM shared_projects WHERE local_id=?',
        )
        .get(scope.localProjectId);
      if (existing) {
        this.assertScope(scope);
        this.require(scope, owner, 'manage-members');
        return;
      }
      this.db
        .prepare('INSERT INTO shared_projects VALUES (?, ?, ?)')
        .run(
          scope.localProjectId,
          scope.portableProjectId,
          scope.localProjectSlug,
        );
      this.putMember(scope, owner, 'owner', 'active', owner);
    });
  }

  require(
    scope: ProjectMembershipScope,
    actor: PrincipalRef,
    action: ProjectMemberAction,
  ): ProjectMemberView {
    if (!isPrincipalRef(actor)) throw new ProjectMembershipRefusal('forbidden');
    this.assertScope(scope);
    const member = this.member(scope, actor.id);
    if (
      !isPrincipalRef(actor) ||
      !member ||
      member.status !== 'active' ||
      !this.actions(member.role).includes(action)
    )
      throw new ProjectMembershipRefusal('forbidden');
    return { ...member, actions: this.actions(member.role) };
  }

  administration(
    scope: ProjectMembershipScope,
    actor: PrincipalRef,
  ): ProjectAccessAdministrationView {
    return this.transaction(() => {
      this.require(scope, actor, 'manage-members');
      const members = this.db
        .prepare(
          'SELECT record FROM project_members WHERE project_id=? ORDER BY principal_id',
        )
        .all(scope.localProjectId)
        .map((row) => this.parseMember(row.record));
      const invitations = this.db
        .prepare(
          'SELECT record FROM project_invitations WHERE project_id=? ORDER BY id',
        )
        .all(scope.localProjectId)
        .map((row) => this.parseInvitation(row.record));
      return {
        version: PROJECT_MEMBERSHIP_VERSION,
        scope: structuredClone(scope),
        members: members.map((member) => ({
          ...member,
          actions: this.actions(member.role),
        })),
        invitations: invitations.map((invitation) =>
          this.invitationView(invitation),
        ),
      };
    });
  }

  invite(
    scope: ProjectMembershipScope,
    actor: PrincipalRef,
    input: {
      email: string;
      role: Exclude<ProjectMemberRole, 'owner'>;
      expiresAt: string;
    },
  ): { invitation: ProjectInvitationView; token: string } {
    const email = input.email.trim().toLowerCase();
    if (
      !z.string().email().safeParse(email).success ||
      email.length > 320 ||
      !['viewer', 'contributor', 'admin'].includes(input.role)
    )
      throw new ProjectMembershipRefusal('invitation_invalid');
    const expiry = Date.parse(input.expiresAt);
    if (
      !Number.isFinite(expiry) ||
      expiry <= this.now() ||
      expiry > this.now() + 7 * 86400_000
    )
      throw new ProjectMembershipRefusal('invitation_invalid');
    return this.transaction(() => {
      this.requireGrant(scope, actor, input.role);
      const token = randomBytes(32).toString('base64url');
      const invitation: InvitationRecord = {
        id: randomUUID(),
        recipientEmail: email,
        role: input.role,
        invitedBy: structuredClone(actor),
        status: 'pending',
        expiresAt: new Date(expiry).toISOString(),
        createdAt: new Date(this.now()).toISOString(),
      };
      this.db
        .prepare('INSERT INTO project_invitations VALUES (?, ?, ?, ?)')
        .run(
          invitation.id,
          scope.localProjectId,
          digest(token),
          JSON.stringify(invitation),
        );
      return { invitation: this.invitationView(invitation), token };
    });
  }

  scopeForMember(
    slug: string,
    actor: PrincipalRef,
    action: ProjectMemberAction,
  ): ProjectMembershipScope {
    const row = this.db
      .prepare(
        'SELECT local_id, portable_id FROM shared_projects WHERE local_slug=?',
      )
      .get(slug);
    if (
      !row ||
      typeof row.local_id !== 'string' ||
      typeof row.portable_id !== 'string'
    )
      throw new ProjectMembershipRefusal('forbidden');
    const scope = {
      stationId: this.stationId,
      localProjectId: row.local_id,
      portableProjectId: row.portable_id,
      localProjectSlug: slug,
    };
    this.require(scope, actor, action);
    return scope;
  }

  invitationScope(token: string): ProjectMembershipScope {
    const { scope, invitation } = this.pendingInvitation(token);
    this.requireGrant(scope, invitation.invitedBy, invitation.role);
    return scope;
  }

  /** Eligibility for account enrollment; does not consume the invitation or grant membership. */
  mayRegister(token: string, email: string): boolean {
    try {
      return this.transaction(() => {
        const { scope, invitation } = this.pendingInvitation(token);
        this.requireGrant(scope, invitation.invitedBy, invitation.role);
        return invitation.recipientEmail === email.trim().toLowerCase();
      });
    } catch (error) {
      if (
        error instanceof ProjectMembershipRefusal &&
        error.code !== 'unavailable'
      )
        return false;
      throw error;
    }
  }

  /** Verified contacts come only from the authentication owner, never the acceptance JSON. */
  accept(
    token: string,
    actor: PrincipalRef,
    verifiedEmails: readonly string[],
  ): ProjectMembershipScope {
    if (!isPrincipalRef(actor) || actor.kind !== 'human')
      throw new ProjectMembershipRefusal('forbidden');
    return this.transaction(() => {
      const { scope, invitation } = this.pendingInvitation(token);
      if (
        !verifiedEmails.some(
          (email) => email.trim().toLowerCase() === invitation.recipientEmail,
        )
      )
        throw new ProjectMembershipRefusal('invitation_invalid');
      this.requireGrant(scope, invitation.invitedBy, invitation.role);
      const existing = this.member(scope, actor.id);
      if (existing?.status === 'active')
        throw new ProjectMembershipRefusal('conflict');
      this.putMember(
        scope,
        actor,
        invitation.role,
        'active',
        invitation.invitedBy,
      );
      this.db
        .prepare('UPDATE project_invitations SET record=? WHERE id=?')
        .run(
          JSON.stringify({ ...invitation, status: 'accepted' }),
          invitation.id,
        );
      return scope;
    });
  }

  changeMember(
    scope: ProjectMembershipScope,
    actor: PrincipalRef,
    targetId: string,
    expectedRevision: number,
    change: {
      role: Exclude<ProjectMemberRole, 'owner'>;
      status: 'active' | 'revoked';
    },
  ): void {
    this.transaction(() => {
      this.require(scope, actor, 'manage-members');
      if (
        !z
          .object({
            role: z.enum(['viewer', 'contributor', 'admin']),
            status: z.enum(['active', 'revoked']),
          })
          .strict()
          .safeParse(change).success
      )
        throw new ProjectMembershipRefusal('conflict');
      const target = this.member(scope, targetId);
      if (!target || target.revision !== expectedRevision)
        throw new ProjectMembershipRefusal('conflict');
      this.requireGrant(scope, actor, target.role);
      this.requireGrant(scope, actor, change.role);
      if (target.role === 'owner')
        throw new ProjectMembershipRefusal('conflict');
      this.putMember(
        scope,
        target.principal,
        change.role,
        change.status,
        actor,
      );
    });
  }

  transferOwnership(
    scope: ProjectMembershipScope,
    actor: PrincipalRef,
    recipientId: string,
  ): void {
    this.transaction(() => {
      if (
        this.require(scope, actor, 'manage-members').role !== 'owner' ||
        actor.id === recipientId
      )
        throw new ProjectMembershipRefusal('forbidden');
      const recipient = this.member(scope, recipientId);
      if (recipient?.status !== 'active')
        throw new ProjectMembershipRefusal('conflict');
      this.putMember(scope, recipient.principal, 'owner', 'active', actor);
      this.putMember(scope, actor, 'admin', 'active', actor);
    });
  }

  revokeInvitation(
    scope: ProjectMembershipScope,
    actor: PrincipalRef,
    invitationId: string,
  ): void {
    this.transaction(() => {
      this.require(scope, actor, 'manage-members');
      const row = this.db
        .prepare(
          'SELECT record FROM project_invitations WHERE id=? AND project_id=?',
        )
        .get(invitationId, scope.localProjectId);
      if (!row) throw new ProjectMembershipRefusal('invitation_invalid');
      const invitation = this.parseInvitation(row.record);
      this.requireGrant(scope, actor, invitation.role);
      if (invitation.status !== 'pending')
        throw new ProjectMembershipRefusal('conflict');
      this.db
        .prepare('UPDATE project_invitations SET record=? WHERE id=?')
        .run(
          JSON.stringify({ ...invitation, status: 'revoked' }),
          invitationId,
        );
    });
  }

  private pendingInvitation(token: string): {
    scope: ProjectMembershipScope;
    invitation: InvitationRecord;
  } {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ProjectMembershipRefusal('invitation_invalid');
    const row = this.db
      .prepare(
        'SELECT i.record, p.local_id, p.portable_id, p.local_slug FROM project_invitations i JOIN shared_projects p ON p.local_id=i.project_id WHERE token_hash=?',
      )
      .get(digest(token));
    if (
      !row ||
      typeof row.local_id !== 'string' ||
      typeof row.portable_id !== 'string' ||
      typeof row.local_slug !== 'string'
    )
      throw new ProjectMembershipRefusal('invitation_invalid');
    const invitation = this.parseInvitation(row.record);
    if (
      invitation.status !== 'pending' ||
      Date.parse(invitation.expiresAt) <= this.now()
    )
      throw new ProjectMembershipRefusal('invitation_invalid');
    return {
      scope: {
        stationId: this.stationId,
        localProjectId: row.local_id,
        localProjectSlug: row.local_slug,
        portableProjectId: row.portable_id,
      },
      invitation,
    };
  }
  private requireGrant(
    scope: ProjectMembershipScope,
    actor: PrincipalRef,
    role: ProjectMemberRole,
  ): void {
    const authority = this.require(scope, actor, 'manage-members');
    if (
      !this.actions(role).every((action) => authority.actions.includes(action))
    )
      throw new ProjectMembershipRefusal('forbidden');
  }
  private member(
    scope: ProjectMembershipScope,
    principalId: string,
  ): MemberRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT record FROM project_members WHERE project_id=? AND principal_id=?',
      )
      .get(scope.localProjectId, principalId);
    if (!row) return undefined;
    const member = this.parseMember(row.record);
    if (member.principal.id !== principalId)
      throw new ProjectMembershipRefusal('unavailable');
    return member;
  }
  private putMember(
    scope: ProjectMembershipScope,
    principal: PrincipalRef,
    role: ProjectMemberRole,
    status: MemberRecord['status'],
    grantedBy: PrincipalRef,
  ): void {
    const record = memberSchema.parse({
      principal,
      role,
      status,
      revision: (this.member(scope, principal.id)?.revision ?? 0) + 1,
      grantedBy,
      updatedAt: new Date(this.now()).toISOString(),
    });
    this.db
      .prepare(
        'INSERT INTO project_members VALUES (?, ?, ?) ON CONFLICT(project_id, principal_id) DO UPDATE SET record=excluded.record',
      )
      .run(scope.localProjectId, principal.id, JSON.stringify(record));
  }
  private actions(role: ProjectMemberRole): ProjectMemberAction[] {
    return [...PROJECT_MEMBER_ROLES[role]];
  }
  private invitationView(invitation: InvitationRecord): ProjectInvitationView {
    return {
      ...invitation,
      status:
        invitation.status === 'pending' &&
        Date.parse(invitation.expiresAt) <= this.now()
          ? 'expired'
          : invitation.status,
      actions: this.actions(invitation.role),
    };
  }
  private parseMember(value: unknown): MemberRecord {
    return this.parse(value, memberSchema);
  }
  private parseInvitation(value: unknown): InvitationRecord {
    return this.parse(value, invitationSchema);
  }
  private parse<T>(value: unknown, schema: z.ZodType<T>): T {
    try {
      return schema.parse(JSON.parse(String(value)));
    } catch {
      throw new ProjectMembershipRefusal('unavailable');
    }
  }
  private assertScopeStation(scope: ProjectMembershipScope): void {
    if (
      scope.stationId !== this.stationId ||
      !scope.localProjectId.trim() ||
      !scope.localProjectSlug.trim() ||
      !scope.portableProjectId.trim()
    )
      throw new ProjectMembershipRefusal('forbidden');
  }
  private assertScope(scope: ProjectMembershipScope): void {
    this.assertScopeStation(scope);
    const row = this.db
      .prepare(
        'SELECT portable_id, local_slug FROM shared_projects WHERE local_id=?',
      )
      .get(scope.localProjectId);
    if (
      row?.portable_id !== scope.portableProjectId ||
      row?.local_slug !== scope.localProjectSlug
    )
      throw new ProjectMembershipRefusal('forbidden');
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
