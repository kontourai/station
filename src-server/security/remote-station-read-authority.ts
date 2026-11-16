import { servesRemoteSessionReads } from '../capabilities/station-capability-flags.js';
import { isHostedTenantExecutionRequired } from '../runtime/bootstrap/hosted-tenant-mode.js';
import { requestMayBeAnAgent } from './coding-authority.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  isBoundRuntimeOwner,
  isRuntimeRequestPrincipalCurrent,
} from './runtime-request-security.js';

/**
 * The local caller standing that a read of another Station through this one
 * needs. Every such read (the remote-sessions list, a remote history page,
 * the remote part of message search) presents this Station's outbound peer
 * bearer, which is Station-wide: the remote authorizes the bearer, not the
 * local caller. So the caller must be the one person that bearer stands for,
 * as the paired Station chat relay requires over the same credential
 * (`peer-chat-routes.ts`).
 */
export interface RemoteStationReadAuthority {
  /** A hosted deployment: no tenant binds the Station-wide peer bearer. */
  hosted: boolean;
  /** The request's principal is still the current one (not revoked). */
  current: (request: Request) => boolean;
  /** The request is the Station's bound owner, the person the bearer serves. */
  owner: (request: Request) => boolean;
}

/**
 * The production composition: currentness from this runtime's own security
 * service, owner standing from the auth boundary's binding, and no remote
 * reads at all on a hosted Station. runtime-routes.ts passes its
 * `environmentSecurityService`; tests pass the same kind of service.
 */
export function runtimeRemoteStationReadAuthority(
  security: CurrentRuntimeRequestPrincipalSecurity,
  environment: NodeJS.ProcessEnv = process.env,
): RemoteStationReadAuthority {
  return {
    hosted: !servesRemoteSessionReads({
      hosted: isHostedTenantExecutionRequired(environment),
    }),
    current: (request) => isRuntimeRequestPrincipalCurrent(request, security),
    owner: isBoundRuntimeOwner,
  };
}

/**
 * `unavailable`: this Station serves no remote reads (hosted). `forbidden`:
 * this caller may not make one, or no authority was composed (fail closed).
 */
export function remoteStationReadDecision(
  authority: RemoteStationReadAuthority | undefined,
  request: Request | undefined,
): 'admitted' | 'forbidden' | 'unavailable' {
  if (!authority || !request) return 'forbidden';
  if (authority.hosted) return 'unavailable';
  try {
    return !requestMayBeAnAgent(request) &&
      authority.current(request) === true &&
      authority.owner(request) === true
      ? 'admitted'
      : 'forbidden';
  } catch {
    return 'forbidden';
  }
}

export interface RemoteSearchResult<Match, Instance> {
  matches: Match[];
  instances: Instance[];
  deferredInstanceCount: number;
}

/**
 * Message search's remote part, admitted only for {@link
 * remoteStationReadDecision}. Anyone else gets no remote result at all, with
 * no remote Station named and no bearer sent. Their local results come from
 * the local index, which this does not touch.
 */
export function guardRemoteMessageSearch<Match, Instance>(
  authority: RemoteStationReadAuthority | undefined,
  search: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<RemoteSearchResult<Match, Instance>>,
): (
  query: string,
  signal?: AbortSignal,
  request?: Request,
) => Promise<RemoteSearchResult<Match, Instance>> {
  return async (query, signal, request) =>
    remoteStationReadDecision(authority, request) === 'admitted'
      ? search(query, signal)
      : { matches: [], instances: [], deferredInstanceCount: 0 };
}
