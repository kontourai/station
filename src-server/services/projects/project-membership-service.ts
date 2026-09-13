import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type {
  ProjectInvitationPreview,
  ProjectMemberRole,
  ProjectMembershipScope,
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

  async invite(
    scope: ProjectMembershipScope,
    input: {
      email: string | null;
      role: Exclude<ProjectMemberRole, 'owner'>;
      expiresAt: string;
    },
    authority: ProjectMembershipAuthority,
  ) {
    const capturedScope = structuredClone(scope);
    const capturedInput = structuredClone(input);
    return this.withManagement(capturedScope, authority, (actor) =>
      this.members.invite(capturedScope, actor.principal, capturedInput),
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
  ) {
    const capturedScope = structuredClone(scope);
    const capturedChange = structuredClone(change);
    return this.withManagement(capturedScope, authority, (actor) => {
      this.members.changeMember(
        capturedScope,
        actor.principal,
        targetId,
        revision,
        capturedChange,
      );
      return { changed: true as const };
    });
  }

  async transferOwnership(
    scope: ProjectMembershipScope,
    recipientId: string,
    authority: ProjectMembershipAuthority,
  ) {
    const capturedScope = structuredClone(scope);
    return this.withManagement(capturedScope, authority, (actor) => {
      this.members.transferOwnership(
        capturedScope,
        actor.principal,
        recipientId,
      );
      return { changed: true as const };
    });
  }

  async revokeInvitation(
    scope: ProjectMembershipScope,
    invitationId: string,
    authority: ProjectMembershipAuthority,
  ) {
    const capturedScope = structuredClone(scope);
    return this.withManagement(capturedScope, authority, (actor) => {
      this.members.revokeInvitation(
        capturedScope,
        actor.principal,
        invitationId,
      );
      return { changed: true as const };
    });
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
  ): Promise<T> {
    const actor = await authority.current();
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
