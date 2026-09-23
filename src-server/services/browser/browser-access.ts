/**
 * Who may view or drive a Browser session (#90 amendment D5).
 *
 * Only the Station operator and Project admins (role `admin` or `owner`) of
 * the session's Project. Contributors and viewers get nothing. The personal
 * host gate that mounts the routes is necessary but not sufficient; this
 * check runs on every request, and every failure — including an error while
 * resolving membership — is a refusal.
 *
 * `view` and `drive` are separate on purpose: today both require the same
 * standing, but input (drive) must stay independently authorizable for a
 * future read-only viewer role.
 */
import type {
  ProjectMembershipScope,
  ProjectMemberView,
} from '@kontourai/station-contracts/project-membership';
import type { ProjectMembershipAuthority } from '../projects/project-membership-service.js';
import type { BrowserSessionActor } from './browser-session-registry.js';

export type BrowserAccessPurpose = 'view' | 'drive';

/**
 * Resolves the caller's standing for one Project (by canonical Project ID),
 * or undefined to refuse.
 */
export type BrowserProjectAuthorizer = (
  request: Request,
  projectId: string,
  purpose: BrowserAccessPurpose,
) => Promise<BrowserSessionActor | undefined>;

/** Host-level operations (Chromium acquisition): the operator only. */
export type BrowserOperatorAuthorizer = (request: Request) => Promise<boolean>;

const PROJECT_ADMIN_ROLES: ReadonlySet<ProjectMemberView['role']> = new Set([
  'admin',
  'owner',
]);

export interface BrowserAccessDeps {
  /** Resolves when the request carries Station operator authority. */
  operator(request: Request): Promise<void>;
  /** Absent when Project sharing is not configured: then operator only. */
  membership?: {
    readableProjectAdmissions(
      authority: ProjectMembershipAuthority,
    ): Promise<
      readonly { scope: ProjectMembershipScope; member: ProjectMemberView }[]
    >;
  };
  authority(request: Request): ProjectMembershipAuthority;
}

export function createBrowserOperatorAuthorizer(
  deps: Pick<BrowserAccessDeps, 'operator'>,
): BrowserOperatorAuthorizer {
  return async (request) => {
    try {
      await deps.operator(request);
      return true;
    } catch {
      return false;
    }
  };
}

export function createBrowserProjectAuthorizer(
  deps: BrowserAccessDeps,
): BrowserProjectAuthorizer {
  const isOperator = createBrowserOperatorAuthorizer(deps);
  return async (request, projectId, _purpose) => {
    if (await isOperator(request)) return { kind: 'operator' };
    if (!deps.membership) return undefined;
    try {
      const admissions = await deps.membership.readableProjectAdmissions(
        deps.authority(request),
      );
      // Canonical Project ID, never the slug: a renamed or reused slug must
      // not move admin standing between Projects (D7, review S5).
      const admission = admissions.find(
        ({ scope }) => scope.localProjectId === projectId,
      );
      if (
        admission?.member.status !== 'active' ||
        !PROJECT_ADMIN_ROLES.has(admission.member.role)
      ) {
        return undefined;
      }
      return {
        kind: 'project-admin',
        principalId: admission.member.principal.id,
      };
    } catch {
      return undefined;
    }
  };
}
