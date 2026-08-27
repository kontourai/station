import type { RequestCredentialEvidence } from './ConnectionsContext';

/** Public, non-secret authority partition shared by Station hosts and SDK keys. */
export interface RequestAuthorityScope {
  apiBase: string;
  authorityKey: string;
}

/** Optional host-owned, non-secret epoch such as a native authorization receipt. */
export interface RequestAuthorityScopeOptions {
  authorityQualifier?: string;
}

/**
 * Deliberately excludes credentials and credential generations: the authority
 * key identifies the live endpoint and public authority epoch only.
 */
export function requestAuthorityScopeFromCredentialEvidence(
  evidence: Pick<
    RequestCredentialEvidence,
    | 'activationEpoch'
    | 'connectionId'
    | 'authorityGeneration'
    | 'credentialState'
    | 'origin'
  >,
  options: RequestAuthorityScopeOptions = {},
): RequestAuthorityScope {
  const identity = [
    evidence.connectionId,
    evidence.activationEpoch,
    evidence.authorityGeneration,
    evidence.credentialState,
  ];
  if (options.authorityQualifier) identity.push(options.authorityQualifier);
  return {
    apiBase: evidence.origin,
    authorityKey: JSON.stringify(identity),
  };
}
