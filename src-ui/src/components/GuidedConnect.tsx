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
   * station#2652 / #1772: open the unpaired sample workspace so a reviewer
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

  return (
    <div className="guided-connect">
      <div className="guided-connect__inner">
        <img src="/favicon.png" alt="" className="guided-connect__logo" />
        <h1 className="guided-connect__title">Connect to your Station host</h1>
        <p className="guided-connect__description">
          Station runs on your computer or server. Connect this device to start
          working with your agents.
        </p>
        <div className="guided-connect__actions">
          <button
            type="button"
            className="guided-connect__action guided-connect__action--primary"
            onClick={() => setOpenPanel('pair-device')}
          >
            Pair with a code
          </button>
          <button
            type="button"
            className="guided-connect__action"
            onClick={() => setOpenPanel('request-access')}
          >
            Request access
          </button>
          <button
            type="button"
            className="guided-connect__action"
            onClick={() => setOpenPanel('add')}
          >
            Enter a host address
          </button>
          {onExploreSample ? (
            <button
              type="button"
              className="guided-connect__action"
              onClick={onExploreSample}
            >
              See how Station works
            </button>
          ) : null}
        </div>
        <p className="guided-connect__footer">
          On the same network? Use your host's IP address, not localhost.
        </p>
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
