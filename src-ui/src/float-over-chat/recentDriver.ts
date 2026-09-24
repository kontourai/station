import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { useEffect, useState } from 'react';
import type { LiveSurfaceControllerTone } from '../live-surface/LiveSurfaceCanvas';

/**
 * How long after an agent's last successful input or navigation it still
 * reads as "driving" once it has let go of the lease. Agents hold control
 * only for the length of each tool call, so without this window a person
 * watching sees "No one is in control" for almost all of an agent's turn.
 */
export const RECENT_AGENT_DRIVE_MS = 10_000;

/**
 * Who a viewer should be told is driving (owner decision, #90 D9 follow-up).
 * Derived, never asserted:
 * - a held lease names its holder;
 * - with no holder, the session's last driver is an agent AND its last
 *   successful input is younger than {@link RECENT_AGENT_DRIVE_MS}: still
 *   driving (a person who took over since is not an agent driving, L1);
 * - otherwise no one is.
 * `holder` is the live view's lease reading, or null where there is no live
 * view (the narrow-chat notice). `agentInputAgeMs` is how old that input is
 * NOW, measured without comparing the server's clock to this device's
 * (see {@link useRecentDriver}); undefined means no known input.
 */
export function recentDriver(input: {
  holder: LiveSurfaceControllerTone | null;
  lastDriverIsAgent: boolean;
  agentInputAgeMs: number | undefined;
}): LiveSurfaceControllerTone {
  if (input.holder !== null && input.holder !== 'none') return input.holder;
  const age = input.agentInputAgeMs;
  if (
    input.lastDriverIsAgent &&
    age !== undefined &&
    Number.isFinite(age) &&
    age < RECENT_AGENT_DRIVE_MS
  )
    return 'agent';
  return 'none';
}

/** What the window is derived from, for one session payload. */
export interface RecentAgentInput {
  /** Server time of the agent's last successful input. */
  lastAgentInputAt: string | undefined;
  /** Server time when the payload was sent (same clock). */
  serverNow: string | undefined;
  /** When the payload arrived, on this device's `performance.now()` clock. */
  receivedAt: number | undefined;
  lastDriverIsAgent: boolean;
}

export function agentInputOf(
  session: Pick<BrowserSessionView, 'activity' | 'serverNow'>,
  receivedAt: number | undefined,
): RecentAgentInput {
  return {
    lastAgentInputAt: session.activity?.lastAgentInputAt,
    serverNow: session.serverNow,
    receivedAt,
    lastDriverIsAgent: session.activity?.lastDriver?.kind === 'agent',
  };
}

/**
 * The input's age NOW: its age when the payload was sent, from two SERVER
 * timestamps (`serverNow - lastAgentInputAt`), plus the time since the
 * payload arrived on this device's monotonic clock. Clock skew cannot move
 * it. A negative server-side age (the server's clock stepped back between
 * the two stamps) is clamped to zero, so the most it can ever show is one
 * window from receipt, never more. Any missing part is no known input.
 */
export function agentInputAge(
  input: RecentAgentInput,
  now: number,
): number | undefined {
  const { lastAgentInputAt, serverNow, receivedAt } = input;
  if (
    lastAgentInputAt === undefined ||
    serverNow === undefined ||
    receivedAt === undefined
  )
    return undefined;
  const atSend = Date.parse(serverNow) - Date.parse(lastAgentInputAt);
  if (!Number.isFinite(atSend)) return undefined;
  return Math.max(0, atSend) + Math.max(0, now - receivedAt);
}

/**
 * {@link recentDriver} for a session payload, re-derived by a timer at the
 * lapse moment, so the display falls back to "No one is in control"
 * without waiting for another event.
 */
export function useRecentDriver(
  holder: LiveSurfaceControllerTone | null,
  input: RecentAgentInput,
): LiveSurfaceControllerTone {
  // Re-rendered by the lapse timer below; the age is read at render.
  const [, setLapsed] = useState(0);
  const age = agentInputAge(input, performance.now());
  const driver = recentDriver({
    holder,
    lastDriverIsAgent: input.lastDriverIsAgent,
    agentInputAgeMs: age,
  });
  const fromWindow = driver === 'agent' && holder !== 'agent';
  const lapseIn = age === undefined ? undefined : RECENT_AGENT_DRIVE_MS - age;
  // Keyed on the payload's identity, not on the age (which moves every
  // render): one timer per payload, to the moment its window closes.
  const { lastAgentInputAt, serverNow, receivedAt } = input;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lapseIn` is read when the payload changes; re-arming it on every render would never fire.
  useEffect(() => {
    if (!fromWindow || lapseIn === undefined) return;
    const timer = setTimeout(
      () => setLapsed((count) => count + 1),
      Math.max(0, lapseIn) + 1,
    );
    return () => clearTimeout(timer);
  }, [fromWindow, lastAgentInputAt, serverNow, receivedAt]);
  return driver;
}
