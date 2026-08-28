/**
 * OnboardingGate keeps the shell available when a Station endpoint is
 * unavailable. ConnectionBannerSource owns reachability disclosure while this
 * component retains only true pre-shell onboarding and local-service gates.
 */

import {
  attemptLocalSelfProvisionOnce,
  ConnectionManagerModal,
  clearPendingExchange,
  connectionFailureCopy,
  loadPendingExchange,
  type PendingPairingExchange,
  retryLocalSelfProvisionAfterRejection,
  useConnections,
} from '@kontourai/station-connect';
import { pairingStateCopy } from '@kontourai/station-contracts/pairing-copy';
import {
  authenticatedFetch,
  useForceRefetchSystemStatus,
} from '@kontourai/station-sdk';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getPathForView } from '../app-shell/routing';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';
import { useConfig } from '../contexts/ConfigContext';
import { useNavigation } from '../contexts/NavigationContext';
import {
  shouldRenderSetupLauncher,
  shouldRenderUsageTelemetryDisclosure,
  useFirstRunChapterOpen,
  useOnboardingSetupState,
} from '../contexts/onboarding-setup-store';
import { useToast } from '../contexts/ToastContext';
import { useInvalidateCachesOnConnectionSwitch } from '../hooks/useInvalidateCachesOnConnectionSwitch';
import { usePairingDeepLink } from '../hooks/usePairingDeepLink';
import { useSystemStatus } from '../hooks/useSystemStatus';
import { checkHostCompatibility } from '../lib/compatibilityLoader';
import {
  consumePendingConnectionsModal,
  OPEN_CONNECTIONS_MODAL_EVENT,
  type OpenConnectionsModalDetail,
} from '../lib/connectionModalEvents';
import { hasRealSavedConnection } from '../lib/saved-connections';
import { checkServerHealthDetailed } from '../lib/serverHealth';
import { invokeTauri } from '../platform/native/tauriInvoke';
import {
  nativeProfileBootstrapRecoveryError,
  nativeProfileRepository,
  usePlatformProfile,
} from '../platform/PlatformProfileContext';
import {
  restartBundledServer,
  useBundledServerStatus,
} from '../platform/useBundledServerStatus';
import { Button } from './Button';
import { buildSetupBannerContent } from './onboardingGateUtils';
import './OnboardingGate.css';
import { triggerHaptic } from '../platform/native/haptics';
import { LazyBoundary } from './LazyBoundary';
import { UsageTelemetryDisclosure } from './UsageTelemetryDisclosure';

type ConnectionModalMode =
  | 'list'
  | 'pair-device'
  | 'request-access'
  | 'devices';

const PAIRING_APPROVAL_BANNER_ID = 'chrome:onboarding:pairing-approval';
/**
 * Module-scope loaders (archive#2605 keeps these out of render), handed to
 * `LazyBoundary` rather than `lazy` directly: a rejected import is cached
 * by React forever, so an unguarded chunk 404 — which every `station upgrade`
 * can produce by rebuilding `dist-ui` under an open tab — blanks the whole
 * app shell from here (archive#2773).
 */
const loadPendingPairingReconciler = () =>
  import('./PendingPairingReconciler').then((module) => ({
    default: module.PendingPairingReconciler,
  }));
const loadMobileConnectionBanner = () =>
  import('./MobileConnectionBanner').then((module) => ({
    default: module.MobileConnectionBanner,
  }));
const loadBundledServiceBanner = () =>
  import('./BundledServiceBanner').then((module) => ({
    default: module.BundledServiceBanner,
  }));

export function OnboardingGate({ children }: { children: ReactNode }) {
  const { refetch } = useSystemStatus();
  const { apiBase, activeConnection, connections } = useConnections();
  // archive#1290: every server-scoped query cache (agents, model
  // connections, sessions,...) keeps serving the previous server's data
  // after a switch unless it's explicitly invalidated here — OnboardingGate
  // is the one place mounted at the app root, above the connected/
  // disconnected branch below, that observes every apiBase change regardless
  // of current connection status. `activeConnection != null` lets the hook
  // tell initial connection establishment (boot) apart from a real switch —
  // see the hook's doc comment for why that specific signal, read from the
  // same context snapshot as `apiBase`, is what closes the native
  // two-stage-boot false positive.
  const activeConnectionScope = activeConnection
    ? [
        activeConnection.id,
        activeConnection.credentialRef?.kind ?? '',
        activeConnection.credentialRef?.id ?? '',
        activeConnection.environmentId ?? '',
        activeConnection.credentialState,
        activeConnection.lastError?.reason ?? '',
      ].join(':')
    : null;
  useInvalidateCachesOnConnectionSwitch(
    apiBase,
    activeConnection != null,
    activeConnectionScope,
  );
  const forceRefetch = useForceRefetchSystemStatus(apiBase);
  const profile = usePlatformProfile();
  const bundledStatus = useBundledServerStatus(profile.supervisesBundledServer);
  const { navigate, pathname } = useNavigation();
  const { showToast } = useToast();
  const bootstrapRecoveryError = nativeProfileBootstrapRecoveryError();
  const [showModal, setShowModal] = useState(false);
  const [connectionModalMode, setConnectionModalMode] =
    useState<ConnectionModalMode>('list');
  const [pairingPayload, setPairingPayload] = useState<string | undefined>();
  const [pendingExchange, setPendingExchange] =
    useState<PendingPairingExchange | null>(null);
  const [waitingForTransport, setWaitingForTransport] = useState(false);
  const [ignoredPendingRequestId, setIgnoredPendingRequestId] = useState<
    string | null
  >(null);
  // archive#3387: the terminal outcome of a pairing attempt, held as state so
  // exactly one thing decides both whether its banner is presented and whether
  // the two banners it supersedes stay suppressed.
  //
  // It carries the Station the REQUEST was for, taken from the exchange's own
  // `targetConnectionId` — not whichever Station happened to be active when the
  // answer arrived. Requesting access never activates its target: the list row's
  // handler stops propagation precisely so the row is not selected
  // (`ConnectionListPanel`), and the deep-link path find-or-ADDS a connection
  // without activating it (`resolvePendingTarget`). So "the active one" is
  // routinely the wrong subject, and a decline attributed to the wrong Station
  // is the defect archive#3387 exists to close, one route over.
  const [pairingFailure, setPairingFailure] = useState<{
    connectionId: string;
    connectionLabel: string;
    title: string;
    message: string;
  } | null>(null);
  const {
    visible: setupBannerVisible,
    content: setupBannerContent,
    dismiss,
    defer: deferSetupBanner,
    rearm: rearmSetupBanner,
  } = useOnboardingSetupState();
  const firstRunChapterOpen = useFirstRunChapterOpen();
  const config = useConfig();
  const wasInConnections = useRef(pathname.startsWith('/connections'));
  const credentialRequired = activeConnection?.credentialState === 'required';
  const connectionEvidence = `${activeConnection?.id ?? ''}:${activeConnection?.lastSuccessAt ?? ''}:${activeConnection?.credentialState ?? ''}`;
  const previousConnectionEvidence = useRef(connectionEvidence);
  // archive#1007: the pairing banner is dismissible, but the dismissal is keyed to the
  // exact connection evidence it was shown for and lives only in component
  // state. Deliberately not persisted: "this host needs pairing" is an
  // unresolved, actionable state, and a relaunch is the natural moment to ask
  // again — the same reasoning archive#794 used to prefer a page-lifetime `defer` over
  // a durable `dismiss` for an unfinished setup. Because the key is the
  // evidence string, selecting another connection or a change in credential
  // state re-arms the banner on its own, with no effect and no cleanup.
  const [dismissedCredentialNotice, setDismissedCredentialNotice] = useState<
    string | null
  >(null);
  // A decline is never withheld — a silent refusal is the original archive#3387
  // defect — and it always takes the band's single visible slot, because both
  // banners sit in `connectionBlocking` where the stack shows one and collapses
  // the rest, and the id tie-break would otherwise bury the decline behind
  // `chrome:onboarding:credential`. That is the exact shape archive#3387 fixed.
  //
  // DISCLOSED TRADEOFF: while a decline stands for ANY Station, the active
  // Station's own "request access to reconnect" reminder is suppressed even
  // when they are different Stations. The reminder is a standing prompt; the
  // decline is a terminal answer to something the user just did, and its
  // "Request access again" action opens the connection list, from which the
  // active Station is one tap away. It clears as soon as the declined Station
  // is re-paired or forgotten.
  //
  // What this flag decides is only whether the copy has to say WHOSE answer it
  // is: an unattributed decline reads as being about the Station in front of
  // the reader, which is a lie whenever that is a different one. The shared
  // map's `declined-device` entry names it (archive#3849) — this flag decides
  // whether the banner ALSO carries the subject prefix.
  const pairingFailureIsForActiveConnection =
    pairingFailure != null &&
    pairingFailure.connectionId === activeConnection?.id;

  // Retire it from its SUBJECT's state, not from whatever is active. A decline
  // stops describing anything once that Station no longer needs access — it
  // was re-paired, or it was forgotten. Reading the active connection instead
  // would both miss that (when the subject is not active) and wrongly discard
  // a decline the moment the user selects the Station it is about.
  const pairingFailureSubjectResolved = pairingFailure
    ? (connections ?? []).find(
        (connection) => connection.id === pairingFailure.connectionId,
      )
    : undefined;
  // Prefer what the Station is called NOW. The recorded label is what it was
  // called when the request was made, which a rename since would make stale.
  const pairingFailureSubjectName =
    pairingFailureSubjectResolved?.name ||
    pairingFailure?.connectionLabel ||
    '';
  const pairingFailureIsStale =
    pairingFailure != null &&
    pairingFailureSubjectResolved?.credentialState !== 'required';
  useEffect(() => {
    if (pairingFailureIsStale) setPairingFailure(null);
  }, [pairingFailureIsStale]);
  const credentialNoticeDismissed =
    dismissedCredentialNotice === connectionEvidence;

  // The native bootstrap has already completed its one bounded recovery
  // attempt. If its replacement credential could not be written, this is not
  // a network failure and retrying the generic connection UI cannot repair
  // it; surface the keychain action exactly once when the shell becomes
  // available.
  const reportedBootstrapRecoveryError = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      !profile.isDesktop ||
      !bootstrapRecoveryError ||
      reportedBootstrapRecoveryError.current === bootstrapRecoveryError
    ) {
      return;
    }
    reportedBootstrapRecoveryError.current = bootstrapRecoveryError;
    showToast(bootstrapRecoveryError);
  }, [bootstrapRecoveryError, profile.isDesktop, showToast]);

  // archive#4475 — `restartBundledServer` reports whether the request even
  // REACHED the host (its own doc comment: "so the recovery screen can tell
  // the user when it didn't"), but both callers of it here used to discard
  // that boolean entirely (`void restartBundledServer;`) — the exact
  // "dead button" mechanism the owner hit on their phone: a dangling proxy
  // (tailscale serve → a port nothing owns) makes the restart POST fail,
  // and nothing on screen ever said so. Both the banner's "Restart Station"
  // action and the Stations sheet row's "Restart" button now go through
  // this, and it is `useCallback`-stable and self-referencing so the toast's
  // own "Try again" action can retry the exact same request.
  //
  // archive#4512: `duration: 0` — sticky until dismissed, the
  // same precedent `showToolApproval` already sets for a decision the
  // reader has to act on rather than merely notice ("No auto-dismiss for
  // approvals", `ToastContext.tsx`). A restart that could not even reach
  // the host is exactly that: a 5-second default would vanish this toast,
  // "Try again" and all, while the reader was still reading the FIRST
  // sentence of it — which is the same silence-on-failure defect one layer
  // up from the one this whole fix exists to close.
  const handleRestartBundledServer = useCallback(() => {
    void restartBundledServer().then((ok) => {
      if (ok) return;
      showToast(
        "Couldn't restart the local Station. Check the connection, then try again.",
        undefined,
        0,
        [{ label: 'Try again', onClick: () => handleRestartBundledServer() }],
      );
    });
  }, [showToast]);

  const openPairingPayload = useCallback((payload: string) => {
    setPairingPayload(payload);
    setConnectionModalMode('pair-device');
    setShowModal(true);
  }, []);
  const reportPairingLinkError = useCallback(
    (message: string) => showToast(message),
    [showToast],
  );
  usePairingDeepLink({
    enabled: profile.isTauri,
    clientChannel: profile.channel,
    devScheme: profile.pairingDeepLinkScheme,
    onPairingPayload: openPairingPayload,
    onError: reportPairingLinkError,
  });

  useEffect(() => {
    const showConnections = (detail?: OpenConnectionsModalDetail) => {
      // Anything unrecognized falls back to the list, which is the only
      // panel that is correct for every connection state.
      setConnectionModalMode(
        detail?.mode === 'pair-device' ||
          detail?.mode === 'request-access' ||
          detail?.mode === 'devices'
          ? detail.mode
          : 'list',
      );
      setShowModal(true);
    };
    const openConnections = (event: Event) => {
      consumePendingConnectionsModal();
      showConnections(
        event instanceof CustomEvent
          ? (event.detail as OpenConnectionsModalDetail | undefined)
          : undefined,
      );
    };
    window.addEventListener(OPEN_CONNECTIONS_MODAL_EVENT, openConnections);
    const pending = consumePendingConnectionsModal();
    if (pending) showConnections(pending);
    return () =>
      window.removeEventListener(OPEN_CONNECTIONS_MODAL_EVENT, openConnections);
  }, []);

  // The durable service can only request this one reviewed destination. Consume
  // it once and strip it immediately so refreshes do not repeatedly reopen UI.
  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get('station-connect') !==
      'devices'
    )
      return;
    const url = new URL(window.location.href);
    url.searchParams.delete('station-connect');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    setConnectionModalMode('devices');
    setShowModal(true);
  }, []);

  // A deferral covers the trip into Connections; leaving that area again ends
  // it, so an abandoned setup does not stay hidden for the whole session while
  // chat is still unready (archive#794).
  useEffect(() => {
    const isInConnections = pathname.startsWith('/connections');
    if (wasInConnections.current && !isInConnections) {
      void refetch().finally(rearmSetupBanner);
    }
    wasInConnections.current = isInConnections;
  }, [pathname, rearmSetupBanner, refetch]);

  useEffect(() => {
    if (previousConnectionEvidence.current === connectionEvidence) return;
    previousConnectionEvidence.current = connectionEvidence;
    if (activeConnection) {
      void refetch();
    }
  }, [activeConnection, connectionEvidence, refetch]);

  // archive#1876: a browser or Android pairing request has no native
  // transport state, so every health probe looks like a dead host until a
  // human approves it. Read the request persisted by the pairing flow and
  // disclose that real, bounded state above the generic offline strip.
  const restoredPendingExchange = useMemo(() => {
    const candidates = (connections ?? []).flatMap((connection) =>
      (['direct', 'code'] as const).map((requestKind) =>
        loadPendingExchange(connection.url, requestKind),
      ),
    );
    return (
      candidates.find(
        (candidate): candidate is PendingPairingExchange =>
          candidate !== null &&
          typeof candidate.targetConnectionId === 'string' &&
          typeof candidate.targetConnectionLabel === 'string' &&
          (connections ?? []).some(
            (connection) => connection.id === candidate.targetConnectionId,
          ),
      ) ?? null
    );
  }, [connections]);
  const effectivePendingExchange =
    pendingExchange ??
    (restoredPendingExchange?.requestId === ignoredPendingRequestId
      ? null
      : restoredPendingExchange);
  useEffect(() => {
    if (
      !pendingExchange &&
      restoredPendingExchange &&
      restoredPendingExchange.requestId !== ignoredPendingRequestId
    ) {
      setPendingExchange(restoredPendingExchange);
    }
  }, [ignoredPendingRequestId, pendingExchange, restoredPendingExchange]);
  const pendingApproval = useMemo(
    () =>
      effectivePendingExchange &&
      effectivePendingExchange.expiresAt > Date.now()
        ? {
            requestKind: effectivePendingExchange.requestKind,
            expiresAt: effectivePendingExchange.expiresAt,
            remainingMs: effectivePendingExchange.expiresAt - Date.now(),
          }
        : null,
    [effectivePendingExchange],
  );
  const serverLabel =
    effectivePendingExchange?.targetConnectionLabel ||
    activeConnection?.name ||
    apiBase;
  const pendingApprovalMessage = useMemo(() => {
    if (!pendingApproval) return null;
    // The shared pairing-state map (archive#3849). The waiting sentences said
    // "the host" — a noun docs/glossary.md forbids introducing, and the wrong
    // one twice over here, since the sentence before it had just named the
    // Station. Naming it again is what the map does.
    const waitMessage = waitingForTransport
      ? `Waiting to reach ${serverLabel} again. The access request is still open and will resume automatically.`
      : pairingStateCopy(
          pendingApproval.requestKind === 'code'
            ? 'waiting-for-code-approval'
            : 'waiting-for-approval',
          serverLabel,
        ).message;
    return `Preparing the connection to ${serverLabel}. ${waitMessage}`;
  }, [pendingApproval, serverLabel, waitingForTransport]);

  useEffect(() => {
    if (!pendingApprovalMessage) {
      bannerStore.dismiss(PAIRING_APPROVAL_BANNER_ID);
      return;
    }
    bannerStore.present({
      id: PAIRING_APPROVAL_BANNER_ID,
      priority: BANNER_PRIORITY.connectionBlocking,
      tone: 'info',
      ariaLive: 'polite',
      message: pendingApprovalMessage,
      actions: [
        {
          label: 'Cancel request',
          variant: 'secondary',
          onClick: () => {
            clearPendingExchange(
              effectivePendingExchange?.endpoint ??
                activeConnection?.url ??
                apiBase,
              pendingApproval?.requestKind ??
                effectivePendingExchange?.requestKind ??
                'direct',
            );
            setPendingExchange(null);
            setIgnoredPendingRequestId(
              effectivePendingExchange?.requestId ?? null,
            );
            setWaitingForTransport(false);
          },
        },
      ],
      dragRegion: true,
    });
    return () => {
      bannerStore.dismiss(PAIRING_APPROVAL_BANNER_ID);
    };
  }, [
    activeConnection?.url,
    apiBase,
    pendingApproval?.requestKind,
    pendingApprovalMessage,
    effectivePendingExchange?.endpoint,
    effectivePendingExchange?.requestId,
    effectivePendingExchange?.requestKind,
  ]);

  // archive#1958: credential pairing chrome → BannerHost under Header.
  // Plain reachability while the shell is up is ConnectionBannerSource
  // (same slot) — do not dual-mount a second reconnect strip.
  const credentialFailure =
    activeConnection?.lastError &&
    activeConnection.lastError.reason !== 'awaiting-approval'
      ? connectionFailureCopy(
          activeConnection.lastError.reason,
          serverLabel,
          activeConnection.url,
        )
      : null;
  // archive#3297: one line, with the remedy behind the banner's disclosure —
  // the same policy ConnectionBannerSource follows. This is the banner a phone
  // actually meets for a stale credential, and it was three lines of prose.
  const credentialMessage = credentialFailure
    ? credentialFailure.summary
    : `Request access to reconnect to ${serverLabel}.`;
  const credentialDetail = credentialFailure?.action;
  // A live approval request is the current credential recovery, so do not
  // stack an instruction to begin pairing again underneath it. A terminal
  // pairing failure is the same thing one step later — it carries its own
  // "Request access again" action — and it is not just redundant underneath:
  // both banners sit in the connectionBlocking band, where the stack shows one
  // front banner and collapses the rest, and `chrome:onboarding:credential`
  // wins that band's id tie-break over `chrome:onboarding:pairing-failure`
  // (archive#3387).
  const showCredentialChrome =
    !credentialNoticeDismissed &&
    credentialRequired &&
    !pendingApproval &&
    !pairingFailure;

  useEffect(() => {
    if (showCredentialChrome) {
      bannerStore.present({
        id: BANNER_IDS.credential,
        priority: BANNER_PRIORITY.connectionBlocking,
        tone: 'blocked',
        // The occurrence is the same evidence string the component's own
        // durable dismissal keys on: connection id + last success + credential
        // state. Without it the store suppressed on id alone, permanently —
        // a NEW credential incident on the same connection stayed hidden
        // behind an old dismissal (archive#2557 finding).
        occurrence: connectionEvidence,
        message: credentialMessage,
        detail: credentialDetail,
        dragRegion: true,
        dismissible: true,
        dismissAriaLabel: 'Dismiss pairing reminder',
        onDismiss: () => setDismissedCredentialNotice(connectionEvidence),
        actions: [
          {
            label: 'Request access',
            onClick: () => {
              setConnectionModalMode('list');
              setShowModal(true);
            },
            variant: 'secondary',
          },
        ],
      });
    } else {
      bannerStore.dismiss(BANNER_IDS.credential);
    }

    return () => {
      bannerStore.dismiss(BANNER_IDS.credential);
    };
  }, [
    showCredentialChrome,
    credentialMessage,
    credentialDetail,
    connectionEvidence,
  ]);

  useEffect(() => {
    if (!pairingFailure) {
      bannerStore.dismiss(BANNER_IDS.pairingFailure);
      return;
    }
    bannerStore.present({
      id: BANNER_IDS.pairingFailure,
      priority: BANNER_PRIORITY.connectionBlocking,
      tone: 'warning',
      badge: pairingFailure.title,
      // The copy says "this device" without naming a Station, which reads as
      // the Station in front of the reader. When that is a different one, say
      // whose answer this is rather than withhold it.
      message: pairingFailureIsForActiveConnection
        ? pairingFailure.message
        : `${pairingFailureSubjectName}: ${pairingFailure.message}`,
      actions: [
        {
          label: 'Request access again',
          onClick: () => {
            setPairingFailure(null);
            setConnectionModalMode('list');
            setShowModal(true);
          },
        },
      ],
    });
    return () => {
      bannerStore.dismiss(BANNER_IDS.pairingFailure);
    };
  }, [
    pairingFailure,
    pairingFailureIsForActiveConnection,
    pairingFailureSubjectName,
  ]);

  // Same-user local self-authorization (archive#1715, revised archive#1818
  //). The desktop shell's OWN local-service Station is the one case
  // where "needs a credential" is never a user problem to solve — the
  // native broker refuses every request until
  // `station_profile_authorize_active` has run at least once (see
  // `authorized_profile_for_origin` in `src-desktop/src/lib.rs`), and a
  // freshly installed local Station has no credential to authorize yet.
  // `pendingLocalSelfProvisionProfileName` answers `undefined` for every
  // saved Station shape except the process-selected Station with `localService` set — it
  // deliberately does NOT also check `credentialRef`/`configurationState`
  // (archive#1818: a stranded profile after a bundle-swap keychain ACL
  // mismatch has both set, exactly like a healthy one, and the webview
  // cannot read the keychain to tell the difference). This effect therefore
  // runs, and `station_local_self_provision` (the Rust command) decides
  // eligibility fresh every boot: it refuses instantly and harmlessly for an
  // already-working profile, and re-provisions for one whose credential
  // cannot actually be read back. One attempt per app boot (the imported
  // function's own module latch) either way; on success, re-read the shared
  // saved Station store the native command just wrote and force a genuinely new
  // status attempt so the app proceeds straight past the pairing screen it
  // would otherwise have shown.
  useEffect(() => {
    if (!profile.isDesktop) return;
    let cancelled = false;
    const pendingProfileName =
      nativeProfileRepository().pendingLocalSelfProvisionProfileName();
    if (!pendingProfileName) return;
    void attemptLocalSelfProvisionOnce({
      invoke: invokeTauri,
      profileName: pendingProfileName,
    }).then(async (provisioned) => {
      if (!provisioned || cancelled) return;
      await nativeProfileRepository().refresh();
      if (!cancelled) void forceRefetch();
    });
    return () => {
      cancelled = true;
    };
  }, [profile.isDesktop, forceRefetch]);

  // archive#1866: re-provisioning reachable from an authentication refusal.
  // The boot-time effect above deliberately does NOT fire when the credential
  // reads back as `Readable` — which proves only that the bytes are in the
  // keychain, not that the server will honour them. A server restart
  // invalidates the local grant while it stays perfectly readable, so the
  // app would strand with no recovery. When the transport observes a coded
  // auth rejection (`authentication-failed`) for the active local-service
  // profile, the native side records the rejection (401/403) and this effect
  // fires the one-shot rejection-retry — `retryLocalSelfProvisionAfterRejection`
  // has its OWN per-boot guard (independent of `attemptedThisBoot`) so a
  // genuinely-rejecting server cannot cause a mint loop.
  const observedAuthFailure =
    activeConnection?.lastError?.reason === 'authentication-failed';
  useEffect(() => {
    if (!profile.isDesktop || !observedAuthFailure) return;
    let cancelled = false;
    const pendingProfileName =
      nativeProfileRepository().pendingLocalSelfProvisionProfileName();
    if (!pendingProfileName) return;
    void retryLocalSelfProvisionAfterRejection({
      invoke: invokeTauri,
      profileName: pendingProfileName,
    }).then(async (reprovisioned) => {
      if (!reprovisioned || cancelled) return;
      await nativeProfileRepository().refresh();
      if (!cancelled) void forceRefetch();
    });
    return () => {
      cancelled = true;
    };
  }, [profile.isDesktop, observedAuthFailure, forceRefetch]);

  // `shouldRenderSetupLauncher` already requires non-null content; the
  // explicit `&& setupBannerContent` only exists so TypeScript narrows the
  // prop type here without a cast.
  const setupLauncherVisible =
    shouldRenderSetupLauncher({
      credentialRequired,
      setupVisible: setupBannerVisible,
      setupContent: setupBannerContent,
      pathname,
    }) && setupBannerContent;
  const connectedNotice: ReactNode = setupLauncherVisible ? (
    <SetupLauncher
      content={setupBannerContent}
      onOpenTarget={() => {
        // Going to Connections to *do* the setup is not evidence the setup
        // worked — defer for this page lifetime instead of recording a
        // permanent dismissal (archive#794).
        deferSetupBanner();
        navigate(
          setupBannerContent.actionTarget === 'providers'
            ? getPathForView({ type: 'connections-providers' })!
            : setupBannerContent.actionTarget === 'engine' &&
                setupBannerContent.engineConnectionId
              ? getPathForView({
                  type: 'connections-runtime-edit',
                  id: setupBannerContent.engineConnectionId,
                })!
              : getPathForView({ type: 'connections' })!,
        );
      }}
      onOpenHub={() => {
        deferSetupBanner();
        navigate(getPathForView({ type: 'connections' })!);
      }}
      onDismiss={dismiss}
    />
  ) : null;

  // THE THIRD OVERLAY, under the same one-at-a-time rule as the other two.
  // It is mounted after `{children}`, so wherever it renders it renders on
  // top: over the launcher (which is why the first-run E2E specs used to have
  // to answer it before they could click anything) and, on a fresh home, over
  // the first-run chapter. A `pending` home shows it as the chapter's first
  // step instead; nothing here changes for any other home.
  const usageTelemetryDisclosureMounted = shouldRenderUsageTelemetryDisclosure({
    firstRunStatus: config?.firstRun?.status,
    setupLauncherVisible: Boolean(setupLauncherVisible),
    firstRunChapterOpen,
  });

  // The shell is invariant across ready, loading, and local-service repair
  // states. Service lifecycle is disclosed in chrome, never by withholding
  // local, cached, settings, or connection-management affordances.
  return (
    <>
      {profile.supervisesBundledServer && (
        <LazyBoundary
          load={loadBundledServiceBanner}
          pending={null}
          componentProps={{
            status: bundledStatus,
            onRestart: handleRestartBundledServer,
            onOpenConnections: () => {
              setConnectionModalMode('list');
              setShowModal(true);
            },
          }}
        />
      )}
      {profile.isMobile && !hasRealSavedConnection(connections) && (
        <LazyBoundary
          load={loadMobileConnectionBanner}
          pending={null}
          componentProps={{
            onOpen: () => {
              setConnectionModalMode('list');
              setShowModal(true);
            },
          }}
        />
      )}
      {effectivePendingExchange && (
        <LazyBoundary
          load={loadPendingPairingReconciler}
          pending={null}
          componentProps={{
            pending: effectivePendingExchange,
            enabled: !showModal,
            onCompleted: () => {
              setPairingFailure(null);
              setPendingExchange(null);
              setIgnoredPendingRequestId(effectivePendingExchange.requestId);
              setWaitingForTransport(false);
              void refetch();
              triggerHaptic('success');
            },
            // archive#3387: the request is over, so retire the
            // waiting-for-approval claim as well as reporting the outcome.
            // Leaving the pending record live kept that banner presented, and
            // it wins the connectionBlocking band's id tie-break — a declined
            // phone went on reading that it was still waiting, with the
            // decline and its only remedy collapsed behind the stack cap.
            onTerminalFailure: (title: string, message: string) => {
              // The target is optional on the record's type. Every producer
              // sets it (`resolvePendingTarget`), and `restoredPendingExchange`
              // will not surface a record missing it — so the fallback is for a
              // shape neither path can currently produce, and it degrades to
              // the pre-review behaviour rather than dropping the decline.
              setPairingFailure({
                connectionId:
                  effectivePendingExchange.targetConnectionId ??
                  activeConnection?.id ??
                  '',
                connectionLabel:
                  effectivePendingExchange.targetConnectionLabel ||
                  activeConnection?.name ||
                  'That Station',
                title,
                message,
              });
              setPendingExchange(null);
              setIgnoredPendingRequestId(effectivePendingExchange.requestId);
              setWaitingForTransport(false);
            },
            onConnectionWaiting: () => setWaitingForTransport(true),
            onApprovalWaiting: () => setWaitingForTransport(false),
          }}
        />
      )}
      {connectedNotice}
      {children}
      {usageTelemetryDisclosureMounted ? (
        <UsageTelemetryDisclosure firstRun />
      ) : null}
      <ConnectionManagerModal
        isOpen={showModal}
        onClose={() => {
          setShowModal(false);
          setPairingPayload(undefined);
        }}
        checkHealth={checkServerHealthDetailed}
        checkCompatibility={checkHostCompatibility}
        initialPanel={connectionModalMode}
        initialPairingPayload={pairingPayload}
        originIsStation={!profile.isTauri}
        hostAppName={
          profile.isTauri ? profile.productName || 'Station' : undefined
        }
        allowManualCredentials={!profile.isDesktop}
        authenticatedRequest={
          profile.isDesktop ? authenticatedFetch : undefined
        }
        onRestartInjectedConnection={
          // Ownership, not just "this build supervises a bundled server".
          // The banner stopped offering a Restart it cannot honour; without
          // this the banner's ONLY remaining action routes the user to the
          // connection list, which renders the same dead Restart on a row
          // labelled "Not running" — the exact framing archive#3079 objected to.
          // Same predicate HeaderActions already uses.
          profile.supervisesBundledServer &&
          bundledStatus?.ownership === 'sidecar'
            ? handleRestartBundledServer
            : undefined
        }
        onPairingSucceeded={() => triggerHaptic('success')}
        onApprovalPending={(pending) => {
          setPairingFailure(null);
          setPendingExchange(pending);
          setIgnoredPendingRequestId(null);
          setWaitingForTransport(false);
          setPairingPayload(undefined);
          setShowModal(false);
        }}
      />
    </>
  );
}

/**
 * Owns the bounded exchange after the chooser has handed a submitted request
 * back to the shell. The proof stays in the narrowly-scoped pending record;
 * this component only resumes that exact record and clears it on every
 * terminal result. It deliberately does not queue offline work.
 */
function SetupLauncher({
  content,
  onOpenTarget,
  onOpenHub,
  onDismiss,
}: {
  content: ReturnType<typeof buildSetupBannerContent>;
  onOpenTarget: () => void;
  onOpenHub: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside
      className="onboarding-setup-launcher"
      data-testid="setup-launcher"
      aria-label="First-run setup reminder"
    >
      <div className="onboarding-setup-launcher__panel" role="status">
        <div className="onboarding-setup-launcher__eyebrow">First run</div>
        <div className="onboarding-setup-launcher__header">
          <div>
            <div className="onboarding-setup-launcher__title">
              {content.title}
            </div>
            <div className="onboarding-setup-launcher__description">
              {content.description}
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss setup launcher"
            onClick={onDismiss}
            className="onboarding-setup-launcher__dismiss"
          >
            ×
          </button>
        </div>

        {content.badges.length > 0 && (
          <div className="onboarding-setup-launcher__badges">
            {content.badges.map((badge) => (
              <span key={badge} className="onboarding-setup-launcher__badge">
                {badge}
              </span>
            ))}
          </div>
        )}

        {/*
          SHELL-02/SHELL-12: this card carried the app's fifth primary-button
          treatment — a hard-coded blue gradient (#3b82f6 -> #2563eb), outside
          the token system, on the one surface that follows the user from route
          to route. The audit saw an amber variant here; the colour had changed
          but the fork had not. It is the shared Button now; the launcher keeps
          only the full-width layout that is genuinely its own.
*/}
        <Button
          variant="primary"
          className="onboarding-setup-launcher__primary"
          onClick={onOpenTarget}
        >
          {content.actionLabel}
        </Button>
        <div className="onboarding-setup-launcher__actions">
          <Button variant="secondary" size="sm" onClick={onOpenHub}>
            View All Connections
          </Button>
          <Button variant="secondary" size="sm" onClick={onDismiss}>
            Continue Without Setup
          </Button>
        </div>
      </div>
    </aside>
  );
}
