import {
  isSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
  type RuntimeAuthenticatedRequestPrincipal,
} from './runtime-request-security.js';

declare const nativeForkReadHandleBrand: unique symbol;
export interface NativeForkReadAdmissionHandle {
  readonly [nativeForkReadHandleBrand]: true;
}

type Unavailable = {
  readonly kind: 'unavailable';
  readonly reason:
    | 'mount-not-bound'
    | 'mount-binding-mismatch'
    | 'request-not-current'
    | 'handle-not-current';
};
export type NativeForkReadAdmission =
  | { readonly kind: 'current'; readonly authority: SessionReadAuthority }
  | Unavailable;

type ReadAuthorityForRequest = (request: Request) => SessionReadAuthority;
interface MountPort {
  readonly kind: 'bound';
  capture(
    request: Request,
  ):
    | {
        readonly kind: 'captured';
        readonly handle: NativeForkReadAdmissionHandle;
      }
    | Unavailable;
  release(handle: unknown): void;
}

export interface NativeForkReadAdmissionDomain {
  /** Only this port belongs in the service constructor. */
  verifyForService(candidate: unknown): NativeForkReadAdmission;
  /** Only this paired port travels from runtime construction to route mount. */
  bindAtConversationMount(
    resolver: ReadAuthorityForRequest,
  ): MountPort | Unavailable;
}

interface Entry {
  readonly request: Request;
  readonly principal: RuntimeAuthenticatedRequestPrincipal;
  readonly authority: SessionReadAuthority;
  readonly userId: string;
  readonly mode: SessionReadAuthority['mode'];
  readonly tenantId: string | undefined;
  readonly tenantSource: string | undefined;
  readonly localHomePossession: true | undefined;
}

/**
 * One runtime owns one lexical map. A handle from another factory cannot be
 * renewed by callbacks or by copying the same principal/scope coordinates.
 * This is a request read admission, never a native effect/start claim.
 */
export function createRuntimeNativeForkReadAdmissionDomain(
  security: CurrentRuntimeRequestPrincipalSecurity,
): NativeForkReadAdmissionDomain {
  const entries = new WeakMap<object, Entry>();
  let resolver: ReadAuthorityForRequest | undefined;
  let mount: MountPort | undefined;

  const current = (entry: Entry): boolean => {
    const resolve = resolver;
    if (!resolve || entry.request.signal.aborted) return false;
    try {
      if (
        getRuntimeAuthenticatedRequestPrincipal(entry.request) !==
          entry.principal ||
        isRuntimeRequestPrincipalCurrent(entry.request, security) !== true
      )
        return false;
      const authority = resolve(entry.request);
      return (
        authority === entry.authority &&
        isSessionReadAuthority(authority) &&
        authority.userId === entry.userId &&
        authority.mode === entry.mode &&
        authority.tenantExecutionContext?.tenantId === entry.tenantId &&
        authority.tenantExecutionContext?.source === entry.tenantSource &&
        authority.localHomePossession === entry.localHomePossession &&
        !entry.request.signal.aborted &&
        getRuntimeAuthenticatedRequestPrincipal(entry.request) ===
          entry.principal &&
        isRuntimeRequestPrincipalCurrent(entry.request, security) === true &&
        getRuntimeAuthenticatedRequestPrincipal(entry.request) ===
          entry.principal
      );
    } catch {
      return false;
    }
  };

  return Object.freeze({
    verifyForService(candidate: unknown): NativeForkReadAdmission {
      if (typeof candidate !== 'object' || candidate === null)
        return { kind: 'unavailable', reason: 'handle-not-current' };
      const entry = entries.get(candidate);
      if (!entry) return { kind: 'unavailable', reason: 'handle-not-current' };
      if (!current(entry)) {
        entries.delete(candidate);
        return { kind: 'unavailable', reason: 'request-not-current' };
      }
      return { kind: 'current', authority: entry.authority };
    },
    bindAtConversationMount(
      nextResolver: ReadAuthorityForRequest,
    ): MountPort | Unavailable {
      if (resolver && resolver !== nextResolver)
        return { kind: 'unavailable', reason: 'mount-binding-mismatch' };
      if (mount) return mount;
      resolver = nextResolver;
      mount = Object.freeze({
        kind: 'bound' as const,
        capture(request: Request) {
          if (!resolver)
            return {
              kind: 'unavailable' as const,
              reason: 'mount-not-bound' as const,
            };
          try {
            const principal = getRuntimeAuthenticatedRequestPrincipal(request);
            const authority = resolver(request);
            if (!principal || !isSessionReadAuthority(authority))
              return {
                kind: 'unavailable' as const,
                reason: 'request-not-current' as const,
              };
            const entry: Entry = {
              request,
              principal,
              authority,
              userId: authority.userId,
              mode: authority.mode,
              tenantId: authority.tenantExecutionContext?.tenantId,
              tenantSource: authority.tenantExecutionContext?.source,
              localHomePossession: authority.localHomePossession,
            };
            if (!current(entry))
              return {
                kind: 'unavailable' as const,
                reason: 'request-not-current' as const,
              };
            const handle = Object.freeze({}) as NativeForkReadAdmissionHandle;
            entries.set(handle, entry);
            return { kind: 'captured' as const, handle };
          } catch {
            return {
              kind: 'unavailable' as const,
              reason: 'request-not-current' as const,
            };
          }
        },
        release(handle: unknown): void {
          if (typeof handle === 'object' && handle !== null)
            entries.delete(handle);
        },
      });
      return mount;
    },
  });
}
