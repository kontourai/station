/**
 * GuidedConnect — the first-run welcome a mobile Station device shows before it
 * has a real saved host. It is a full-screen welcome (not an error), so it rides
 * the recorded FullScreen* exception to the state-primitives rule rather than
 * the Empty primitive: there is nothing missing to report, only a first
 * connection to make. Each action opens the shared ConnectionManagerModal on the
 * matching panel.
 */

import { ConnectionManagerModal } from '@kontourai/station-connect';
import { pairingDeepLinkScheme } from '@kontourai/station-connect/pairing-deep-link';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { lazy, Suspense, useCallback, useState } from 'react';
import { useCoarsePointer } from '../hooks/useCoarsePointer';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePairingDeepLink } from '../hooks/usePairingDeepLink';
import { checkHostCompatibility } from '../lib/compatibilityLoader';
import { checkServerHealthDetailed } from '../lib/serverHealth';
import { hasLocalStationForProfile } from '../platform/client-origin-surface';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { Button } from './Button';
import { SkeletonBlock } from './state';
import './GuidedConnect.css';
import { triggerHaptic } from '../platform/native/haptics';
import { reconnectLocalService } from '../platform/native/localServiceReconnect';

type GuidedConnectPanel = 'pair-device' | 'request-access' | 'add';

const BrowserRelayRoutes = lazy(async () => {
  const module = await import('../views/connections-hub/BrowserRelayRoutes');
  return { default: module.BrowserRelayRoutes };
});
const RelayRouteProfiles = lazy(async () => {
  const module = await import('../views/connections-hub/RelayRouteProfiles');
  return { default: module.RelayRouteProfiles };
});

interface GuidedConnectProps {
  /** Called after a pairing exchange has committed a usable browser session. */
  onSessionEstablished?: () => void;
  /**
   * archive#2652 / archive#1772: open the unpaired sample workspace so a reviewer
   * can take the receipts tour without a Station host.
   */
  onExploreSample?: () => void;
  /** Hold the pre-session screen while a relay Device ceremony joins Projects. */
  onRelayOnboardingChange?: (open: boolean) => void;
  /**
   * Why this browser landed here (e.g. a used or replaced sign-in link).
   * Rendered inside the screen: it is a full-viewport layer, so anything the
   * gate renders beside it is covered (#2612).
   */
  notice?: string;
}

export function GuidedConnect({
  onSessionEstablished,
  onExploreSample,
  onRelayOnboardingChange,
  notice,
}: GuidedConnectProps) {
  const [openPanel, setOpenPanel] = useState<GuidedConnectPanel | null>(null);
  const [brokerOpen, setBrokerOpen] = useState(false);
  const [pairingPayload, setPairingPayload] = useState<string>();
  const [pairingError, setPairingError] = useState<string>();
  const openBrowserInvitation = useCallback((payload: string) => {
    setPairingPayload(payload);
    setPairingError(undefined);
    setOpenPanel('pair-device');
  }, []);
  usePairingDeepLink({
    enabled: false,
    onPairingPayload: openBrowserInvitation,
    onError: setPairingError,
  });
  const profile = usePlatformProfile();
  const compact = useIsMobile();
  const coarse = useCoarsePointer();
  const phone = profile.isMobile || (!profile.isTauri && compact && coarse);
  const [needsStation, setNeedsStation] = useState(false);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(
    window.location.hostname,
  );
  const destination = window.location.host;
  // A web page cannot reliably enumerate installed desktop apps. Open the
  // production app's own workspace without guessing a channel or local port.
  const browserHandoff = `${pairingDeepLinkScheme('stable')}://open-browser`;

  return (
    <div className="guided-connect">
      <div className="guided-connect__inner">
        <img src="/favicon.png" alt="" className="guided-connect__logo" />
        <h1 className="guided-connect__title">
          {phone ? 'Connect your phone' : 'Connect to a Station'}
        </h1>
        <p className="guided-connect__description">
          {phone
            ? 'Use the AI and files on your computer.'
            : 'Choose the computer where you want to work.'}
        </p>
        {(notice || pairingError) && (
          <p role="alert" className="guided-connect__notice">
            {pairingError ?? notice}
          </p>
        )}
        {!profile.isTauri && !phone && (
          <section
            className="guided-connect__destination"
            aria-label="Current Station"
          >
            <h2>{isLocal ? 'On this computer' : 'At this address'}</h2>
            <code>{destination}</code>
            <p>
              {isLocal
                ? 'Connect your browser through the Station app.'
                : 'Ask this Station to approve access for your browser. Confirm the request on the computer running it.'}
            </p>
            {isLocal && (
              <>
                <a
                  className="guided-connect__action guided-connect__action--primary"
                  href={browserHandoff}
                >
                  Open in the Station app
                </a>
                <small>
                  Don't have the app?{' '}
                  <a
                    href="https://station.kontourai.io/#start"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Get Station
                  </a>
                </small>
              </>
            )}
            <button
              type="button"
              className={
                isLocal
                  ? 'guided-connect__action'
                  : 'guided-connect__action guided-connect__action--primary'
              }
              onClick={() => setOpenPanel('request-access')}
            >
              Request access
            </button>
          </section>
        )}
        <section
          className="guided-connect__destination"
          aria-label="Another Station"
        >
          {!phone && <h2>On another computer</h2>}
          <p>
            {phone
              ? 'On your computer, open Station → Pair phone. Keep it running.'
              : 'Use a pairing code from the Station running on that computer.'}
          </p>
          <Button
            variant="primary"
            className="guided-connect__action guided-connect__action--primary"
            onClick={() => setOpenPanel('pair-device')}
          >
            Pair with a code
          </Button>
          {phone && !profile.isTauri && !isLocal && (
            <Button
              className="guided-connect__action"
              onClick={() => setOpenPanel('request-access')}
            >
              Request access to this Station
            </Button>
          )}
        </section>
        {phone && (
          <section className="guided-connect__setup">
            <Button
              variant="ghost"
              aria-expanded={needsStation}
              onClick={() => setNeedsStation((value) => !value)}
            >
              I haven’t set up a Station yet
            </Button>
            {needsStation && (
              <div>
                <p>
                  Install Station on a computer, then return with its pairing
                  code.
                </p>
                <a
                  href="https://station.kontourai.io/#start"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get Station for your computer
                </a>
              </div>
            )}
          </section>
        )}
        <details className="guided-connect__advanced">
          <summary>Other ways to connect</summary>
          <div className="guided-connect__alternatives">
            <Button
              className="guided-connect__action"
              onClick={() => setOpenPanel('add')}
            >
              Enter a host address
            </Button>
            {(profile.isTauri || (phone && isLocal)) && (
              <Button
                className="guided-connect__action"
                onClick={() => setOpenPanel('request-access')}
              >
                Request access
              </Button>
            )}
            <Button
              className="guided-connect__action"
              aria-expanded={brokerOpen}
              onClick={() => setBrokerOpen((current) => !current)}
            >
              {profile.isTauri
                ? 'Set up a broker route'
                : 'Use a broker invitation'}
            </Button>
          </div>
        </details>
        {brokerOpen && (
          <section
            className="guided-connect__broker"
            aria-label="Broker route setup"
          >
            <Suspense
              fallback={
                <SkeletonBlock count={1} label="Opening broker route setup" />
              }
            >
              {profile.isTauri ? (
                <RelayRouteProfiles />
              ) : (
                <BrowserRelayRoutes
                  onEnrollmentOpenChange={onRelayOnboardingChange}
                />
              )}
            </Suspense>
          </section>
        )}
        {onExploreSample && (
          <div className="guided-connect__footer">
            <span>Just looking around?</span>{' '}
            <button
              type="button"
              className="guided-connect__tour"
              onClick={onExploreSample}
            >
              See how Station works
            </button>
            <p>Explore a sample workspace. No connection required.</p>
          </div>
        )}
      </div>
      <ConnectionManagerModal
        isOpen={openPanel !== null}
        onClose={() => setOpenPanel(null)}
        checkHealth={checkServerHealthDetailed}
        checkCompatibility={checkHostCompatibility}
        initialPanel={openPanel ?? undefined}
        initialPairingPayload={pairingPayload}
        pairingLinkError={pairingError}
        onPairingReviewDismissed={() => setPairingPayload(undefined)}
        originIsStation={!profile.isTauri}
        hasLocalStation={hasLocalStationForProfile(profile)}
        hostAppName={
          profile.isTauri ? profile.productName || 'Station' : undefined
        }
        allowManualCredentials={!profile.isDesktop}
        authenticatedRequest={
          profile.isDesktop ? authenticatedFetch : undefined
        }
        onReconnectLocalService={
          profile.isDesktop ? reconnectLocalService : undefined
        }
        onPairingSucceeded={() => {
          triggerHaptic('success');
          onSessionEstablished?.();
        }}
      />
    </div>
  );
}
