import type { SavedConnection } from '@kontourai/station-connect';
import { notifyCredentialChanged } from '@kontourai/station-sdk';
import type { ClientCredential } from '@kontourai/station-sdk/client';
import { createNativeAccountSessionBridge } from './nativeAccountSessionBridge';
import {
  getNativeRelayAccountScope,
  nativeRelayAccountScopeKey,
  publishNativeRelayAccountScope,
} from './nativeRelayAccountScope';
import { createNativeRelayApplicationRuntime } from './nativeRelayApplicationRuntime';

type OwnerInput = {
  connectionId: string;
  origin: string;
  route: NonNullable<SavedConnection['nativeBrokerRoute']>;
  bindingId: string;
  selectionIsCurrent(): boolean;
};
type Account = Awaited<ReturnType<typeof createNativeAccountSessionBridge>>;
const owners = new Map<string, Promise<NativeRelayConnectionOwner>>();
const readyOwners = new Map<string, NativeRelayConnectionOwner>();
const lifetimes = new Map<string, AbortController>();
export function retireNativeRelayConnectionOwners() {
  for (const lifetime of lifetimes.values()) lifetime.abort();
  for (const owner of [...readyOwners.values()]) owner.dispose();
}

export function captureNativeRelayConnectionOwner(key: string | null) {
  const owner = key ? readyOwners.get(key) : undefined;
  return owner?.application.isCurrent() ? owner : null;
}

export interface NativeRelayConnectionOwner {
  readonly key: string;
  readonly application: Awaited<
    ReturnType<typeof createNativeRelayApplicationRuntime>
  >;
  account(): ReturnType<Account['current']>;
  login(
    credentials: Parameters<Account['login']>[0],
  ): ReturnType<Account['login']>;
  acceptInvitation(token: string): ReturnType<Account['acceptInvitation']>;
  retireAccount(): void;
  dispose(): void;
  credential(): ClientCredential;
}

/** One process owner for the selected opaque host binding; it supplies the real SDK and sign-in UI. */
export async function prepareNativeRelayConnectionOwner(
  input: OwnerInput,
): Promise<NativeRelayConnectionOwner> {
  const key = nativeRelayAccountScopeKey(input);
  const existing = owners.get(key);
  if (existing) {
    const owner = await existing;
    if (owner.application.isCurrent()) return owner;
    owner.dispose();
  }
  for (const [otherKey, lifetime] of lifetimes) {
    if (otherKey !== key) {
      lifetime.abort();
      readyOwners.get(otherKey)?.dispose();
    }
  }
  const controller = new AbortController();
  lifetimes.set(key, controller);
  const pending = (async () => {
    const application = await createNativeRelayApplicationRuntime({
      ...input,
      signal: controller.signal,
    });
    let accountBridge: Account | undefined;
    let accountPending: Promise<Account> | undefined;
    let accountEpoch = 0;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      const current = accountBridge?.current();
      if (current)
        expiryTimer = setTimeout(
          publish,
          Math.max(0, Date.parse(current.expiresAt) - Date.now()),
        );
      publishNativeRelayAccountScope(key, accountBridge?.current() ?? null);
      notifyCredentialChanged(input.origin);
    };
    const ensureAccount = () => {
      if (accountPending) return accountPending;
      const epoch = accountEpoch;
      const attempt = createNativeAccountSessionBridge({
        profileName: input.route.profileName,
        expectedProfileRevision: input.route.profileRevision,
        signal: controller.signal,
        application,
      })
        .then((bridge) => {
          if (epoch !== accountEpoch || !application.isCurrent()) {
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
      account: () => accountBridge?.current() ?? null,
      async login(credentials) {
        await application.assertCurrent();
        return (await ensureAccount()).login(credentials);
      },
      async acceptInvitation(token) {
        const bridge = accountBridge;
        if (!bridge?.current())
          throw new Error('native_account_login_required');
        return bridge.acceptInvitation(token);
      },
      retireAccount,
      dispose() {
        if (expiryTimer) clearTimeout(expiryTimer);
        controller.abort();
        retireAccount();
        if (owners.get(key) === pending) {
          owners.delete(key);
          readyOwners.delete(key);
          lifetimes.delete(key);
        }
      },
      credential() {
        const captured = accountBridge?.current() ?? null;
        const bridge = accountBridge;
        const accountCurrent = () =>
          application.isCurrent() &&
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
            if (method !== 'GET' && method !== 'HEAD')
              throw new Error('native_relay_resource_not_supported');
            const headers = new Headers(
              init?.headers ??
                (request instanceof Request ? request.headers : undefined),
            );
            if (
              headers.has('Authorization') ||
              headers.has('Origin') ||
              [...headers.keys()].some((name) =>
                name.toLowerCase().startsWith('x-station-native-account-'),
              )
            )
              throw new Error('native_relay_supplied_authority_refused');
            if (
              url.pathname.startsWith('/api/projects') ||
              url.pathname === '/api/auth/authority'
            ) {
              if (!accountCurrent() || !bridge)
                throw Object.assign(
                  new Error('Native account sign-in is required'),
                  { code: 'station_application_authority_required' },
                );
              const proof = await bridge.requestHeaders({
                method,
                path: `${url.pathname}${url.search}`,
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
    publishNativeRelayAccountScope(key, null);
    readyOwners.set(key, owner);
    return owner;
  })();
  owners.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    if (owners.get(key) === pending) {
      owners.delete(key);
      readyOwners.delete(key);
      lifetimes.delete(key);
    }
    controller.abort();
    throw error;
  }
}
