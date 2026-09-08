/**
 * GuidedConnect — the first-run welcome a mobile Station device shows before it
 * has a real saved host. It is a full-screen welcome (not an error), so it rides
 * the recorded FullScreen* exception to the state-primitives rule rather than
 * the Empty primitive: there is nothing missing to report, only a first
 * connection to make. Each action opens the shared ConnectionManagerModal on the
 * matching panel.
 */

import { ConnectionManagerModal } from '@kontourai/station-connect';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useState } from 'react';
import { checkHostCompatibility } from '../lib/compatibilityLoader';
import { checkServerHealthDetailed } from '../lib/serverHealth';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import './GuidedConnect.css';
import { triggerHaptic } from '../platform/native/haptics';

type GuidedConnectPanel = 'pair-device' | 'request-access' | 'add';

interface GuidedConnectProps {
  /** Called after a pairing exchange has committed a usable browser session. */
  onSessionEstablished?: () => void;
  /**
   * archive#2652 / archive#1772: open the unpaired sample workspace so a reviewer
   * can take the receipts tour without a Station host.
   */
  onExploreSample?: () => void;
}

export function GuidedConnect({
  onSessionEstablished,
  onExploreSample,
}: GuidedConnectProps) {
  const [openPanel, setOpenPanel] = useState<GuidedConnectPanel | null>(null);
  const profile = usePlatformProfile();
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(
    window.location.hostname,
  );
  const destination = window.location.host;

  return (
    <div className="guided-connect">
      <div className="guided-connect__inner">
        <img src="/favicon.png" alt="" className="guided-connect__logo" />
        <h1 className="guided-connect__title">Connect to Station</h1>
        <p className="guided-connect__description">
          Choose the computer where you want to work.
        </p>
        {!profile.isTauri && (
          <section
            className="guided-connect__destination"
            aria-label="Current Station"
          >
            <h2>{isLocal ? 'On this computer' : 'At this address'}</h2>
            <code>{destination}</code>
            <p>
              {isLocal
                ? 'Open Station from its tray menu or use the start link printed by its launcher. That connects this browser without a pairing code.'
                : 'Ask this Station to approve access for your browser. Confirm the request on the computer running it.'}
            </p>
            <button
              type="button"
              className="guided-connect__action guided-connect__action--primary"
              onClick={() => setOpenPanel('request-access')}
            >
              Request access
            </button>
            {isLocal && (
              <small>
                Or request approval here if you do not have the start link.
              </small>
            )}
          </section>
        )}
        <section
          className="guided-connect__destination"
          aria-label="Another Station"
        >
          <h2>On another computer</h2>
          <p>
            Connect to the Station running there using its pairing code or
            address.
          </p>
          <div className="guided-connect__alternatives">
            <button
              type="button"
              className="guided-connect__action"
              onClick={() => setOpenPanel('pair-device')}
            >
              Pair with a code
            </button>
            <button
              type="button"
              className="guided-connect__action"
              onClick={() => setOpenPanel('add')}
            >
              Enter a host address
            </button>
          </div>
          {profile.isTauri && (
            <button
              type="button"
              className="guided-connect__action"
              onClick={() => setOpenPanel('request-access')}
            >
              Request access
            </button>
          )}
        </section>
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
        originIsStation={!profile.isTauri}
        hostAppName={
          profile.isTauri ? profile.productName || 'Station' : undefined
        }
        allowManualCredentials={!profile.isDesktop}
        authenticatedRequest={
          profile.isDesktop ? authenticatedFetch : undefined
        }
        onPairingSucceeded={() => {
          triggerHaptic('success');
          onSessionEstablished?.();
        }}
      />
    </div>
  );
}
