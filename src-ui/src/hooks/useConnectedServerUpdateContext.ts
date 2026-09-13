import {
  useConnectionStatus,
  useConnections,
} from '@kontourai/station-connect';
import type { SystemIdentityResponse } from '@kontourai/station-contracts/system-status';
import { requestSystemIdentity } from '@kontourai/station-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { checkServerHealth, probeServerConnection } from '../lib/serverHealth';
import {
  nativeProfileRepository,
  usePlatformProfile,
} from '../platform/PlatformProfileContext';
import { useBundledServerStatus } from '../platform/useBundledServerStatus';
import {
  type EstablishedServerKind,
  resolveEstablishedServerKind,
  selectedAccessIsDirectHttp,
} from '../views/settings/serverUpdateIdentity';

export type ServerReachability = 'connected' | 'checking' | 'unavailable';

export interface ConnectedServerUpdateContext {
  /** Secret-free correlation scope; null when nothing is selected. */
  scopeKey: string | null;
  apiBase: string;
  connectionName: string | null;
  reachability: ServerReachability;
  kind: EstablishedServerKind;
  identity: SystemIdentityResponse | null;
  identitySettled: boolean;
  /** True only while the captured selection and native binding remain current. */
  isCurrent: () => boolean;
}

const IDENTITY_QUERY_ROOT = 'connected-server-identity';

/** Shares the shell's health-coordinator registry: no independent polling. */
const HEALTH_COMPOSITION = {
  checkHealth: checkServerHealth,
  probeEndpoint: probeServerConnection,
  pollInterval: 10_000,
} as const;

function supersededError(): Error {
  const error = new Error('Connected-server identity request was superseded');
  error.name = 'AbortError';
  return error;
}

function readNativeBindingId(
  isNativeShell: boolean,
  connectionId: string,
  origin: string,
): string | null {
  if (!isNativeShell) return null;
  return (
    nativeProfileRepository().captureNativeRequestBinding(connectionId, origin)
      ?.bindingId ?? null
  );
}

/**
 * The captured binding satisfies this connection's requirement: an injected
 * host-secret loopback needs no renderer binding (absent stays current), a
 * persisted connection must hold a live one.
 */
function bindingSatisfiesRequirement(
  currentBindingId: string | null,
  capturedBindingId: string | null,
  bindingRequired: boolean,
): boolean {
  return bindingRequired
    ? currentBindingId !== null && currentBindingId === capturedBindingId
    : currentBindingId === capturedBindingId;
}

/**
 * Correlate the currently selected connection with the desktop's native
 * owner and the answering server's authenticated identity.
 *
 * Composition only — every fact comes from an existing seam: Connect's
 * credential evidence and health coordinator, ApiBaseContext's injected
 * owner (consumed via `activeConnection.ownerId`, never re-derived), the
 * native profile repository's request-binding capture/check, and the
 * bundled-server status subscription. The query is keyed by a secret-free
 * scope tuple plus the observed server/native boot identity, so a superseded
 * selection can neither label nor repopulate another scope's cache.
 */
export function useConnectedServerUpdateContext(): ConnectedServerUpdateContext {
  const {
    apiBase,
    activeConnection,
    captureCredentialEvidence,
    isCredentialEvidenceCurrent,
  } = useConnections();
  const profile = usePlatformProfile();
  const isNativeShell = profile.isTauri;
  const nativeStatus = useBundledServerStatus(profile.supervisesBundledServer);
  const { status } = useConnectionStatus(HEALTH_COMPOSITION);

  // Render-time capture of the selected connection's public authority facts
  // (the same seams ApiBaseContext composes at the request boundary). The
  // evidence object has no stable identity; only the primitive tuple memoizes.
  const evidence = captureCredentialEvidence();
  const capturedBindingId = evidence
    ? readNativeBindingId(isNativeShell, evidence.connectionId, evidence.origin)
    : null;

  const evidenceConnectionId = evidence?.connectionId ?? null;
  const evidenceOrigin = evidence?.origin ?? null;
  const activationEpoch = evidence?.activationEpoch ?? null;
  const credentialGeneration = evidence?.generation ?? null;
  const authorityGeneration = evidence?.authorityGeneration ?? null;
  const bindingRequired =
    isNativeShell && Boolean(activeConnection && !activeConnection.injected);

  // Plan correlation step 2: connection ID, full API base, activation epoch,
  // credential generation, authority generation, native binding ID. No
  // credential or credential-evidence object ever enters this key.
  const scopeKey = useMemo(() => {
    if (
      evidenceConnectionId === null ||
      evidenceOrigin === null ||
      activationEpoch === null ||
      credentialGeneration === null ||
      authorityGeneration === null
    ) {
      return null;
    }
    return JSON.stringify([
      evidenceConnectionId,
      evidenceOrigin,
      activationEpoch,
      credentialGeneration,
      authorityGeneration,
      capturedBindingId,
    ]);
  }, [
    evidenceConnectionId,
    evidenceOrigin,
    activationEpoch,
    credentialGeneration,
    authorityGeneration,
    capturedBindingId,
  ]);

  const bindingIsCurrentFor = useCallback(
    (snapshotConnectionId: string, snapshotOrigin: string) =>
      bindingSatisfiesRequirement(
        readNativeBindingId(
          isNativeShell,
          snapshotConnectionId,
          snapshotOrigin,
        ),
        capturedBindingId,
        bindingRequired,
      ),
    [bindingRequired, capturedBindingId, isNativeShell],
  );

  const isCurrent = useCallback(() => {
    if (!evidence) return false;
    if (!isCredentialEvidenceCurrent(evidence)) return false;
    if (!isNativeShell) return true;
    return bindingIsCurrentFor(evidence.connectionId, evidence.origin);
  }, [
    bindingIsCurrentFor,
    evidence,
    isCredentialEvidenceCurrent,
    isNativeShell,
  ]);

  const scopeCurrent = isCurrent();
  const nativeBindingCurrent = Boolean(
    isNativeShell &&
      evidence !== null &&
      bindingIsCurrentFor(evidence.connectionId, evidence.origin),
  );

  const reachability: ServerReachability =
    status === 'connected'
      ? 'connected'
      : status === 'error' || status === 'idle'
        ? 'unavailable'
        : 'checking';

  const queryClient = useQueryClient();
  // Plan correlation step 4: the scope plus the observed server/native boot
  // identity. A server restart (new observed boot) refetches under a new key.
  const observedServerBootId = activeConnection?.lastBootId ?? null;
  const observedNativeBootId = nativeStatus?.bootId ?? null;

  const identityQuery = useQuery({
    queryKey: [
      IDENTITY_QUERY_ROOT,
      scopeKey ?? 'no-scope',
      observedServerBootId,
      observedNativeBootId,
    ],
    enabled: scopeKey !== null && reachability === 'connected',
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      // Plan correlation step 1/5: capture the evidence AT ISSUE, check the
      // captured authority before issuing and after it resolves. An obsolete
      // request rejects as cancellation and never settles into any cache the
      // new scope could read. The SDK transport's own request-authority check
      // remains the wire-level boundary; this is the correlation-level twin.
      const issuedEvidence = captureCredentialEvidence();
      if (!issuedEvidence || signal.aborted) throw supersededError();
      const issuedBindingId = readNativeBindingId(
        isNativeShell,
        issuedEvidence.connectionId,
        issuedEvidence.origin,
      );
      const issuedBindingRequired = bindingRequired;
      const issuedIsCurrent = () => {
        if (!isCredentialEvidenceCurrent(issuedEvidence)) return false;
        if (!isNativeShell) return true;
        return bindingSatisfiesRequirement(
          readNativeBindingId(
            isNativeShell,
            issuedEvidence.connectionId,
            issuedEvidence.origin,
          ),
          issuedBindingId,
          issuedBindingRequired,
        );
      };
      if (!issuedIsCurrent()) throw supersededError();
      const identity = await requestSystemIdentity(apiBase, signal);
      if (!issuedIsCurrent()) throw supersededError();
      return identity;
    },
  });

  // A superseded selection's in-flight identity request is cancelled and its
  // cache entry removed at the moment the scope changes: a late response can
  // neither label the new selection nor repopulate the old scope's cache.
  const previousScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const previousScope = previousScopeRef.current;
    previousScopeRef.current = scopeKey;
    if (previousScope !== null && previousScope !== scopeKey) {
      void queryClient
        .cancelQueries({ queryKey: [IDENTITY_QUERY_ROOT, previousScope] })
        .catch(() => undefined);
      queryClient.removeQueries({
        queryKey: [IDENTITY_QUERY_ROOT, previousScope],
      });
    }
  }, [queryClient, scopeKey]);

  const identity = identityQuery.data ?? null;
  const identitySettled = identityQuery.isSuccess || identityQuery.isError;

  const kind = resolveEstablishedServerKind({
    scopeCurrent,
    nativeBindingCurrent,
    reachability,
    identity,
    isDesktop: profile.isDesktop,
    nativeStatus,
    apiBase,
    selection: activeConnection
      ? {
          ownerId: activeConnection.ownerId,
          sshForward: activeConnection.sshForward,
          selectedAccessIsDirectHttp:
            selectedAccessIsDirectHttp(activeConnection),
        }
      : null,
  });

  return {
    scopeKey,
    apiBase,
    connectionName: activeConnection?.name ?? null,
    reachability,
    kind,
    identity,
    identitySettled,
    isCurrent,
  };
}
