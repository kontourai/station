import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type {
  ProjectMemberAction,
  ProjectMembershipScope,
} from '@kontourai/station-contracts/project-membership';
import type { ProjectRoomActor } from '@kontourai/station-contracts/project-room';
import { parseProjectPortableIdentity } from '../../domain/project-identity-record.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { assertSafeLayoutPathSegment } from '../../domain/storage-adapter.js';
import type { ProjectManifestStore } from '../../services/projects/project-manifest-store.js';
import type {
  ProjectMembershipAuthority,
  ProjectMembershipService,
} from '../../services/projects/project-membership-service.js';
import { ProjectMembershipRefusal } from '../../services/projects/project-membership-store.js';
import type {
  ProjectRoomAccessPort,
  ProjectRoomCapabilities,
} from '../../services/projects/project-room-service.js';

interface Dependencies {
  stationId: string;
  storage: IStorageAdapter;
  manifests: Pick<ProjectManifestStore, 'readRecord'>;
  membership?: ProjectMembershipService;
  member(request: Request): Promise<ProjectMembershipAuthority | undefined>;
  authority(request: Request): ProjectMembershipAuthority;
  current(request: Request): boolean;
  /** Current transport and independent execution permission, not membership. */
  allows(request: Request, slug: string, action: ProjectMemberAction): boolean;
}
const actorFor = (principal: PrincipalRef): ProjectRoomActor => {
  if (principal.kind !== 'human')
    throw new ProjectMembershipRefusal('forbidden');
  return { id: principal.id, displayName: principal.display, kind: 'person' };
};
const scopeMatches = (a: ProjectMembershipScope, b: ProjectMembershipScope) =>
  a.stationId === b.stationId &&
  a.localProjectId === b.localProjectId &&
  a.portableProjectId === b.portableProjectId &&
  a.localProjectSlug === b.localProjectSlug;

/** Project Room authority composes membership with the runtime's current transport grant. */
export function createProjectRoomAccess(
  deps: Dependencies,
): ProjectRoomAccessPort {
  const current = (
    request: Request,
    slug: string,
    action: ProjectMemberAction,
  ) =>
    !request.signal.aborted &&
    deps.current(request) &&
    deps.allows(request, slug, action);
  const caps = (
    request: Request,
    slug: string,
    permitted: readonly ProjectMemberAction[],
  ): ProjectRoomCapabilities => ({
    view: permitted.includes('view') && current(request, slug, 'view'),
    discuss: permitted.includes('discuss') && current(request, slug, 'discuss'),
    edit: permitted.includes('edit') && current(request, slug, 'edit'),
    execute: permitted.includes('execute') && current(request, slug, 'execute'),
  });
  async function personal<T>(
    request: Request,
    slug: string,
    action: ProjectMemberAction,
    expectedActorId: string | undefined,
    expectedScope: ProjectMembershipScope | undefined,
    operation: (
      scope: ProjectMembershipScope,
      actor: ProjectRoomActor,
      capabilities: ProjectRoomCapabilities,
      assertCurrent: () => void,
    ) => T,
  ): Promise<T> {
    assertSafeLayoutPathSegment('project slug', slug);
    const authority = deps.authority(request);
    const actor = actorFor((await authority.current()).principal);
    if (
      (expectedActorId && actor.id !== expectedActorId) ||
      !current(request, slug, action)
    )
      throw new ProjectMembershipRefusal('forbidden');
    const revision = deps.storage.projectRevision(slug);
    if (!revision.withCurrentRead)
      throw new ProjectMembershipRefusal('unavailable');
    const result = await revision.withCurrentRead(async (project) => {
      try {
        const record = deps.manifests.readRecord(slug);
        if (!record) throw new ProjectMembershipRefusal('conflict');
        const identity = parseProjectPortableIdentity(record);
        const scope: ProjectMembershipScope = {
          stationId: deps.stationId,
          localProjectId: project.id,
          localProjectSlug: slug,
          portableProjectId: identity.id,
        };
        if (expectedScope && !scopeMatches(scope, expectedScope))
          throw new ProjectMembershipRefusal('conflict');
        const finalActor = actorFor((await authority.current()).principal);
        const assertCurrent = () => {
          if (finalActor.id !== actor.id || !current(request, slug, action))
            throw new ProjectMembershipRefusal('forbidden');
        };
        assertCurrent();
        return {
          ok: true as const,
          value: await operation(
            scope,
            finalActor,
            caps(request, slug, ['view', 'discuss', 'edit', 'execute']),
            assertCurrent,
          ),
        };
      } catch (error) {
        if (error instanceof ProjectMembershipRefusal)
          return { ok: false as const, error };
        throw error;
      }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }
  return {
    async withAction(request, slug, action, expectedActorId, operation) {
      if (!current(request, slug, action))
        throw new ProjectMembershipRefusal('forbidden');
      const member = await deps.member(request);
      if (!member)
        return personal(
          request,
          slug,
          action,
          expectedActorId,
          undefined,
          operation,
        );
      const membership = deps.membership;
      if (!membership) throw new ProjectMembershipRefusal('forbidden');
      const actor = actorFor((await member.current()).principal);
      if (expectedActorId && actor.id !== expectedActorId)
        throw new ProjectMembershipRefusal('forbidden');
      const scope = await membership.requireProjectRead(slug, member);
      return membership.withProjectAction(
        scope,
        action,
        member,
        actor.id,
        (live, assertCurrent) => {
          const admitted = membership
            .admissionsForResolvedPrincipal(live.principal.id)
            .find((item) => scopeMatches(item.scope, scope));
          if (!admitted) throw new ProjectMembershipRefusal('forbidden');
          return operation(
            scope,
            actorFor(live.principal),
            caps(request, slug, admitted.member.actions),
            assertCurrent,
          );
        },
        () => current(request, slug, action),
      );
    },
    async current(request, scope, actorId, action) {
      try {
        if (!current(request, scope.localProjectSlug, action)) return false;
        const member = await deps.member(request);
        if (member)
          return deps.membership
            ? deps.membership.currentActionAdmission(
                scope,
                action,
                member,
                actorId,
                () => current(request, scope.localProjectSlug, action),
              )
            : false;
        await personal(
          request,
          scope.localProjectSlug,
          action,
          actorId,
          scope,
          (_scope, _actor, _caps, assertCurrent) => {
            assertCurrent();
            return true;
          },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
