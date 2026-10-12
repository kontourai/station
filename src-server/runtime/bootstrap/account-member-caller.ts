/**
 * #3586: the one rule for whether a request is held to Project membership.
 *
 * Project membership restricts account principals (`human:deployment:…`)
 * only. A request is a member caller when it acts for one:
 *
 * - its account session is authenticated (`via: 'account-session'`); an
 *   account credential that is present but not authenticated is no caller
 *   at all (`{ kind: 'none' }`);
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
      via: 'account-session' | 'agent-owner';
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
  // #2377 slice B (decision 2): a station-control tool call sees what its
  // session's owner would see. An account owner is held to membership; the
  // operator and a device owner are unrestricted, as in their own requests.
  const ownerId = deps.agentOwnerId(request);
  if (ownerId === null) return { kind: 'none' };
  if (ownerId !== undefined && isDeploymentAccountPrincipalId(ownerId))
    return { kind: 'member', via: 'agent-owner', principalId: ownerId };
  return undefined;
}
