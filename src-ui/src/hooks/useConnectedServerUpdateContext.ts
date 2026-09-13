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
  selectionClaimsNativeOwner,
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
  /**
   * True once the current scope's identity request SETTLED — success OR
   * error. It answers "correlation has stopped waiting", never "the server
   * answered": enablement decisions must read `identityReady`, not this.
   */
  identitySettled: boolean;
  /**
   * True only when the current scope's identity request SUCCEEDED. This is
   * the fail-closed enablement input: an identity error leaves the card in
   * the honest unresolved state with the source check off.
   */
  identityReady: boolean;
  /**
   * A desktop shell supervising a bundled server has not received its first
   * native observation yet. Identity can outrun the async native snapshot,
   * so any source-check enablement must hold until this clears — a
   * subscription that never delivers keeps the check off, deliberately.
   */
  nativeObservationPending: boolean;
  /**
   * The selected connection CLAIMS the observed native owner (matching
   * instance ids on both sides) but the correlation could not establish it —
   * kind is unresolved while an owner claim is in force: an observed but
   * not-yet-running sidecar, a wrong boot, a mismatched endpoint. The source
   * check holds while this is true; firing it would probe a server the
   * correlation cannot name. Truth table of the hold:
   * - claims owner + unresolved → held (this flag);
   * - no owner claim (paired/remote) → never held by this flag, enabled or
   *   held by the other inputs only;
   * - established kinds (embedded-sidecar / installed-local-service) → not
   *   unresolved, never held.
   */
  claimedOwnerUnresolved: boolean;
  /** True only while the captured selection and native binding remain current. */
  isCurrent: () => boolean;
}

export interface UseConnectedServerUpdateContextOptions {
  /**
   * When false, no identity request is issued at all. Launch checks on
   * shells without desktop native ownership pass false; Settings, which
   * renders identity wherever it appears, keeps the default (enabled).
   */
  identityEnabled?: boolean;
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
export function useConnectedServerUpdateContext(
  options: UseConnectedServerUpdateContextOptions = {},
): ConnectedServerUpdateContext {
  const identityEnabled = options.identityEnabled ?? true;
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
    enabled:
      identityEnabled && scopeKey !== null && reachability === 'connected',
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
      // The request goes to the origin captured WITH this evidence, so the
      // wire request and the authority it is checked against share one
      // capture — never a render-captured base beside a fresh one.
      const identity = await requestSystemIdentity(
        issuedEvidence.origin,
        signal,
      );
      // Defense-in-depth post-check (plan correlation step 5). In the current
      // composition this guard is unreachable-as-stale: every evidence field
      // it re-evaluates — connectionId, activation epoch, authority
      // generation, origin and native binding — is part of scopeKey, so any
      // staleness flips the key and the scope-change effect cancels and
      // removes the entry before a settle could land. The one currency input
      // outside the tuple is credentialState, and that divergence is
      // independently rejected at settle time by the SDK transport's
      // request-authority boundary before this line could decide anything —
      // so no current fixture can drive THIS check stale without omitting a
      // field from the scope tuple, which would weaken the A→B→A isolation
      // the key exists to provide. Accepted gap: untested as a distinct
      // behavior; kept so the correlation layer stays correct if scopeKey and
      // evidence evaluation ever diverge (e.g. a future scope field not
      // derived from the evidence tuple). (Verifier finding, 2026-09-13.)
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
  const identityReady = identityQuery.isSuccess;
  // A supervising desktop can answer identity before the async native
  // snapshot lands; until an observation exists the correlation must not
  // hand the source check to a server it cannot yet name.
  const nativeObservationPending =
    profile.isDesktop &&
    profile.supervisesBundledServer &&
    nativeStatus === null;

  const selection = activeConnection
    ? {
        ownerId: activeConnection.ownerId,
        sshForward: activeConnection.sshForward,
        selectedAccessIsDirectHttp:
          selectedAccessIsDirectHttp(activeConnection),
      }
    : null;

  const kind = resolveEstablishedServerKind({
    scopeCurrent,
    nativeBindingCurrent,
    reachability,
    identity,
    isDesktop: profile.isDesktop,
    nativeStatus,
    apiBase,
    selection,
  });

  // R2 hold: the selection claims the observed native owner but correlation
  // left it unresolved — the source check must not fire at a server the
  // correlation cannot name.
  const claimedOwnerUnresolved =
    kind === 'unresolved' &&
    selectionClaimsNativeOwner(selection, nativeStatus);

  return {
    scopeKey,
    apiBase,
    connectionName: activeConnection?.name ?? null,
    reachability,
    kind,
    identity,
    identitySettled,
    identityReady,
    nativeObservationPending,
    claimedOwnerUnresolved,
    isCurrent,
  };
}
