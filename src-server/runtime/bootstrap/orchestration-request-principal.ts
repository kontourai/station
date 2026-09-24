/**
 * The canonical orchestration request-principal resolver, extracted verbatim
 * from `runtime-routes.ts` so the routes module AND the authority
 * observation (#481 groundwork) resolve through the ONE composition — never
 * a parallel identity derivation. Behavior is unchanged: precedence is
 * WhoIs ingress identity, then the verified operator authority fact, then a
 * device person binding / device session identity; the deployment-account
 * principal (when the request carries a valid account credential) wins over
 * the personal fallbacks exactly as before. A resolution failure throws
 * `PrincipalUnresolvedError` — never a default identity.
 */

import type {
  DevicePrincipalBinding,
  PairedDevice,
} from '@kontourai/station-contracts/environment-security';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { humanPrincipal as deploymentHumanPrincipal } from '@kontourai/station-contracts/principal';
import { getCachedUser } from '../../routes/system/auth.js';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import {
  type DeploymentAuthenticationService,
  deploymentAccountPrincipal,
} from '../../services/identity/deployment-authentication-service.js';
import type { VerifiedIdentity } from '../../services/identity/identity-source.js';
import { identifyIngress } from '../../services/identity/identity-source.js';
import {
  PrincipalUnresolvedError,
  resolvePrincipal as resolveStationPrincipal,
} from '../../services/identity/principal-resolver.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { memoizePerRequest } from '../../utils/memoize-per-request.js';
import { tenantExecutionContextForRequest } from './runtime-tenant-context.js';

function isAccountDeviceBinding(
  binding: DevicePrincipalBinding,
): binding is Extract<DevicePrincipalBinding, { kind: 'account' }> {
  return 'kind' in binding && binding.kind === 'account';
}

function principalForDeviceBinding(
  binding: DevicePrincipalBinding,
): PrincipalRef {
  return 'kind' in binding
    ? deploymentAccountPrincipal(
        binding.issuer,
        binding.subject,
        binding.displayName,
      )
    : deploymentHumanPrincipal(
        binding.provider,
        binding.subject,
        binding.subject,
      );
}

/** The identity a request carrying this device's own credential presents. */
function deviceIdentity(
  device: Pick<PairedDevice, 'id' | 'name'>,
): VerifiedIdentity {
  return {
    provider: 'device',
    subject: device.id,
    displayName: device.name?.trim() || device.id,
  };
}

/**
 * The principal a request authenticated by this paired device's own
 * credential resolves to through the resolver below, when that request
 * carries no ingress (WhoIs) identity and no deployment-account session: the
 * device's person binding when it is a tailnet binding, otherwise the device
 * itself. Background work acting for a device (the agent-activity publisher
 * reading what that phone may see) uses this so it reads exactly what the
 * device's own requests read, never a process-wide identity.
 */
export function pairedDevicePrincipal(
  device: Pick<PairedDevice, 'id' | 'name' | 'principalBinding'>,
): PrincipalRef {
  const binding = device.principalBinding;
  return resolveStationPrincipal(
    binding && !('kind' in binding)
      ? {
          provider: binding.provider,
          subject: binding.subject,
          displayName: binding.subject,
        }
      : deviceIdentity(device),
    'personal',
    undefined,
    undefined,
    { resolveOperatorDisplay: () => getCachedUser().alias },
  );
}

export interface OrchestrationRequestPrincipalDeps {
  environmentSecurityService: Pick<
    EnvironmentSecurityService,
    'identifyDevice'
  >;
  deploymentAuthentication?: Pick<
    DeploymentAuthenticationService,
    'resolvePrincipal'
  >;
  hostedTenantRegistry?: unknown;
}

/**
 * The SAME memoized closure `configureRuntimeRoutes` has always installed —
 * same body, same per-request memoization, same failure contract. Callers
 * must treat a resolved principal as the CAPTURED fact for the request and
 * re-derive freshness separately (see the authority observation's release
 * guard); the memoization means re-invoking this resolver does NOT prove
 * currency.
 */
export function createOrchestrationRequestPrincipalResolver(
  deps: OrchestrationRequestPrincipalDeps,
): (c: {
  env: unknown;
  req: { raw: Request; header(name: string): string | undefined };
}) => PrincipalRef {
  const { environmentSecurityService, hostedTenantRegistry } = deps;
  const deploymentAuthentication = deps.deploymentAuthentication
    ? {
        resolvePrincipal: deps.deploymentAuthentication.resolvePrincipal.bind(
          deps.deploymentAuthentication,
        ),
      }
    : undefined;
  const deviceSessionIdentity = (
    runtimePrincipal: RuntimeAuthenticatedRequestPrincipal | undefined,
  ): VerifiedIdentity | null => {
    if (runtimePrincipal?.authority !== 'device-credential') return null;
    const device = environmentSecurityService.identifyDevice(
      runtimePrincipal.credential,
    );
    if (!device) return null;
    return deviceIdentity(device);
  };
  return memoizePerRequest((c) => {
    const runtimePrincipal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    const operatorAuthority =
      runtimePrincipal?.locality === 'home-possession'
        ? { locality: runtimePrincipal.locality }
        : runtimePrincipal?.authority === 'operator-credential'
          ? ({ verifiedOperatorCredential: true } as const)
          : undefined;
    const ingressIdentity = identifyIngress(c);
    const binding =
      runtimePrincipal?.authority === 'device-credential'
        ? environmentSecurityService.identifyDevice(runtimePrincipal.credential)
            ?.principalBinding
        : undefined;
    if (
      binding &&
      (hostedTenantRegistry !== undefined ||
        (isAccountDeviceBinding(binding)
          ? ingressIdentity !== null
          : ingressIdentity &&
            (ingressIdentity.provider !== binding.provider ||
              ingressIdentity.subject !== binding.subject)))
    ) {
      throw new PrincipalUnresolvedError(
        'Device person binding conflicts with the current identity or deployment',
      );
    }
    const verifiedPerson = binding
      ? principalForDeviceBinding(binding)
      : ingressIdentity
        ? deploymentHumanPrincipal(
            ingressIdentity.provider,
            ingressIdentity.subject,
            ingressIdentity.subject,
          )
        : undefined;
    const account = deploymentAuthentication?.resolvePrincipal(
      c.req.raw,
      verifiedPerson ? [verifiedPerson] : [],
    );
    if (account) return account;
    return resolveStationPrincipal(
      (binding && !('kind' in binding)
        ? {
            provider: binding.provider,
            subject: binding.subject,
            displayName: binding.subject,
          }
        : ingressIdentity) ??
        (operatorAuthority ? null : deviceSessionIdentity(runtimePrincipal)),
      hostedTenantRegistry !== undefined ? 'hosted' : 'personal',
      operatorAuthority,
      tenantExecutionContextForRequest(c.req.raw),
      { resolveOperatorDisplay: () => getCachedUser().alias },
    );
  });
}
