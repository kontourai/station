/**
 * The account-bound device authority gate — extracted verbatim from
 * `configureRuntimeRoutes` (runtime-routes.ts) so tests exercise the real
 * middleware, not a copy.
 *
 * An account-bound device (a paired device whose `principalBinding.kind` is
 * `account`) is restricted to an explicit public/self-service route
 * allowlist and must carry a CURRENT authenticated account session. This is
 * the client-side containment for shared deployments (#488's restricted
 * guest surface among them); it is authorization boundary logic, not a
 * principal resolver — the effective principal still belongs to the
 * canonical owner in `runtime-routes.ts`.
 */
import { ACCOUNT_AUTHENTICATION_FAILURE_HEADER } from '@kontourai/station-contracts/application-session';
import type { DevicePrincipalBinding } from '@kontourai/station-contracts/environment-security';
import {
  PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
} from '@kontourai/station-contracts/environment-security';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { humanPrincipal as deploymentHumanPrincipal } from '@kontourai/station-contracts/principal';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { deploymentAccountPrincipal } from '../../services/identity/deployment-authentication-service.js';
import { PrincipalUnresolvedError } from '../../services/identity/principal-resolver.js';

/** Structural Hono context — the gate reads/answers, never dispatches. */
interface GateContext {
  env: unknown;
  req: {
    raw: Request;
    path: string;
    method: string;
    header(name: string): string | undefined;
  };
  header(name: string, value: string): void;
  json(value: unknown, status: 401 | 403): Response;
}

/** The verified ingress fact the deployment layer recognizes (`identifyIngress`). */
type IngressIdentity = { provider: string; subject: string } | null;

function isAccountDeviceBinding(
  binding: DevicePrincipalBinding,
): binding is Extract<DevicePrincipalBinding, { kind: 'account' }> {
  return 'kind' in binding && binding.kind === 'account';
}

function principalForDeviceBinding(binding: DevicePrincipalBinding) {
  // The SAME canonical constructors `runtime-routes.ts`'s identical helper
  // uses — no second id derivation exists here.
  return isAccountDeviceBinding(binding)
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

export interface AccountBoundDeviceGateDeps {
  identifyDevice(
    credential: string,
  ): { principalBinding?: DevicePrincipalBinding } | null | undefined;
  /** The SAME ingress reader `runtime-routes.ts` resolves principals with. */
  identifyIngress(context: {
    env: unknown;
    req: { header(name: string): string | undefined };
  }): IngressIdentity;
  deploymentAuthentication?: {
    service: {
      current(
        request: Request,
      ):
        | { kind: 'authenticated'; principal: PrincipalRef }
        | { kind: 'absent' }
        | { kind: 'invalid'; reason: string }
        | { kind: 'unavailable' }
        | undefined;
      resolvePrincipal(
        request: Request,
        corroborating?: readonly PrincipalRef[],
      ): PrincipalRef | undefined;
    };
  };
}

/**
 * Same derivation as `runtime-routes.ts`'s `principalForDeviceBinding` —
 * both call the canonical deployment principal constructors above.
 */
const gatePrincipalForDeviceBinding = principalForDeviceBinding;

/**
 * #488 guest administration through the account-bound allowlist.
 *
 * An account-bound admin CANNOT reach Project administration without this:
 * the pairing-scope table already grants `GET /api/projects/:slug/access`
 * at `orchestration:read` and the four mutation leaves at
 * `orchestration:operate`, and the membership service already predicates on
 * the `admin` role — but this gate denied every nested path and every
 * Project non-GET before either was consulted. The allowlist, the pairing
 * scopes, and the membership predicates compose: all three must admit.
 *
 * Exactly five leaves, method-pinned:
 * - `GET /api/projects/:slug/access` (HEAD alongside, as elsewhere);
 * - `POST .../access/invitations`, `POST .../access/invitations/:id/revoke`,
 *   `POST .../access/members`, `POST .../access/transfer`.
 *
 * Deliberately NOT opened: `POST .../access/enable` (first-sharing
 * bootstrap stays operator-only via `authority.operator()`), every other
 * private/nested/terminal/inference/Task-execution/admin path, and every
 * non-POST verb on the four mutation leaves.
 *
 * The guest device grant for this surface is exactly
 * `orchestration:read orchestration:operate`, operator-approved through the
 * existing `POST /api/pairing/devices/:deviceId/scope` rescope — WITHOUT
 * `terminal:operate` and WITHOUT `access:manage`. Never the `standard`
 * preset: that preset carries a terminal a guest manager must not hold.
 */
function isAccountBoundGuestAdminLeaf(path: string, method: string): boolean {
  if (
    (method === 'GET' || method === 'HEAD') &&
    /^\/api\/projects\/[^/]+\/access$/.test(path)
  )
    return true;
  return isAccountBoundGuestAdminWrite(path, method);
}

function isAccountBoundGuestAdminWrite(
  path: string,
  method: string,
): boolean {
  if (method !== 'POST') return false;
  return (
    /^\/api\/projects\/[^/]+\/access\/invitations$/.test(path) ||
    /^\/api\/projects\/[^/]+\/access\/invitations\/[^/]+\/revoke$/.test(
      path,
    ) ||
    /^\/api\/projects\/[^/]+\/access\/members$/.test(path) ||
    /^\/api\/projects\/[^/]+\/access\/transfer$/.test(path)
  );
}

export function installAccountBoundDeviceGate(
  app: {
    use(
      path: '*',
      handler: (
        c: GateContext,
        next: () => Promise<void>,
      ) => Promise<Response | undefined> | Response | undefined,
    ): unknown;
  },
  deps: AccountBoundDeviceGateDeps,
): void {
  app.use('*', async (c, next) => {
    const account = deps.deploymentAuthentication?.service.current(c.req.raw);
    const runtimePrincipal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    const binding =
      runtimePrincipal?.authority === 'device-credential'
        ? deps.identifyDevice(runtimePrincipal.credential)?.principalBinding
        : undefined;
    const accountBinding =
      binding && 'kind' in binding && binding.kind === 'account'
        ? binding
        : undefined;
    const accountOperation =
      c.req.path === '/api/account-auth' ||
      c.req.path.startsWith('/api/account-auth/');
    if (
      accountBinding &&
      !accountOperation &&
      account?.kind !== 'authenticated'
    ) {
      c.header(ACCOUNT_AUTHENTICATION_FAILURE_HEADER, 'account');
      return c.json(
        { error: { code: 'account_authentication_required' } },
        401,
      );
    }
    if (account && account.kind !== 'absent') {
      if (account.kind !== 'authenticated')
        return c.json(
          { error: { code: 'account_authentication_invalid' } },
          401,
        );
      const ingress = deps.identifyIngress(c);
      if (accountBinding && ingress) {
        return c.json({ error: { code: 'account_identity_conflict' } }, 401);
      }
      const people = accountBinding
        ? [gatePrincipalForDeviceBinding(accountBinding)]
        : [ingress, binding]
            .filter((person) => person !== null && person !== undefined)
            .map((person) =>
              gatePrincipalForDeviceBinding(person as DevicePrincipalBinding),
            );
      try {
        deps.deploymentAuthentication!.service.resolvePrincipal(
          c.req.raw,
          people,
        );
      } catch (error) {
        if (!(error instanceof PrincipalUnresolvedError)) throw error;
        return c.json({ error: { code: 'account_identity_conflict' } }, 401);
      }
    }
    if (accountBinding) {
      const path = c.req.path;
      const method = c.req.method;
      if (
        (path === '/api/projects' || path.startsWith('/api/projects/')) &&
        method !== 'GET' &&
        method !== 'HEAD' &&
        !isAccountBoundGuestAdminWrite(path, method)
      ) {
        return c.json(
          { error: { code: 'account_bound_device_route_forbidden' } },
          403,
        );
      }
      const permitted =
        path === '/' ||
        path.startsWith('/assets/') ||
        path === '/api/projects' ||
        /^\/api\/projects\/[^/]+$/.test(path) ||
        /^\/api\/projects\/[^/]+\/shared-work(?:\/[^/]+\/(?:history|document))?$/.test(
          path,
        ) ||
        isAccountBoundGuestAdminLeaf(path, method) ||
        path === '/api/account-auth' ||
        path.startsWith('/api/account-auth/') ||
        // #481 groundwork: the credential-bound authority observation is an
        // authorization-NEUTRAL self-read — an account-bound device may learn
        // what its own request resolves to (principal, grant, home) without
        // this allowing any other authenticated or management surface. Safe
        // methods only: the route mounts GET alone, and a non-read verb on
        // this path must stay forbidden rather than ride the self-read.
        (path === '/api/auth/authority' &&
          (c.req.method === 'GET' || c.req.method === 'HEAD')) ||
        path === PUBLIC_DEVICE_PAIRING_REQUEST_PATH ||
        path === PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH;
      if (!permitted) {
        return c.json(
          { error: { code: 'account_bound_device_route_forbidden' } },
          403,
        );
      }
    }
    await next();
  });
}
