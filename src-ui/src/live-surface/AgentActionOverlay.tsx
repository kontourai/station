import type { LiveSurfaceAgentAction } from '@kontourai/station-contracts/live-surface';
import { useEffect, useState } from 'react';

/** Drawn inside the displayed image rectangle; all coordinates are target CSS pixels. */
export function AgentActionOverlay({
  action,
  expiresAt,
  now = Date.now,
}: {
  action: LiveSurfaceAgentAction;
  expiresAt: number;
  now?: () => number;
}) {
  const [visible, setVisible] = useState(() => expiresAt > now());
  useEffect(() => {
    const timer = setTimeout(
      () => setVisible(false),
      Math.max(0, expiresAt - now()),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, now]);
  const { viewport, point, box } = action;
  const x = (value: number) =>
    `${((value - viewport.x) / viewport.width) * 100}%`;
  const y = (value: number) =>
    `${((value - viewport.y) / viewport.height) * 100}%`;
  return (
    <div
      className="live-surface__agent-action"
      aria-hidden="true"
      data-visible={visible}
    >
      {box.width > 0 && box.height > 0 ? (
        <span
          data-testid="agent-target"
          className="live-surface__agent-target"
          style={{
            left: x(box.x),
            top: y(box.y),
            width: `${(box.width / viewport.width) * 100}%`,
            height: `${(box.height / viewport.height) * 100}%`,
          }}
        />
      ) : null}
      <span
        data-testid="agent-cursor"
        className="live-surface__agent-cursor"
        style={{ left: x(point.x), top: y(point.y) }}
      >
        {action.kind === 'click' ? (
          <span className="live-surface__agent-ping" />
        ) : null}
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path
            d="M3 2l12 8-5 1-2 5z"
            fill="var(--k-panel)"
            stroke="var(--k-brand)"
            strokeWidth="2"
          />
        </svg>
      </span>
    </div>
  );
}
