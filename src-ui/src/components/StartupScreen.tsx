import { useEffect, useRef } from 'react';
import { startStartupAnimation } from '../lib/startup-animation';

export function StartupScreen({ message }: { message?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current) return startStartupAnimation(canvas.current);
  }, []);
  return (
    <div
      className="station-startup"
      role="status"
      aria-label={message ?? 'Station'}
      aria-busy="true"
    >
      <canvas
        ref={canvas}
        className="station-startup__canvas"
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
      {message && (
        <span
          key={message}
          className="station-startup__message"
          aria-hidden="true"
        >
          {message}
        </span>
      )}
    </div>
  );
}
