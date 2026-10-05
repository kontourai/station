/**
 * #3276: the server side of the Agent audience contract
 * (`@kontourai/station-contracts/agent`, `AgentAudience`).
 *
 * Two decisions live here and nowhere else:
 *
 * - {@link agentAudienceRefusal}: whether a declared audience is acceptable,
 *   with the reason when it is not. The Agent validator runs it on every read
 *   and write of `agent.json`, ahead of the JSON schema, so a refusal names
 *   the actual problem instead of a `oneOf` mismatch.
 * - {@link agentAudienceAdmits}: whether one caller may see and use one Agent.
 *   The member-caller gate (`agent-audience-gate.ts`) and `/api/boot` ask
 *   this, never a local copy of the rule.
 *
 * Admission is not authority. A member admitted here still holds only their
 * own membership; the turn they start must run with the intersection of the
 * Agent's declared scope and that access (docs/design/project-membership.md,
 * "Agent audience"). No member-initiated turn exists yet (#3277).
 */
import {
  AGENT_AUDIENCE_KINDS,
  AGENT_AUDIENCE_VERSION,
  type AgentAudience,
} from '@kontourai/station-contracts/agent';
import {
  PROJECT_MEMBER_ACTIONS,
  PROJECT_MEMBER_ROLES,
  type ProjectMemberAction,
  type ProjectMemberRole,
} from '@kontourai/station-contracts/project-membership';

const OPERATOR_AUDIENCE: AgentAudience = Object.freeze({
  version: AGENT_AUDIENCE_VERSION,
  kind: 'operator',
});

const MEMBER_ROLES = Object.keys(PROJECT_MEMBER_ROLES) as ProjectMemberRole[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why `audience` is not acceptable on an Agent owned by `project`, or
 * `undefined` when it is (including when it is absent). Unknown keys are
 * refused rather than ignored: an ignored key reads as a restriction nobody
 * enforces.
 */
export function agentAudienceRefusal(spec: {
  audience?: unknown;
  project?: unknown;
}): string | undefined {
  if (!Object.hasOwn(spec, 'audience') || spec.audience === undefined)
    return undefined;
  const audience = spec.audience;
  if (!isRecord(audience))
    return 'audience must be an object with version and kind';
  if (audience.version !== AGENT_AUDIENCE_VERSION)
    return `audience.version must be '${AGENT_AUDIENCE_VERSION}'`;
  const kind = audience.kind;
  if (
    typeof kind !== 'string' ||
    !(AGENT_AUDIENCE_KINDS as readonly string[]).includes(kind)
  )
    return `audience.kind must be one of: ${AGENT_AUDIENCE_KINDS.join(', ')}`;
  const allowed =
    kind === 'operator'
      ? ['version', 'kind']
      : kind === 'project-permission'
        ? ['version', 'kind', 'permission']
        : ['version', 'kind', 'roles'];
  const extra = Object.keys(audience).find((key) => !allowed.includes(key));
  if (extra) return `audience.${extra} is not allowed for kind '${kind}'`;
  if (kind === 'operator') return undefined;
  if (kind === 'project-permission') {
    if (
      !(PROJECT_MEMBER_ACTIONS as readonly unknown[]).includes(
        audience.permission,
      )
    )
      return `audience.permission must be one of: ${PROJECT_MEMBER_ACTIONS.join(', ')}`;
  } else {
    const roles = audience.roles;
    if (!Array.isArray(roles) || roles.length === 0)
      return 'audience.roles must be a non-empty list of Project roles';
    const unknown = roles.find(
      (role) => !(MEMBER_ROLES as unknown[]).includes(role),
    );
    if (unknown !== undefined)
      return `audience.roles must contain only: ${MEMBER_ROLES.join(', ')}`;
    if (new Set(roles).size !== roles.length)
      return 'audience.roles must not repeat a role';
  }
  if (typeof spec.project !== 'string' || spec.project.length === 0)
    return `audience '${kind}' admits Project members, so the Agent must name its owning project`;
  return undefined;
}

/** The audience an Agent actually has: absent reads as operator-only. */
export function effectiveAgentAudience(
  audience: AgentAudience | undefined,
): AgentAudience {
  return audience ?? OPERATOR_AUDIENCE;
}

/** One current Project admission held by a member caller. */
export interface AgentAudienceMemberAdmission {
  readonly projectSlug: string;
  readonly role: ProjectMemberRole;
  readonly actions: readonly ProjectMemberAction[];
  readonly status: 'active' | 'revoked';
}

/**
 * Who is asking. `operator` is every caller that keeps the operator's own
 * rules today (the operator's clients, personal devices, a bound operator
 * station-control caller, Station's server code). `member` is a caller acting
 * for a deployment account: its admissions are read from current membership
 * for each decision, never cached on the caller.
 */
export type AgentAudienceCaller =
  | { readonly kind: 'operator' }
  | {
      readonly kind: 'member';
      readonly admissions: () => readonly AgentAudienceMemberAdmission[];
    }
  /**
   * Acts for nobody: admitted to no Agent. `unresolved` marks a caller that
   * could not be decided (authentication threw), so a surface that cannot
   * answer with a refusal reports an error instead of an empty answer.
   */
  | { readonly kind: 'none'; readonly unresolved?: true };

/** Whether `caller` may see and use an Agent with this audience and owner. */
export function agentAudienceAdmits(
  agent: { readonly audience?: AgentAudience; readonly project?: string },
  caller: AgentAudienceCaller,
): boolean {
  if (caller.kind === 'operator') return true;
  if (caller.kind === 'none') return false;
  const audience = effectiveAgentAudience(agent.audience);
  if (audience.kind === 'operator' || !agent.project) return false;
  let admissions: readonly AgentAudienceMemberAdmission[];
  try {
    admissions = caller.admissions();
  } catch {
    return false;
  }
  return admissions.some(
    (admission) =>
      admission.status === 'active' &&
      admission.projectSlug === agent.project &&
      (audience.kind === 'project-permission'
        ? admission.actions.includes(audience.permission)
        : audience.roles.includes(admission.role)),
  );
}
