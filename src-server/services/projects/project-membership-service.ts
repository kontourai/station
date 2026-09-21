import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type {
  ProjectInvitationPreview,
  ProjectMemberRole,
  ProjectMembershipScope,
  ProjectMemberView,
} from '@kontourai/station-contracts/project-membership';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../domain/project-file-transactions.js';
import { parseProjectPortableIdentity } from '../../domain/project-identity-record.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import type { ProjectManifestStore } from './project-manifest-store.js';
import {
  ProjectMembershipRefusal,
  ProjectMembershipStore,
} from './project-membership-store.js';

export interface ProjectMembershipActor {
  principal: PrincipalRef;
  verifiedEmails: readonly string[];
}
export interface ProjectMembershipAuthority {
  /** Resolve and check current authentication/device authority on each invocation. */
  current(): Promise<ProjectMembershipActor>;
  /** Separate Station authority required only for the first sharing bootstrap. */
  operator(): Promise<void>;
}

/**
 * Caller-captured intent for a committed membership mutation.
 *
 * A page rendered as principal A can have both HttpOnly cookies replaced by
 * B in another window before its POST is sent. The Project scope pins the
 * Project incarnation, not the acting principal, and no client authority key
 * can observe HttpOnly cookie replacement — so the mutation carries the
 * principal id it was rendered for, and the service compares it against
 * freshly authenticated authority BEFORE committing anything. A mismatch
 * refuses with `forbidden`, even when B is independently an admin of the
 * same Project: A's stale intent must never commit as B.
 *
 * This is a comparison against authenticated authority, never authority
 * granted by a client claim — the supplied id grants nothing. Device
 * identity needs no separate pin here: the account tier wins the principal
 * composition, so any cross-account credential swap changes the resolved
 * principal (or fails closed as an identity conflict), while a same-account
 * device swap keeps the principal and the correct attribution.
 */
export interface ProjectMembershipMutationIntent {
  expectedActorId?: string;
}

/** Couples membership transactions to the selected Project's current incarnation. */
export class ProjectMembershipService {
  constructor(
    private readonly stationId: string,
    private readonly storage: IStorageAdapter,
    private readonly manifests: Pick<ProjectManifestStore, 'readRecord'> &
      Partial<Pick<ProjectManifestStore, 'ensureProjectManifest'>>,
    private readonly members: ProjectMembershipStore,
  ) {}

  async enable(
    slug: string,
    expectedLocalId: string,
    authority: ProjectMembershipAuthority,
  ) {
    await authority.operator();
    const initial = await authority.current();
    return this.withProject(
      slug,
      undefined,
      async (scope) => {
        await authority.operator();
        const actor = await this.currentActor(authority, initial.principal.id);
        if (scope.localProjectId !== expectedLocalId)
          throw new ProjectMembershipRefusal('conflict');
        this.members.enable(scope, actor.principal);
        return this.members.administration(scope, actor.principal);
      },
      async (localId) => {
        await authority.operator();
        await this.currentActor(authority, initial.principal.id);
        if (localId !== expectedLocalId)
          throw new ProjectMembershipRefusal('conflict');
      },
    );
  }

  async administration(slug: string, authority: ProjectMembershipAuthority) {
    const actor = await authority.current();
    // Authorization precedes reading any Project files or metadata.
    const scope = this.members.scopeForMember(
      slug,
      actor.principal,
      'manage-members',
    );
    return this.withProject(slug, scope, async () =>
      this.members.administration(
        scope,
        (await this.currentActor(authority, actor.principal.id)).principal,
      ),
    );
  }

  async readableProjectScopes(
    authority: ProjectMembershipAuthority,
  ): Promise<readonly ProjectMembershipScope[]> {
    const actor = await authority.current();
    const scopes = this.members.readableProjectScopes(actor.principal);
    const current = await this.currentActor(authority, actor.principal.id);
    const currentScopes = this.members.readableProjectScopes(current.principal);
    const admitted: ProjectMembershipScope[] = [];
    for (const scope of scopes) {
      if (
        !currentScopes.some(
          (candidate) =>
            candidate.localProjectId === scope.localProjectId &&
            candidate.portableProjectId === scope.portableProjectId &&
            candidate.localProjectSlug === scope.localProjectSlug,
        )
      )
        continue;
      try {
        await this.withProject(scope.localProjectSlug, scope, async () => {
          const live = await this.currentActor(authority, actor.principal.id);
          this.members.require(scope, live.principal, 'view');
        });
        admitted.push(scope);
      } catch (error) {
        if (!(error instanceof ProjectMembershipRefusal)) throw error;
      }
    }
    const final = await this.currentActor(authority, actor.principal.id);
    const finalScopes = this.members.readableProjectScopes(final.principal);
    return admitted.filter((admittedScope) =>
      finalScopes.some(
        (scope) =>
          scope.localProjectId === admittedScope.localProjectId &&
          scope.portableProjectId === admittedScope.portableProjectId &&
          scope.localProjectSlug === admittedScope.localProjectSlug,
      ),
    );
  }

  async readableProjectAdmissions(
    authority: ProjectMembershipAuthority,
  ): Promise<
    readonly { scope: ProjectMembershipScope; member: ProjectMemberView }[]
  > {
    const scopes = await this.readableProjectScopes(authority);
    const actor = await authority.current();
    return scopes.map((scope) => ({
      scope,
      member: this.members.require(scope, actor.principal, 'view'),
    }));
  }

  async requireProjectRead(
    slug: string,
    authority: ProjectMembershipAuthority,
  ): Promise<ProjectMembershipScope> {
    const actor = await authority.current();
    const scope = this.members.scopeForMember(slug, actor.principal, 'view');
    await this.requireProjectScopeRead(scope, authority, actor.principal.id);
    return scope;
  }

  async requireProjectScopeRead(
    scope: ProjectMembershipScope,
    authority: ProjectMembershipAuthority,
    expectedPrincipalId?: string,
  ): Promise<void> {
    const actor = await authority.current();
    if (expectedPrincipalId && actor.principal.id !== expectedPrincipalId)
      throw new ProjectMembershipRefusal('forbidden');
    this.members.require(scope, actor.principal, 'view');
    await this.withProject(scope.localProjectSlug, scope, async () => {
      const current = await this.currentActor(authority, actor.principal.id);
      this.members.require(scope, current.principal, 'view');
    });
  }

  async invite(
    scope: ProjectMembershipScope,
    input: {
      email: string | null;
      role: Exclude<ProjectMemberRole, 'owner'>;
      expiresAt: string;
    },
    authority: ProjectMembershipAuthority,
    intent?: ProjectMembershipMutationIntent,
  ) {
    const capturedScope = structuredClone(scope);
    const capturedInput = structuredClone(input);
    const capturedIntent = structuredClone(intent ?? {});
    return this.withManagement(
      capturedScope,
      authority,
      (actor) => this.members.invite(capturedScope, actor.principal, capturedInput),
      capturedIntent,
    );
  }

  async mayRegister(input: {
    invitation: string;
    email?: string;
  }): Promise<boolean> {
    if (!this.members.mayRegister(input.invitation, input.email)) return false;
    const scope = this.members.invitationScope(input.invitation);
    try {
      return await this.withProject(scope.localProjectSlug, scope, async () =>
        this.members.mayRegister(input.invitation, input.email),
      );
    } catch (error) {
      if (
        (error instanceof ProjectMembershipRefusal &&
          error.code === 'conflict') ||
        error instanceof FileStorageConflictError ||
        error instanceof FileStorageNotFoundError
      )
        return false;
      throw error;
    }
  }

  async accept(token: string, authority: ProjectMembershipAuthority) {
    const initial = await authority.current();
    if (
      !this.members.mayRegister(token) &&
      !initial.verifiedEmails.some((email) =>
        this.members.mayRegister(token, email),
      )
    )
      throw new ProjectMembershipRefusal('invitation_invalid');
    const scope = this.members.invitationScope(token);
    return this.withProject(scope.localProjectSlug, scope, async () => {
      const actor = await this.currentActor(authority, initial.principal.id);
      return this.members.accept(token, actor.principal, actor.verifiedEmails);
    });
  }

  async previewInvitation(token: string): Promise<ProjectInvitationPreview> {
    const { scope } = this.members.invitationPreview(token);
    return this.withProject(
      scope.localProjectSlug,
      scope,
      async (_scope, projectName) => {
        const { invitation } = this.members.invitationPreview(token);
        return {
          projectName,
          inviterName: invitation.invitedBy.display,
          role: invitation.role,
          actions: invitation.actions,
          expiresAt: invitation.expiresAt,
          recipientEmail: invitation.recipientEmail,
        };
      },
    );
  }

  async changeMember(
    scope: ProjectMembershipScope,
    targetId: string,
    revision: number,
    change: {
      role: Exclude<ProjectMemberRole, 'owner'>;
      status: 'active' | 'revoked';
    },
    authority: ProjectMembershipAuthority,
    intent?: ProjectMembershipMutationIntent,
  ) {
    const capturedScope = structuredClone(scope);
    const capturedChange = structuredClone(change);
    const capturedIntent = structuredClone(intent ?? {});
    return this.withManagement(
      capturedScope,
      authority,
      (actor) => {
        this.members.changeMember(
          capturedScope,
          actor.principal,
          targetId,
          revision,
          capturedChange,
        );
        return { changed: true as const };
      },
      capturedIntent,
    );
  }

  async transferOwnership(
    scope: ProjectMembershipScope,
    recipientId: string,
    authority: ProjectMembershipAuthority,
    intent?: ProjectMembershipMutationIntent,
  ) {
    const capturedScope = structuredClone(scope);
    const capturedIntent = structuredClone(intent ?? {});
    return this.withManagement(
      capturedScope,
      authority,
      (actor) => {
        this.members.transferOwnership(
          capturedScope,
          actor.principal,
          recipientId,
        );
        return { changed: true as const };
      },
      capturedIntent,
    );
  }

  async revokeInvitation(
    scope: ProjectMembershipScope,
    invitationId: string,
    authority: ProjectMembershipAuthority,
    intent?: ProjectMembershipMutationIntent,
  ) {
    const capturedScope = structuredClone(scope);
    const capturedIntent = structuredClone(intent ?? {});
    return this.withManagement(
      capturedScope,
      authority,
      (actor) => {
        this.members.revokeInvitation(
          capturedScope,
          actor.principal,
          invitationId,
        );
        return { changed: true as const };
      },
      capturedIntent,
    );
  }

  /**
   * Fresh delivery check for token-bearing and admin-view payloads (the
   * `GET .../access` administration view, the `POST .../invitations`
   * `{ invitation, token }` response). Compares the captured actor id and
   * the exact captured Project scope against CURRENT management authority:
   * the same principal must still hold `manage-members` on the unchanged
   * Project incarnation at release time, not just at mutation time. An
   * invitation created before its inviter's revocation therefore never has
   * its token released afterwards.
   *
   * Short fresh reads only — never a mutex held through response
   * consumption, never a retry of the already-committed effect. Returns
   * false (the transport answers causeless `Project not found`) instead of
   * throwing for deliberate authorization outcomes.
   */
  async currentManagementAdmission(
    scope: ProjectMembershipScope,
    authority: ProjectMembershipAuthority,
    expectedPrincipalId: string,
  ): Promise<boolean> {
    try {
      const actor = await authority.current();
      if (actor.principal.id !== expectedPrincipalId) return false;
      this.members.require(scope, actor.principal, 'manage-members');
      await this.withProject(scope.localProjectSlug, scope, async () => {
        const live = await this.currentActor(authority, expectedPrincipalId);
        this.members.require(scope, live.principal, 'manage-members');
      });
      return true;
    } catch (error) {
      if (error instanceof ProjectMembershipRefusal) return false;
      throw error;
    }
  }

  /**
   * Fresh delivery check for contentless `{ changed: true }`
   * acknowledgements (`members`, `invitations/:id/revoke`, `transfer`).
   * An authorized self-demotion or self-revocation commits an effect that
   * removes the actor's own `manage-members` permission, so re-requiring
   * that permission after the effect would falsely report the committed
   * change as uncommitted. This check retains the current
   * credential/actor comparison (the principal id must be unchanged) and
   * the exact-scope incarnation comparison (a same-slug replacement still
   * refuses), without requiring the old permission and without leaking
   * protected content — the payload carries no member or token data.
   *
   * Same transport contract as above: short fresh reads, no retry, no held
   * mutex; deliberate refusals answer false.
   */
  async currentScopeAdmission(
    scope: ProjectMembershipScope,
    authority: ProjectMembershipAuthority,
    expectedPrincipalId: string,
  ): Promise<boolean> {
    try {
      const actor = await authority.current();
      if (actor.principal.id !== expectedPrincipalId) return false;
      await this.withProject(scope.localProjectSlug, scope, async () => {
        await this.currentActor(authority, expectedPrincipalId);
      });
      return true;
    } catch (error) {
      if (error instanceof ProjectMembershipRefusal) return false;
      throw error;
    }
  }

  private async currentActor(
    authority: ProjectMembershipAuthority,
    expectedId: string,
  ) {
    const actor = await authority.current();
    if (actor.principal.id !== expectedId)
      throw new ProjectMembershipRefusal('forbidden');
    return actor;
  }

  private async withManagement<T>(
    scope: ProjectMembershipScope,
    authority: ProjectMembershipAuthority,
    operation: (actor: ProjectMembershipActor) => T,
    intent?: ProjectMembershipMutationIntent,
  ): Promise<T> {
    const actor = await authority.current();
    if (
      intent?.expectedActorId !== undefined &&
      actor.principal.id !== intent.expectedActorId
    )
      throw new ProjectMembershipRefusal('forbidden');
    this.members.require(scope, actor.principal, 'manage-members');
    return this.withProject(scope.localProjectSlug, scope, async () =>
      operation(await this.currentActor(authority, actor.principal.id)),
    );
  }

  private async withProject<T>(
    slug: string,
    expected: ProjectMembershipScope | undefined,
    operation: (
      scope: ProjectMembershipScope,
      projectName: string,
    ) => Promise<T>,
    prepare?: (localId: string) => Promise<void>,
  ): Promise<T> {
    assertSafeLayoutPathSegment('project slug', slug);
    const revision = this.storage.projectRevision(slug);
    if (!revision.withCurrentRead)
      throw new ProjectMembershipRefusal('unavailable');
    const result = await revision.withCurrentRead(async (project) => {
      try {
        let manifest = this.manifests.readRecord(slug);
        if (!manifest && prepare) {
          await prepare(project.id);
          const prepared =
            await this.manifests.ensureProjectManifest?.(project);
          if (!prepared || prepared.outcome === 'unavailable')
            throw new ProjectMembershipRefusal('unavailable');
          manifest = this.manifests.readRecord(slug);
        }
        if (!manifest) throw new ProjectMembershipRefusal('conflict');
        const identity = parseProjectPortableIdentity(manifest);
        const scope: ProjectMembershipScope = {
          stationId: this.stationId,
          localProjectId: project.id,
          localProjectSlug: project.slug,
          portableProjectId: identity.id,
        };
        if (
          expected &&
          (expected.stationId !== scope.stationId ||
            expected.localProjectId !== scope.localProjectId ||
            expected.localProjectSlug !== scope.localProjectSlug ||
            expected.portableProjectId !== scope.portableProjectId)
        )
          throw new ProjectMembershipRefusal('conflict');
        return {
          ok: true as const,
          value: await operation(scope, project.name),
        };
      } catch (error) {
        // The file transaction owner wraps unexpected callback errors as
        // storage failures. Preserve deliberate authorization outcomes as data
        // through that boundary, then throw only after releasing its guard.
        if (error instanceof ProjectMembershipRefusal)
          return { ok: false as const, error };
        throw error;
      }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }
}
