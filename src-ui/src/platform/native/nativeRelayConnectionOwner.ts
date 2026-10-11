import type { SavedConnection } from '@kontourai/station-connect';
import { notifyCredentialChanged } from '@kontourai/station-sdk';
import { isNativeManagementRequest } from '@kontourai/station-sdk/application-session-native';
import type { ClientCredential } from '@kontourai/station-sdk/client';
import { createNativeAccountSessionBridge } from './nativeAccountSessionBridge';
import {
  getNativeRelayAccountScope,
  nativeRelayAccountScopeKey,
  publishNativeRelayAccountScope,
} from './nativeRelayAccountScope';
import { createNativeRelayApplicationRuntime } from './nativeRelayApplicationRuntime';
import { prepareRegisteredNativeRelayConnectionOwner } from './nativeRelayConnectionOwnerRegistry';

type OwnerInput = {
  connectionId: string;
  origin: string;
  route: NonNullable<SavedConnection['nativeBrokerRoute']>;
  bindingId: string;
  selectionIsCurrent(): boolean;
};
type Account = Awaited<ReturnType<typeof createNativeAccountSessionBridge>>;

export interface NativeRelayConnectionOwner {
  readonly key: string;
  isCurrent(): boolean;
  readonly application: Awaited<
    ReturnType<typeof createNativeRelayApplicationRuntime>
  >;
  account(): ReturnType<Account['current']>;
  login(
    credentials: Parameters<Account['login']>[0],
  ): ReturnType<Account['login']>;
  acceptInvitation(token: string): ReturnType<Account['acceptInvitation']>;
  logout(): ReturnType<Account['logout']>;
  retireAccount(): void;
  dispose(): void;
  credential(): ClientCredential;
}

/** One process owner for the selected opaque host binding; it supplies the real SDK and sign-in UI. */
export async function prepareNativeRelayConnectionOwner(
  input: OwnerInput,
): Promise<NativeRelayConnectionOwner> {
  const key = nativeRelayAccountScopeKey(input);
  return prepareRegisteredNativeRelayConnectionOwner(key, async (lease) => {
    const application = await createNativeRelayApplicationRuntime({
      ...input,
      signal: lease.signal,
    });
    let disposed = false;
    const isCurrent = () =>
      !disposed && lease.isCurrent() && application.isCurrent();
    let accountBridge: Account | undefined;
    let accountPending: Promise<Account> | undefined;
    let accountEpoch = 0;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (!lease.isCurrent()) return;
      if (expiryTimer) clearTimeout(expiryTimer);
      const current = isCurrent() ? (accountBridge?.current() ?? null) : null;
      if (current) {
        const retainedBridge = accountBridge;
        expiryTimer = setTimeout(
          () => {
            if (
              accountBridge === retainedBridge &&
              Date.parse(current.expiresAt) <= Date.now()
            )
              retireAccount();
            else publish();
          },
          Math.max(0, Date.parse(current.expiresAt) - Date.now()),
        );
      }
      publishNativeRelayAccountScope(key, accountBridge?.current() ?? null);
      notifyCredentialChanged(input.origin);
    };
    const ensureAccount = () => {
      if (accountPending) return accountPending;
      const epoch = accountEpoch;
      const attempt = createNativeAccountSessionBridge({
        profileName: input.route.profileName,
        expectedProfileRevision: input.route.profileRevision,
        signal: lease.signal,
        application,
      })
        .then((bridge) => {
          if (
            epoch !== accountEpoch ||
            !isCurrent() ||
            !application.isCurrent()
          ) {
            bridge.retire();
            throw new Error('native_account_scope_retired');
          }
          accountBridge = bridge;
          bridge.subscribe(publish);
          publish();
          return bridge;
        })
        .catch((error: unknown) => {
          if (accountPending === attempt) accountPending = undefined;
          throw error;
        });
      accountPending = attempt;
      return attempt;
    };
    const retireAccount = () => {
      accountEpoch++;
      accountBridge?.retire();
      accountBridge = undefined;
      accountPending = undefined;
      publish();
    };
    const owner: NativeRelayConnectionOwner = {
      key,
      application,
      isCurrent,
      account: () => accountBridge?.current() ?? null,
      async login(credentials) {
        if (!isCurrent())
          throw new Error('native_relay_connection_owner_retired');
        await application.assertCurrent();
        if (!isCurrent())
          throw new Error('native_relay_connection_owner_retired');
        return (await ensureAccount()).login(credentials);
      },
      async acceptInvitation(token) {
        const bridge = accountBridge;
        if (!isCurrent() || !bridge?.current())
          throw new Error('native_account_login_required');
        return bridge.acceptInvitation(token);
      },
      async logout() {
        const bridge = accountBridge;
        if (!isCurrent() || !bridge?.current())
          throw new Error('native_account_login_required');
        try {
          await application.assertCurrent();
          return await bridge.logout();
        } finally {
          if (accountBridge === bridge) retireAccount();
        }
      },
      retireAccount,
      dispose() {
        if (disposed) return;
        disposed = true;
        if (expiryTimer) clearTimeout(expiryTimer);
        retireAccount();
        lease.release();
      },
      credential() {
        const captured = accountBridge?.current() ?? null;
        const bridge = accountBridge;
        const accountCurrent = () =>
          isCurrent() &&
          !!captured &&
          accountBridge === bridge &&
          bridge?.current() === captured;
        return {
          origin: input.origin,
          mutationAllowed: () => false,
          transportBindingIsCurrent: () =>
            application.isCurrent() && (!captured || accountCurrent()),
          ...(captured
            ? {
                requestAuthority: {
                  apiBase: input.origin,
                  authorityKey: getNativeRelayAccountScope(key)!.scopeKey,
                  isCurrent: accountCurrent,
                },
              }
            : {}),
          onAccountUnauthorized: () => {
            if (accountCurrent()) retireAccount();
          },
          // A generic 401 or Project 403 is not permission to erase Device custody.
          transport: async (request, init) => {
            const url = new URL(
              request instanceof Request ? request.url : request.toString(),
            );
            const method = (
              init?.method ??
              (request instanceof Request ? request.method : 'GET')
            ).toUpperCase();
            const management = isNativeManagementRequest(
              method,
              `${url.pathname}${url.search}`,
            );
            if (method !== 'GET' && method !== 'HEAD' && !management)
              throw new Error('native_relay_resource_not_supported');
            const headers = new Headers(
              init?.headers ??
                (request instanceof Request ? request.headers : undefined),
            );
            if (
              headers.has('Authorization') ||
              headers.has('Cookie') ||
              headers.has('Origin') ||
              [...headers.keys()].some((name) =>
                name.toLowerCase().startsWith('x-station-native-account-'),
              )
            )
              throw new Error('native_relay_supplied_authority_refused');
            if (
              url.pathname.startsWith('/api/projects') ||
              url.pathname === '/api/auth/authority' ||
              management
            ) {
              if (!accountCurrent() || !bridge)
                throw Object.assign(
                  new Error('Native account sign-in is required'),
                  { code: 'station_application_authority_required' },
                );
              const target = {
                method:
                  method === 'POST'
                    ? ('POST' as const)
                    : method === 'HEAD'
                      ? ('HEAD' as const)
                      : ('GET' as const),
                path: `${url.pathname}${url.search}`,
              };
              const proof = management
                ? await bridge.managementHeaders(target)
                : await bridge.requestHeaders({
                    method: method === 'HEAD' ? 'HEAD' : 'GET',
                    path: target.path,
                  });
              if (!accountCurrent())
                throw new Error('native_account_scope_retired');
              for (const [name, value] of Object.entries(proof))
                headers.set(name, value);
            }
            const response = await application.fetch(request, {
              ...init,
              headers,
            });
            if (captured && !accountCurrent())
              throw new Error('native_account_scope_retired');
            return response;
          },
        };
      },
    };
    publish();
    return owner;
  });
}
