import { type ReactNode, useEffect, useRef } from 'react';
import { startStartupAnimation } from '../lib/startup-animation';
// The splash's own rules (`startup-screen.css`) load from index.html, before
// any script, so this shares them rather than bundling a second copy.
import './StationPreparingSurface.css';

/**
 * The launch splash's look for a Station that is getting ready after launch:
 * switching Stations, or a later stage of preparing one. The cold-launch
 * splash is a one-time element (`startup-presentation.ts`) that is gone once
 * the app first commits, so this draws the same mark, animation and status
 * line in React, with room below for what to do when the wait runs long.
 *
 * `title` names what is happening to which Station ("Connecting to Kontour");
 * `message` is the step it is on, and is the one live region, so each step is
 * announced as it changes.
 */
export function StationPreparingSurface({
  title,
  host,
  message,
  busy = true,
  children,
}: {
  title?: string;
  /** The Station's address, when it says more than the title. */
  host?: string;
  message: string;
  busy?: boolean;
  /** Actions and errors shown below the status line. */
  children?: ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    // jsdom has no canvas; the static mark stands in, as it does on the
    // splash until the first frame paints.
    if (!canvas || /jsdom/i.test(navigator.userAgent)) return;
    return startStartupAnimation(canvas, {
      isVisible: () => document.visibilityState !== 'hidden',
    });
  }, []);
  return (
    <div className="station-startup station-preparing" aria-busy={busy}>
      <canvas
        ref={canvasRef}
        className="station-startup__canvas"
        // As on the splash: the mark it draws is the app's name. The
        // animation draws into its parent, so it cannot be wrapped.
        role="img"
        aria-label="Station"
      />
      <img
        className="station-startup__logo"
        src="/favicon.png"
        alt=""
        width="96"
        height="96"
      />
      <div className="station-preparing__stage">
        {title && <h1 className="station-preparing__title">{title}</h1>}
        {host && <p className="station-preparing__host">{host}</p>}
        {/* Keyed on the step, so each new step plays the splash's entrance. */}
        {/* A status takes no name from its text; it is named as the splash
            names its own, so both read the same. */}
        <p
          key={message}
          className="station-preparing__message"
          role="status"
          aria-label={message}
        >
          {message}
        </p>
        {children}
      </div>
    </div>
  );
}
