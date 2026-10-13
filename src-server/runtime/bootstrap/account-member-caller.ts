/**
 * #3586: the one rule for whether a request is held to Project membership.
 *
 * Project membership restricts account principals (`human:deployment:…`)
 * only. A request is a member caller when it acts for one:
 *
 * - its account session is authenticated (`via: 'account-session'`); an
 *   account credential that is present but not authenticated is no caller
 *   at all (`{ kind: 'none' }`);
 * - it presents a personal access token tied to an account whose standing
 *   is current (`via: 'personal-token'`, #3586); a token that no longer
 *   resolves is `{ kind: 'none' }`, never operator rules;
 * - it is a station-control tool call whose session an account principal
 *   owns (`via: 'agent-owner'`); a principal-scoped tool call that acts for
 *   no one is `{ kind: 'none' }`.
 *
 * Every other request answers `undefined`: it keeps its own (operator)
 * rules. The Project read guard, the Project catalogue, `/events` Project
 * frames and the Agent audience gate all decide from this, so a caller
 * cannot be a member on one surface and unrestricted on another.
 */
import type { ResolvedDeploymentAuthentication } from '../../services/identity/deployment-authentication-service.js';
import { isDeploymentAccountPrincipalId } from '../../services/identity/deployment-authentication-service.js';

export type AccountMemberCaller =
  | {
      kind: 'member';
      via: 'account-session' | 'personal-token' | 'agent-owner';
      /** The account principal's id the membership is read for. */
      principalId: string;
    }
  | { kind: 'none' }
  | undefined;

export interface AccountMemberCallerDeps {
  /** The deployment account check; absent when no provider is configured. */
  authenticate?: (
    request: Request,
  ) => Promise<ResolvedDeploymentAuthentication>;
  /**
   * #3586: the account principal id a personal access token acts for when
   * its account is current; `null` for a token that does not resolve (now
   * revoked, expired, or its account no longer current); `undefined` when
   * the request presents no token, or a token tied to no account.
   */
  accountToken?: (request: Request) => string | null | undefined;
  /**
   * The principal a principal-scoped station-control request acts for:
   * `null` when it acts for no one, `undefined` for every other request.
   */
  agentOwnerId: (request: Request) => string | null | undefined;
}

export async function accountMemberCaller(
  request: Request,
  deps: AccountMemberCallerDeps,
): Promise<AccountMemberCaller> {
  const account = await deps.authenticate?.(request);
  if (account?.kind === 'authenticated')
    return {
      kind: 'member',
      via: 'account-session',
      principalId: account.principal.id,
    };
  if (account && account.kind !== 'absent') return { kind: 'none' };
  const tokenAccount = deps.accountToken?.(request);
  if (tokenAccount === null) return { kind: 'none' };
  if (tokenAccount !== undefined)
    return {
      kind: 'member',
      via: 'personal-token',
      principalId: tokenAccount,
    };
  return agentOwnerMemberCaller(deps.agentOwnerId(request));
}

/**
 * The station-control half of {@link accountMemberCaller}, synchronous for
 * surfaces that decide without an account session (the Task board and
 * knowledge roots): #2377 slice B (decision 2), a station-control tool call
 * sees what its session's owner would see. An account owner is held to
 * membership; a call acting for no one is no caller; the operator and a
 * device owner are unrestricted, as in their own requests.
 */
export function agentOwnerMemberCaller(
  ownerId: string | null | undefined,
): AccountMemberCaller {
  if (ownerId === null) return { kind: 'none' };
  if (ownerId !== undefined && isDeploymentAccountPrincipalId(ownerId))
    return { kind: 'member', via: 'agent-owner', principalId: ownerId };
  return undefined;
}

/**
 * The Agent audience decision for a member caller (#3276): operator rules,
 * no Agent, or the admissions of the principal it acts for. A caller that
 * authenticated as an account (an account session or, #3586, an
 * account-tied personal token; not a station-control owner) is re-resolved
 * through `currentPrincipalId`, which rechecks that the request is still
 * current and still that account; a station-control owner is the recorded
 * owner itself.
 */
export async function agentAudienceForMemberCaller<Admissions>(
  member: AccountMemberCaller,
  deps: {
    currentPrincipalId: () => Promise<string>;
    admissions: (principalId: string) => Admissions;
  },
): Promise<
  | { kind: 'operator' }
  | { kind: 'none' }
  | { kind: 'member'; admissions: Admissions }
> {
  if (!member) return { kind: 'operator' };
  if (member.kind === 'none') return { kind: 'none' };
  const principalId =
    member.via === 'agent-owner'
      ? member.principalId
      : await deps.currentPrincipalId();
  return { kind: 'member', admissions: deps.admissions(principalId) };
}
