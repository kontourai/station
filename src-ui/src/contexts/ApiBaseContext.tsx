/**
 * ApiBaseContext — thin backward-compat wrapper over @kontourai/station-connect.
 * Consumers continue to call useApiBase / <ApiBaseProvider> with the same API shape.
 */

import {
  ConnectionsProvider,
  DEFAULT_CONNECTION_CREDENTIAL_KEY,
  defaultCredentialStorage,
  type InjectedConnection,
  RejectingCredentialStorage,
  requestAuthorityScopeFromCredentialEvidence,
  setNativePairingExchangeTransport,
  useConnections,
} from '@kontourai/station-connect';
import {
  _setApiBase,
  notifyCredentialChanged,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import {
  type ReactNode,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
} from 'react';
import {
  nativeProfileRepository,
  useNativeProfileSelection,
  useNativeProfileStoreEpoch,
  usePlatformProfile,
} from '../platform/PlatformProfileContext';
import { useBundledServerStatus } from '../platform/useBundledServerStatus';

const rejectingDesktopCredentialStorage = new RejectingCredentialStorage();

// Keep Tauri's Channel/invoke implementation out of the browser's eager
// bundle. These platform adapters are loaded only when the native shell
// actually makes an authenticated request or exchanges a pairing code.
const lazyNativeAuthenticatedTransport: typeof fetch = async (input, init) => {
  const authorityGuard = (
    init as (RequestInit & { authorityGuard?: () => void }) | undefined
  )?.authorityGuard;
  authorityGuard?.();
  const { nativeAuthenticatedTransport } = await import(
    '../platform/native/authenticatedTransport'
  );
  // Importing the native bridge is asynchronous. Do not let a connection
  // switch while it loads turn this request into the newly active authority.
  authorityGuard?.();
  return nativeAuthenticatedTransport(input, init);
};

function nativeTransportForBinding(bindingId: string): typeof fetch {
  return (input, init) =>
    (init as (RequestInit & { authorityGuard?: () => void }) | undefined)
      ?.authorityGuard
      ? lazyNativeAuthenticatedTransport(input, {
          ...(init ?? {}),
          expectedBindingId: bindingId,
        } as RequestInit)
      : lazyNativeAuthenticatedTransport(input, init);
}

const lazyNativePairingExchangeTransport = async (
  ...args: Parameters<
    NonNullable<Parameters<typeof setNativePairingExchangeTransport>[0]>
  >
) => {
  const { nativePairingExchangeTransport } = await import(
    '../platform/native/pairingTransport'
  );
  const input = args[0] as (typeof args)[0] & { operationId?: string };
  return nativePairingExchangeTransport({
    ...input,
    operationId: input.operationId ?? randomCorrelationId(),
  });
};

const CLI_INJECTED_BASE =
  (window as Window & { __API_BASE__?: string }).__API_BASE__ || null;

const DEFAULT_API_BASE =
  CLI_INJECTED_BASE || import.meta.env.VITE_API_BASE || window.location.origin;
const NATIVE_DEFAULT_API_BASE =
  CLI_INJECTED_BASE || import.meta.env.VITE_API_BASE || '';

export function ApiBaseProvider({ children }: { children: ReactNode }) {
  const profile = usePlatformProfile();
  if (profile.isTauri) {
    // Purge credentials written by older desktop builds before constructing a
    // ConnectionStore snapshot. Native bearers now remain host-owned only.
    defaultCredentialStorage.remove(DEFAULT_CONNECTION_CREDENTIAL_KEY);
  }
  const profileStoreEpoch = useNativeProfileStoreEpoch();
  const prepareNativeActiveConnection = useNativeProfileSelection();
  const bundledStatus = useBundledServerStatus(profile.supervisesBundledServer);

  // Resolve one host-supplied, never-persisted connection. An explicit CLI
  // base is deliberate user intent and therefore always wins over desktop
  // ownership. Otherwise unified native status supplies the local owner.
  const injectedConnection = useMemo<InjectedConnection | null>(() => {
    if (CLI_INJECTED_BASE) {
      return {
        id: 'cli-base',
        name: 'Station',
        url: CLI_INJECTED_BASE,
        source: 'cli-base',
      };
    }
    if (profile.isMobile && profile.mobileDefaultEndpoint) {
      return {
        id: `mobile-default-${profile.channel ?? 'stable'}`,
        name: `Station ${profile.channel ?? 'stable'}`,
        url: profile.mobileDefaultEndpoint,
        source: 'mobile-default',
      };
    }
    if (!bundledStatus) return null;
    const status =
      bundledStatus.phase === 'running'
        ? 'running'
        : bundledStatus.phase === 'failed'
          ? 'failed'
          : bundledStatus.phase === 'stopped' ||
              bundledStatus.phase === 'stopping'
            ? 'stopped'
            : 'starting';
    return {
      id: 'managed-loopback',
      name: 'Station on this device',
      ...(bundledStatus.apiBase ? { url: bundledStatus.apiBase } : {}),
      source: 'managed-loopback',
      status,
      ...(bundledStatus.instanceId
        ? { ownerId: bundledStatus.instanceId }
        : {}),
    };
  }, [
    bundledStatus,
    profile.channel,
    profile.isMobile,
    profile.mobileDefaultEndpoint,
  ]);

  return (
    <ConnectionsProvider
      defaultUrl={profile.isTauri ? NATIVE_DEFAULT_API_BASE : DEFAULT_API_BASE}
      seedDefault={!profile.isTauri}
      injectedConnection={injectedConnection}
      credentialStorage={
        profile.isTauri ? rejectingDesktopCredentialStorage : undefined
      }
      connectionStorage={
        profile.isTauri ? nativeProfileRepository() : undefined
      }
      connectionStorageRevision={
        profile.isTauri ? profileStoreEpoch : undefined
      }
      commitVerifiedPairing={
        profile.isTauri
          ? async (pairing) => {
              const connectionId =
                await nativeProfileRepository().commitVerifiedPairing(pairing);
              notifyCredentialChanged(new URL(pairing.endpoint).origin);
              return connectionId;
            }
          : undefined
      }
      makeDefaultProfile={
        profile.isTauri
          ? async (connectionId) => {
              await nativeProfileRepository().makeDefault(connectionId);
            }
          : undefined
      }
      prepareActiveConnection={
        profile.isTauri ? prepareNativeActiveConnection : undefined
      }
      // archive#1286: `packages/connect` is platform-blind, so the already-
      // resolved platform profile (awaited past any capability-report race)
      // is the source of truth for whether the page is a native shell —
      // not an inline `window` check re-derived downstream.
      nativeShell={profile.isTauri}
    >
      <StationCredentialBridge>{children}</StationCredentialBridge>
    </ConnectionsProvider>
  );
}

function StationCredentialBridge({ children }: { children: ReactNode }) {
  const {
    apiBase,
    activeConnection,
    markCredentialRequired,
    captureCredentialEvidence,
    isCredentialEvidenceCurrent,
    recordAuthenticatedSuccess,
    credentialAuthorityGeneration,
  } = useConnections();
  const profile = usePlatformProfile();

  // Keep the shared SDK transport aligned above OnboardingGate. SDKAdapter
  // cannot do this while the gate is showing a blocking connection error.
  _setApiBase(apiBase);

  // The native host notification watch is **dormant** — deliberately not
  // started. The live blocker is archive#917 (the FCM/APNs dependency decision;
  // archive#3088, which corrected this record, is closed). It is blocked
  // three ways on Android (the cached-app
  // freezer kills the poller thread when backgrounded, the foreground service
  // that would prevent that is blocked by tauri#11609/archive#15671, and native Rust
  // cannot resolve DNS there at all). Calling it today would fail every poll
  // and log an error on every launch.
  //
  // This is where it goes when it is switched on: an effect that starts the
  // watch from `platform/native/notify` with `apiBase` and the active
  // credential, guarded on `profile.isTauri`, stopping it on cleanup.
  //
  // One trap worth keeping: read the credential during *render*, not inside
  // the effect. `credentialProvider` keeps a stable identity across a pairing
  // completing, so depending on the provider rather than the value it returns
  // leaves the watch unstarted until something unrelated re-runs the effect.
  //
  // (Written prose rather than commented-out code on purpose — the dormancy
  // guard in native-notification-watch.test.ts greps for the call.)

  // Install the process-wide SDK boundary before any descendant layout effect
  // can start a connection-health probe. A parent layout effect runs after its
  // children's layout effects, which let the first native request escape to
  // raw fetch and terminal-stop on 401 even though the keyring was healthy.
  useInsertionEffect(() => {
    setClientCredentialResolver(() => {
      // The resolver body runs when a request is ABOUT TO BE ISSUED, so this
      // ONE live read is the connection, address, credential and generation
      // that request is actually authenticated against. `activeConnection` and
      // `apiBase` are render captures and are the wrong subject for a result
      // that arrives later — and mixing a live credential with a rendered
      // address would leave a window, between a synchronous connection switch
      // and React committing it, where one connection's credential is sent to
      // another's origin.
      const evidence = captureCredentialEvidence();
      const credential = profile.isTauri ? undefined : evidence?.credential;
      const nativeBinding =
        profile.isTauri && evidence
          ? nativeProfileRepository().captureNativeRequestBinding(
              evidence.connectionId,
              evidence.origin,
            )
          : null;
      const nativeBindingIsCurrent = () =>
        Boolean(
          evidence &&
            nativeBinding &&
            nativeProfileRepository().captureNativeRequestBinding(
              evidence.connectionId,
              evidence.origin,
            )?.bindingId === nativeBinding.bindingId,
        );
      const requestAuthority = evidence
        ? !profile.isTauri || nativeBinding
          ? {
              ...requestAuthorityScopeFromCredentialEvidence(evidence, {
                ...(nativeBinding
                  ? { authorityQualifier: nativeBinding.bindingId }
                  : {}),
              }),
              isCurrent: () =>
                isCredentialEvidenceCurrent(evidence) &&
                (!profile.isTauri || nativeBindingIsCurrent()),
            }
          : undefined
        : undefined;
      return {
        credential,
        origin: evidence?.origin ?? apiBase,
        // The host-supplied `managed-loopback` connection and every saved
        // desktop connection use native authenticated transport so bearer
        // credentials remain host-owned.
        ...(profile.isTauri
          ? {
              transport: nativeBinding
                ? nativeTransportForBinding(nativeBinding.bindingId)
                : lazyNativeAuthenticatedTransport,
            }
          : {}),
        ...(requestAuthority ? { requestAuthority } : {}),
        ...(profile.isTauri && nativeBinding
          ? { transportBindingIsCurrent: nativeBindingIsCurrent }
          : {}),
        // Reported against the evidence captured ABOVE, at request issue —
        // the SDK no longer re-resolves at response time. Without that, a 401
        // from a request that left before a pairing completed came back bound
        // to the NEW credential and deleted it; for a device session both
        // values are `undefined`, so only the generation can tell them apart.
        // Returns the transition so the SDK can resolve the response after it
        // (archive#3601/archive#3602). On a page with Web Locks the store
        // applies this inside a lock callback; without the hand-back, code
        // that awaited the request could read the state the 401 replaced.
        onUnauthorized: () =>
          evidence
            ? markCredentialRequired(
                evidence.connectionId,
                evidence.credential,
                evidence.generation,
              )
            : undefined,
        // A previous request's failure is evidence, not a local authority to
        // reject a new write. Let the Station answer the attempt; an accepted
        // authenticated response then retires that stale evidence — BOTH
        // halves of it: `lastError`, and the `credentialState: 'required'`
        // that `onUnauthorized` above set and that actually renders the
        // "Request access to reconnect" banner.
        //
        // The acceptance is reported with the generation captured above and
        // the URL the Station actually accepted, and the store drops it if
        // either has been overtaken — a slow 2xx cannot erase a 401 recorded
        // after it left, and a 2xx from an address the connection no longer
        // points at cannot recover the new one. The staleness question itself
        // is answered inside the store from CURRENT state, so reading a
        // render-captured `activeConnection.lastError` here (which would skip
        // the recovery whenever the failure was recorded after this closure
        // was installed — the normal cold-boot ordering) is not needed either.
        onAuthenticated: (url) =>
          evidence
            ? recordAuthenticatedSuccess(
                evidence.connectionId,
                url,
                evidence.generation,
              )
            : undefined,
      };
    });
    setNativePairingExchangeTransport(
      profile.isTauri ? lazyNativePairingExchangeTransport : undefined,
    );
    return () => {
      setClientCredentialResolver(undefined);
      setNativePairingExchangeTransport(undefined);
    };
  }, [
    apiBase,
    captureCredentialEvidence,
    isCredentialEvidenceCurrent,
    markCredentialRequired,
    profile.isTauri,
    recordAuthenticatedSuccess,
  ]);

  // archive#1094 (closing the SSE-stream half of the hot-loop-on-401 fix):
  // wake every `fetchSSE` stream currently blocked on a terminal auth
  // failure once the SAME connection's credential regains authority —
  // mirrors `@kontourai/station-connect`'s `useConnectionStatus` equivalent
  // wake for the health-poll path (already shipped).
  // Keyed on the connection id too, so switching to a different connection (a
  // legitimately different credential) does not spuriously fire this.
  //
  // archive#3602: this used to compare the saved credential VALUE, which a
  // browser device session never changes — `undefined` before pairing and
  // `undefined` after — so a terminally parked stream stayed parked through
  // the re-pairing that was supposed to release it. The authority generation
  // counts the connection GAINING a credential able to authenticate it, which
  // is the fact a parked stream is waiting for; it is also why this no longer
  // excludes native shells, where the value is host-owned and never readable
  // here at all (`commitVerifiedPairing` already notifies for its own path,
  // and a duplicate wake only re-runs a stream that is genuinely blocked).
  const connectionId = activeConnection?.id;
  const authority = connectionId
    ? credentialAuthorityGeneration(connectionId)
    : 0;
  const previousAuthorityRef = useRef<{
    connectionId: string | undefined;
    authority: number;
  }>({ connectionId, authority });
  useEffect(() => {
    const previous = previousAuthorityRef.current;
    previousAuthorityRef.current = { connectionId, authority };
    if (
      previous.connectionId === connectionId &&
      previous.authority !== authority
    ) {
      notifyCredentialChanged(apiBase);
    }
  }, [connectionId, authority, apiBase]);

  return children;
}

export function useApiBase() {
  const {
    apiBase,
    setApiBase,
    resetToDefault,
    isCustom,
    activeConnection,
    credentialProvider,
    markCredentialRequired,
  } = useConnections();
  return {
    apiBase,
    setApiBase,
    resetToDefault,
    isCustom,
    credentialState: activeConnection?.credentialState,
    credentialProvider,
    markCredentialRequired: (rejectedCredential?: string) => {
      if (activeConnection) {
        markCredentialRequired(activeConnection.id, rejectedCredential);
      }
    },
  };
}

/**
 * Captures the authority that owns a host request at render time. Consumers
 * must retain this capture for the lifetime of the work they start: resolving
 * a fresh connection in a late callback could otherwise let an old stream
 * mutate the new connection's cache.
 */
export function useHostRequestAuthorityScope() {
  const { captureCredentialEvidence, isCredentialEvidenceCurrent } =
    useConnections();
  const profile = usePlatformProfile();
  const evidence = captureCredentialEvidence();
  const nativeBinding =
    profile.isTauri && evidence
      ? nativeProfileRepository().captureNativeRequestBinding(
          evidence.connectionId,
          evidence.origin,
        )
      : null;

  // `captureCredentialEvidence` and the native repository intentionally
  // return snapshots.  Their object identities are therefore not an authority
  // change: using them as memo dependencies would replace every subscriber on
  // each ordinary render.  Retain the lexical snapshot until one of its
  // public authority facts changes, so late work remains bound to the
  // authority it captured rather than adopting a newer one.
  const authorityApiBase = evidence?.origin;
  const connectionId = evidence?.connectionId;
  const activationEpoch = evidence?.activationEpoch;
  const authorityGeneration = evidence?.authorityGeneration;
  const credentialState = evidence?.credentialState;
  const nativeBindingId = nativeBinding?.bindingId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: snapshot allocation is intentionally excluded; this hook's authority identity is the primitive tuple below.
  return useMemo(() => {
    if (!evidence || (profile.isTauri && !nativeBinding)) return undefined;
    return {
      ...requestAuthorityScopeFromCredentialEvidence(evidence, {
        ...(nativeBinding
          ? { authorityQualifier: nativeBinding.bindingId }
          : {}),
      }),
      isCurrent: () =>
        isCredentialEvidenceCurrent(evidence) &&
        (!profile.isTauri ||
          nativeProfileRepository().captureNativeRequestBinding(
            evidence.connectionId,
            evidence.origin,
          )?.bindingId === nativeBinding?.bindingId),
    };
  }, [
    activationEpoch,
    authorityApiBase,
    authorityGeneration,
    connectionId,
    credentialState,
    nativeBindingId,
    profile.isTauri,
  ]);
}
