import { useConnections } from '@kontourai/station-connect';
import type { ReactNode } from 'react';
import { openConnectionsModal } from '../lib/connectionModalEvents';
import { hasRealSavedConnection } from '../lib/saved-connections';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { Button } from './Button';
import './MobileWelcomeBoundary.css';

/** Native profiles hydrate before this boundary mounts. A saved but offline
 * Station belongs to the recovery shell, never the fresh-device welcome. */
export function MobileWelcomeBoundary({ children }: { children: ReactNode }) {
  const profile = usePlatformProfile();
  const { connections } = useConnections();
  if (!profile.isMobile || hasRealSavedConnection(connections)) return children;

  // Keep the application query tree unmounted until there is a real target.
  // The connection manager and pending pairing owner live outside this boundary.
  return (
    <main className="mobile-welcome" aria-labelledby="mobile-welcome-title">
      <div className="mobile-welcome__content">
        <p className="mobile-welcome__eyebrow">Station on your phone</p>
        <h1 id="mobile-welcome-title">Your work, wherever you are.</h1>
        <p className="mobile-welcome__intro">
          Connect to Station on your computer to continue chats and review work.
          Your computer runs the agents and keeps your files.
        </p>
        <Button
          variant="primary"
          onClick={() => openConnectionsModal({ mode: 'list' })}
        >
          Connect to a Station
        </Button>
        <section className="mobile-welcome__steps" aria-label="How to connect">
          <h2>Start on your computer</h2>
          <ol>
            <li>Open Station and keep it running.</li>
            <li>Open the Station menu and choose Pair phone.</li>
            <li>Connect here using the invitation from your computer.</li>
          </ol>
        </section>
        <details>
          <summary>Which address should I use?</summary>
          <p>
            Use the reachable address shown in the computer’s pairing flow.
            localhost points to this phone, not your computer. For a Tailscale
            address, both devices need access to the same tailnet.
          </p>
          <p>
            A pairing invitation grants access; it does not create a network
            route.
          </p>
        </details>
        <p className="mobile-welcome__footnote">
          No Station yet? The connection screen includes computer setup
          instructions.
        </p>
      </div>
    </main>
  );
}
