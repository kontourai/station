// biome-ignore lint/correctness/noUnusedImports: React needed for classic JSX transform
import React from 'react';

import type { ConnectionIndicatorState } from '../core/connectionIndicator';

const COLOR: Record<ConnectionIndicatorState, string> = {
  connected: '#22c55e',
  connecting: '#eab308',
  error: '#ef4444',
  idle: '#6b7280',
  // Amber rather than the error red: this is not a broken host, it is a host
  // waiting for you. The colour is the *last* channel it is distinguished by
  // — see the shape below.
  'needs-credential': '#f59e0b',
  // station#4512 — also amber: neither is a broken host either. A pending
  // approval is the ordinary shape of "still waiting" (never a failure to
  // explain, per `ConnectionFailureReason`'s own `awaiting-approval` doc);
  // an identity mismatch is a host that answered but changed underneath the
  // connection, not one that stopped answering.
  'awaiting-approval': '#f59e0b',
  'needs-repair': '#f59e0b',
};

export interface ConnectionStatusDotProps {
  status: ConnectionIndicatorState;
  size?: number;
}

/**
 * station#3297 — `needs-credential` is carried by SHAPE, not colour.
 *
 * A 7px disc cannot encode a fourth meaning by hue: it fails a colour-blind
 * reader outright, and even for everyone else "amber" and "yellow" at that
 * size are the same dot. A triangle has a different silhouette at every size,
 * survives monochrome, and reads as "needs attention" without being taught.
 * Callers add the two remaining channels — an accessible name
 * (`connectionIndicatorLabel`) and, where there is room, a visible word
 * (`connectionIndicatorActionLabel`).
 */
export function ConnectionStatusDot({
  status,
  size = 8,
}: ConnectionStatusDotProps) {
  // `needs-repair` shares `needs-credential`'s triangle: both name a state
  // with a DISTINCT remedy (re-pair, not merely retry) — the same reason the
  // triangle exists at all (station#3297: a 7px disc cannot encode a fourth
  // meaning by hue alone). `awaiting-approval` stays a circle: there is
  // nothing to distinguish it FOR — the control still just opens Manage
  // Stations — so the amber fill alone (plus its own visible word) is enough.
  if (status === 'needs-credential' || status === 'needs-repair') {
    return (
      <svg
        role="img"
        aria-label={
          status === 'needs-repair' ? 'needs re-pairing' : 'needs pairing'
        }
        width={size}
        height={size}
        viewBox="0 0 12 12"
        // Scale up slightly: a triangle inscribed in the dot's box reads
        // smaller than a disc of the same nominal size.
        style={{ display: 'inline-block', flexShrink: 0, overflow: 'visible' }}
        fill={COLOR[status]}
      >
        <path d="M6 0.5 11.5 11h-11z" />
      </svg>
    );
  }
  return (
    <span
      role="img"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: COLOR[status],
        flexShrink: 0,
      }}
      aria-label={status}
    />
  );
}
