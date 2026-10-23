/**
 * The account-bound device authority gate — extracted verbatim from
 * `configureRuntimeRoutes` (runtime-routes.ts) so tests exercise the real
 * middleware, not a copy.
 *
 * An account-bound device (a paired device whose `principalBinding.kind` is
 * `account`) is restricted to an explicit public/self-service route
 * allowlist and must carry a CURRENT authenticated account session. A
 * personal access token tied to an account (#3586) carries no session: the
 * pairing service resolves it only while its account's standing is current,
 * it must present no other account or ingress identity, and its allowlist
 * is narrower still (see {@link isAccountTokenRefusedRoute}). This is
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
import { NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH } from '@kontourai/station-contracts/native-device-proof';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { humanPrincipal as deploymentHumanPrincipal } from '@kontourai/station-contracts/principal';
import { nativeDeviceOnlyObservationRoute } from '../../security/native-device-request-authority.js';
import { isRelayManagementHttpLeaf } from '../../security/pairing-route-scopes.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  getRuntimeNativeDeviceProofPrincipal,
} from '../../security/runtime-request-security.js';
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

/** Exact relationship leaves only; domain authority still decides every target. */
export function isTaskRelationshipHttpLeaf(
  method: string,
  path: string,
): boolean {
  if (method === 'GET' || method === 'HEAD')
    return /^\/api\/tasks\/[^/]+\/(?:children|work-chats(?:\/[^/]+)?)$/.test(
      path,
    );
  if (method === 'PUT') return /^\/api\/tasks\/[^/]+\/parent$/.test(path);
  if (method === 'POST')
    return /^\/api\/tasks\/[^/]+\/(?:children|work-chats)$/.test(path);
  return method === 'DELETE' && /^\/api\/tasks\/[^/]+\/work-chats$/.test(path);
}

export interface AccountBoundDeviceGateDeps {
  currentRelationshipAccountDevice?(
    request: Request,
    binding: Extract<DevicePrincipalBinding, { kind: 'account' }>,
  ): boolean;
  identifyDevice(credential: string):
    | {
        principalBinding?: DevicePrincipalBinding;
        credentialKind?: string;
      }
    | null
    | undefined;
  /** The SAME ingress reader `runtime-routes.ts` resolves principals with. */
  identifyIngress(context: {
    env: unknown;
    req: { header(name: string): string | undefined };
  }): IngressIdentity;
  deploymentAuthentication?: {
    service: {
      /** Whether the request presents any account credential at all. */
      hasCredential(request: Request): boolean;
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
  /**
   * #2893 pilot: the shared native current-Device resolver. When a request
   * carries a proven native Device authority, its (account-bound) Device
   * binding replaces the credential lookup as this gate's binding source.
   */
  resolveNativeDevice?: (request: Request) =>
    | {
        device: { principalBinding?: DevicePrincipalBinding };
      }
    | undefined;
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

/**
 * #3586: an account-bound device's own personal access tokens (list, make,
 * revoke), method-pinned. The route handler refuses a token caller itself.
 */
function isAccountBoundOwnTokenLeaf(path: string, method: string): boolean {
  return (
    ((method === 'GET' || method === 'HEAD' || method === 'POST') &&
      path === '/api/access/tokens') ||
    (method === 'DELETE' && /^\/api\/access\/tokens\/[^/]+$/.test(path))
  );
}

/**
 * #3586: what an account-tied personal access token may never reach, even
 * inside the account-bound allowlist: the account's own sign-in surface,
 * token management (a token never makes or lists tokens), and every
 * Project access leaf, the administration read included. A leaked script
 * credential must not administer who holds a Project.
 */
function isAccountTokenRefusedRoute(path: string): boolean {
  return (
    path === '/api/account-auth' ||
    path.startsWith('/api/account-auth/') ||
    path === '/api/access/tokens' ||
    path.startsWith('/api/access/tokens/') ||
    /^\/api\/projects\/[^/]+\/access(?:\/|$)/.test(path)
  );
}

function isAccountBoundGuestAdminWrite(path: string, method: string): boolean {
  if (method !== 'POST') return false;
  return (
    /^\/api\/projects\/[^/]+\/access\/invitations$/.test(path) ||
    /^\/api\/projects\/[^/]+\/access\/invitations\/[^/]+\/revoke$/.test(path) ||
    /^\/api\/projects\/[^/]+\/access\/members$/.test(path) ||
    /^\/api\/projects\/[^/]+\/access\/transfer$/.test(path)
  );
}

/** Closed Room leaves; the mounted service owns each membership action. */
function isAccountBoundRoomLeaf(path: string, method: string): boolean {
  if (method === 'GET' || method === 'HEAD')
    return /^\/api\/projects\/[^/]+\/room(?:\/(?:messages|events|agents\/[^/]+))?$/.test(
      path,
    );
  if (method === 'PUT')
    return /^\/api\/projects\/[^/]+\/room\/note$/.test(path);
  return (
    method === 'POST' &&
    /^\/api\/projects\/[^/]+\/room\/(?:init|messages|presence|agents|agents\/[^/]+\/(?:cancel|reconcile))$/.test(
      path,
    )
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
    const runtimePrincipal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    // This exact protected Device self-read bootstraps binding observation
    // before an account session exists. Its handler rechecks Device custody;
    // it supplies no account principal or Project authority. A personal
    // access token is not a Device and never takes this shortcut (#3586).
    if (
      runtimePrincipal?.kind === 'credential' &&
      runtimePrincipal.authority === 'device-credential' &&
      runtimePrincipal.source === 'bearer' &&
      runtimePrincipal.deviceKind === 'device' &&
      deps.identifyDevice(runtimePrincipal.credential)?.credentialKind !==
        'personal-token' &&
      (c.req.method === 'GET' || c.req.method === 'HEAD') &&
      c.req.path.startsWith(`${NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH}/`) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/receipt$/.test(
        c.req.path.slice(NATIVE_DEVICE_PROOF_SELF_RECEIPT_BASE_PATH.length + 1),
      )
    ) {
      await next();
      return;
    }
    const account = deps.deploymentAuthentication?.service.current(c.req.raw);
    const nativeDevice = deps.resolveNativeDevice?.(c.req.raw);
    if (getRuntimeNativeDeviceProofPrincipal(c.req.raw) && !nativeDevice)
      return c.json(
        { error: { code: 'native_device_proof_device_not_current' } },
        403,
      );
    const credentialDevice =
      !nativeDevice && runtimePrincipal?.authority === 'device-credential'
        ? deps.identifyDevice(runtimePrincipal.credential)
        : undefined;
    const binding = nativeDevice
      ? nativeDevice.device.principalBinding
      : credentialDevice?.principalBinding;
    const accountBinding =
      binding && 'kind' in binding && binding.kind === 'account'
        ? binding
        : undefined;
    // #3586: a personal access token tied to an account acts as that
    // account on its own. Any other identity alongside it, an account
    // credential (cookie or continuation) or an ingress identity, is a
    // conflict, never a corroboration.
    const accountToken =
      accountBinding !== undefined &&
      credentialDevice?.credentialKind === 'personal-token';
    if (
      accountToken &&
      (deps.deploymentAuthentication?.service.hasCredential(c.req.raw) ||
        deps.identifyIngress(c))
    )
      return c.json({ error: { code: 'account_identity_conflict' } }, 401);
    const accountOperation =
      c.req.path === '/api/account-auth' ||
      c.req.path.startsWith('/api/account-auth/');
    if (
      accountBinding &&
      !accountToken &&
      !accountOperation &&
      !(
        getRuntimeNativeDeviceProofPrincipal(c.req.raw) &&
        nativeDeviceOnlyObservationRoute(c.req.method, c.req.path)
      ) &&
      account?.kind !== 'authenticated' &&
      !(
        account?.kind === 'absent' &&
        isTaskRelationshipHttpLeaf(c.req.method, c.req.path) &&
        deps.currentRelationshipAccountDevice?.(c.req.raw, accountBinding) ===
          true
      )
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
      if (accountToken && isAccountTokenRefusedRoute(path))
        return c.json(
          { error: { code: 'account_bound_device_route_forbidden' } },
          403,
        );
      if (
        (path === '/api/projects' || path.startsWith('/api/projects/')) &&
        method !== 'GET' &&
        method !== 'HEAD' &&
        !isAccountBoundGuestAdminWrite(path, method) &&
        !isAccountBoundRoomLeaf(path, method)
      ) {
        return c.json(
          { error: { code: 'account_bound_device_route_forbidden' } },
          403,
        );
      }
      const permitted =
        (method === 'GET' &&
          [
            '/api/tool-library/access',
            '/api/tool-library/catalog',
            '/api/tool-library/requests',
          ].includes(path)) ||
        (method === 'POST' && path === '/api/tool-library/requests') ||
        (method === 'POST' &&
          /^\/api\/tool-library\/sources\/[^/]+\/discover$/.test(path)) ||
        (/^(?:\/api\/tool-library\/projects\/[^/]+\/agents(?:\/[^/]+)?|\/api\/tool-library\/projects\/[^/]+\/policy)$/.test(
          path,
        ) &&
          ['GET', 'POST', 'PUT'].includes(method)) ||
        (/^\/api\/tool-library\/accounts\/[^/]+(?:\/(?:authorize|callback))?$/.test(
          path,
        ) &&
          ['GET', 'POST'].includes(method)) ||
        ((method === 'GET' || method === 'HEAD') &&
          (path === '/api/knowledge/capabilities' ||
            path === '/api/knowledge/s3-sources/capabilities' ||
            /^\/api\/knowledge\/s3-sources\/projects\/[^/]+(?:\/[^/]+\/(?:objects|object))?$/.test(
              path,
            ) ||
            path === '/api/knowledge/roots' ||
            path === '/api/knowledge/adapters' ||
            /^\/api\/knowledge\/roots\/[^/]+\/document-imports\/[^/]+\/originals\/\d+$/.test(
              path,
            ) ||
            /^\/api\/knowledge\/roots\/[^/]+\/(?:graph|records(?:\/[^/]+)?)$/.test(
              path,
            ))) ||
        path === '/' ||
        path.startsWith('/assets/') ||
        // Neutral observations are open only to a verified native Device
        // proof, as in the account check above; a credential-bound device
        // still reaches /api/system/identity alone below.
        (getRuntimeNativeDeviceProofPrincipal(c.req.raw) &&
          nativeDeviceOnlyObservationRoute(method, path)) ||
        (getRuntimeNativeDeviceProofPrincipal(c.req.raw) &&
          isRelayManagementHttpLeaf({ method, path })) ||
        path === '/api/projects' ||
        /^\/api\/projects\/[^/]+$/.test(path) ||
        /^\/api\/projects\/[^/]+\/shared-work(?:\/[^/]+\/(?:history|document|publication))?$/.test(
          path,
        ) ||
        isAccountBoundGuestAdminLeaf(path, method) ||
        isAccountBoundRoomLeaf(path, method) ||
        isTaskRelationshipHttpLeaf(method, path) ||
        isAccountBoundOwnTokenLeaf(path, method) ||
        (path === '/api/me/preferences' &&
          (method === 'GET' || method === 'HEAD' || method === 'PATCH')) ||
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
        // A fresh account-bound Device reaches the Station through the
        // encrypted application channel before it has a page-host cookie.
        // The browser gate needs this exact protected Station self-identity
        // read to admit the UI after signed Device/session activation. Its
        // Device and account proofs are still checked above; other system
        // status, management and execution leaves stay forbidden.
        (path === '/api/system/identity' &&
          (method === 'GET' || method === 'HEAD')) ||
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
