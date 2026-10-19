/**
 * #3586: the account standing a credential that outlives a browser session
 * (a personal access token) is checked against instead of a session.
 *
 * Only Station's own local-account provider has one: Station owns that
 * account policy (disabled, "sign out everywhere"), so it can answer for an
 * account at any time. Any other deployment provider is reachable only
 * through a live session, has no directory, and an account-tied person
 * there cannot hold a token (fail closed).
 */
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { deploymentAccountPrincipal } from './deployment-authentication-service.js';
import type { LocalAccountAdministration } from './local-account-administration.js';

export type AccountStanding = 'current' | 'disabled' | 'unknown';

export interface AccountDirectory {
  /** The deployment issuer whose subjects this directory answers for. */
  readonly issuer: string;
  /**
   * `current` when the account exists, is enabled, and (with `since`) has
   * not been signed out everywhere at or after `since` (epoch ms); `unknown`
   * when no such account exists; `disabled` otherwise.
   */
  standing(subject: string, since?: number): AccountStanding;
  list(): { principal: PrincipalRef; accountId: string; disabled: boolean }[];
}

export function localAccountDirectory(
  issuer: string,
  administration: Pick<
    LocalAccountAdministration,
    'exists' | 'permits' | 'list'
  >,
): AccountDirectory {
  return {
    issuer,
    standing(subject, since) {
      if (!administration.exists(subject)) return 'unknown';
      return administration.permits(
        subject,
        since === undefined ? undefined : new Date(since),
      )
        ? 'current'
        : 'disabled';
    },
    list() {
      return administration.list().map((account) => ({
        principal: deploymentAccountPrincipal(
          issuer,
          account.accountId,
          account.name,
        ),
        accountId: account.accountId,
        disabled: account.disabled,
      }));
    },
  };
}
