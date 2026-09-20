import { StationHttpError } from '@kontourai/station-sdk';
import { getAccountSession } from '@kontourai/station-sdk/account-authentication';

export class GuestApprovalRequired extends Error {}
export class GuestAccountRequired extends Error {}
export class GuestAccountUnavailable extends Error {}

export async function requireGuestAccount(
  apiBase: string,
  principalId: string,
  signal: AbortSignal,
) {
  try {
    const account = await getAccountSession(apiBase, { signal });
    if (!account || account.principal.id !== principalId)
      throw new GuestAccountRequired();
  } catch (cause) {
    if (
      cause instanceof GuestAccountRequired ||
      (cause instanceof DOMException && cause.name === 'AbortError')
    )
      throw cause;
    throw new GuestAccountUnavailable();
  }
}

export async function classifyGuestReadFailure(
  cause: unknown,
  apiBase: string,
  principalId: string,
  signal: AbortSignal,
): Promise<never> {
  if (!(cause instanceof StationHttpError) || cause.status !== 401) throw cause;
  try {
    const account = await getAccountSession(apiBase, { signal });
    if (!account || account.principal.id !== principalId)
      throw new GuestAccountRequired();
    throw new GuestApprovalRequired();
  } catch (accountFailure) {
    if (
      accountFailure instanceof GuestAccountRequired ||
      accountFailure instanceof GuestApprovalRequired ||
      (accountFailure instanceof DOMException &&
        accountFailure.name === 'AbortError')
    )
      throw accountFailure;
    throw new GuestAccountUnavailable();
  }
}
