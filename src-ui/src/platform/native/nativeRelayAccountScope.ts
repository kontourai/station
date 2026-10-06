import type { SavedConnection } from '@kontourai/station-connect';
import type { NativeAccountPublicScope } from './nativeAccountSessionBridge';

/** Public account partition only; continuation and signing custody stay with the host bridge. */
export interface NativeRelayAccountScope {
  readonly scopeKey: string;
  readonly generation: number;
  readonly account: NativeAccountPublicScope | null;
}
const scopes = new Map<string, NativeRelayAccountScope>();
const listeners = new Set<() => void>();
export function nativeRelayAccountScopeKey(input: {
  connectionId: string;
  origin: string;
  route: NonNullable<SavedConnection['nativeBrokerRoute']>;
  bindingId: string;
}) {
  return JSON.stringify([
    input.connectionId,
    input.origin,
    input.route,
    input.bindingId,
  ]);
}
export function getNativeRelayAccountScope(key: string | null) {
  return key ? (scopes.get(key) ?? null) : null;
}
export function subscribeNativeRelayAccountScope(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function publishNativeRelayAccountScope(
  key: string,
  account: NativeAccountPublicScope | null,
) {
  const previous = scopes.get(key);
  if (previous?.account === account) return;
  const generation = (previous?.generation ?? 0) + 1;
  scopes.set(
    key,
    Object.freeze({
      scopeKey: JSON.stringify([
        key,
        generation,
        account?.instanceId,
        account?.generation,
        account?.authorityKey,
      ]),
      generation,
      account,
    }),
  );
  for (const listener of listeners) listener();
}
