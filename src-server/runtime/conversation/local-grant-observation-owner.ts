import { timingSafeEqual } from 'node:crypto';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  getRuntimeAuthenticatedRequestPrincipal,
  isBoundLocalGrantMintedOperator,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import {
  type CurrentLocalGrantObservationOwner,
  ProviderCredentialObservationError,
} from './provider-credential-observation.js';

export type LocalGrantObservationAdmission = <Value>(
  check: () => Value,
) => Promise<Value>;

type ExistingLease = ReturnType<
  CurrentLocalGrantObservationOwner['requireCurrentLocalGrant']
>;
export interface EnvironmentLocalGrantObservationOwner
  extends CurrentLocalGrantObservationOwner {
  requireCurrentLocalGrant(request: Request): ExistingLease &
    Readonly<{
      /** PRIVATE comparison witness. Never a grant, credential identity or DTO.
       * Persist/compare it privately to detect authority-key changes on restart. */
      privateHostContextWitness: string;
    }>;
}
function refuse(): never {
  throw new ProviderCredentialObservationError('authorization_unavailable');
}
function sameSignature(a: string, b: string): boolean {
  return (
    /^[A-Za-z0-9_-]{43}$/u.test(a) &&
    /^[A-Za-z0-9_-]{43}$/u.test(b) &&
    timingSafeEqual(Buffer.from(a, 'base64url'), Buffer.from(b, 'base64url'))
  );
}

/** Captures already-existing owners only; never initializes a home or mints a
 * credential/grant. This capability is private, bound to THIS authenticated
 * Request, and cannot be reused for another Request with identical headers.
 * Host signing proves current host custody only, not authorization/entitlement.
 */
export function captureEnvironmentLocalGrantObservationOwner(
  boundRequest: Request,
  environment: EnvironmentSecurityService,
  security: CurrentRuntimeRequestPrincipalSecurity,
  admit?: LocalGrantObservationAdmission,
): Promise<EnvironmentLocalGrantObservationOwner> {
  return captureExistingLocalGrant(
    boundRequest,
    environment,
    security,
    'POST',
    admit,
  );
}

/** Read custody only. This interface cannot issue an SDK credential/source lease. */
export async function captureEnvironmentLocalGrantReadOwner(
  request: Request,
  environment: EnvironmentSecurityService,
  security: CurrentRuntimeRequestPrincipalSecurity,
  admit?: LocalGrantObservationAdmission,
): Promise<
  Readonly<{
    hostContextId: string;
    assertCurrent(): void;
  }>
> {
  const owner = await captureExistingLocalGrant(
    request,
    environment,
    security,
    'GET',
    admit,
  );
  const lease = admit
    ? await admit(() => owner.requireCurrentLocalGrant(request))
    : owner.requireCurrentLocalGrant(request);
  const read = {
    hostContextId: lease.hostContextId,
    assertCurrent: () => {
      request.signal.throwIfAborted();
      lease.assertCurrent();
    },
  };
  return Object.freeze(read);
}

async function captureExistingLocalGrant(
  boundRequest: Request,
  environment: EnvironmentSecurityService,
  security: CurrentRuntimeRequestPrincipalSecurity,
  method: 'POST' | 'GET',
  admit?: LocalGrantObservationAdmission,
): Promise<EnvironmentLocalGrantObservationOwner> {
  try {
    if (
      !(environment instanceof EnvironmentSecurityService) ||
      boundRequest.method !== method
    )
      refuse();
    const principal = getRuntimeAuthenticatedRequestPrincipal(boundRequest);
    if (!principal || principal.kind === 'internal') refuse();
    const credential = principal.credential;
    const requirePrincipal = () =>
      environment.withCurrentAuthority(() => {
        const scope = environment.readCurrentUnboundLocalGrantScope(credential);
        if (
          getRuntimeAuthenticatedRequestPrincipal(boundRequest) !== principal ||
          !isBoundLocalGrantMintedOperator(boundRequest) ||
          principal.locality !== 'home-possession' ||
          principal.mintKind !== 'local-grant' ||
          scope === undefined ||
          !isRuntimeRequestPrincipalCurrent(boundRequest, {
            authorizeCredential: (candidate) => candidate === credential,
            resolveGrantedScope: () => scope,
          }) ||
          environment.credentialLocality(credential) !== 'home-possession' ||
          environment.credentialMintKind(credential) !== 'local-grant' ||
          !isRuntimeRequestPrincipalCurrent(boundRequest, security)
        )
          refuse();
      });
    if (admit) await admit(requirePrincipal);
    else requirePrincipal();
    const before = await environment.readExistingRecord();
    if (admit) await admit(requirePrincipal);
    else requirePrincipal();
    const environmentId = before.environmentId;
    const binding = JSON.stringify([
      'station.provider-credential-observation.host-context.v1',
      environmentId,
    ]);
    const sign = () =>
      environment.signRevisionEvidenceAuthorityBinding(binding);
    const witness = admit ? await admit(sign) : sign();
    // The signer rechecks its own current ID but does not return that ID.
    // A reset between the async read and first sign could otherwise sign an
    // OLD captured ID with the NEW key and appear stable to a closure.
    const after = await environment.readExistingRecord();
    if (after.environmentId !== environmentId) refuse();
    const assertCurrent = () => {
      try {
        environment.withCurrentAuthority(() => {
          requirePrincipal();
          if (
            !sameSignature(
              witness,
              environment.signRevisionEvidenceAuthorityBinding(binding),
            )
          )
            refuse();
          requirePrincipal();
        });
      } catch {
        refuse();
      }
    };
    if (admit) await admit(assertCurrent);
    else assertCurrent();
    return Object.freeze({
      withObservationScope<T>(request: Request, check: () => T): T {
        if (request !== boundRequest) refuse();
        return environment.withCurrentAuthority(check);
      },
      requireCurrentLocalGrant(request: Request) {
        if (request !== boundRequest) refuse();
        assertCurrent();
        const lease = {
          principalCredential: credential,
          hostContextId: environmentId,
          privateHostContextWitness: witness,
          assertCurrent,
        };
        // Both values remain accessible to the private observation store, but
        // accidental serialization of the lease must not disclose them.
        Object.defineProperty(lease, 'principalCredential', {
          enumerable: false,
        });
        Object.defineProperty(lease, 'privateHostContextWitness', {
          enumerable: false,
        });
        return Object.freeze(lease);
      },
    });
  } catch {
    return refuse();
  }
}
