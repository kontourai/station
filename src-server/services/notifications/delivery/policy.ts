/**
 * DeliveryPolicy (#2582 §1d, #2586): pure. Given one notification's
 * envelope, its audience's surfaces and what each can receive, the focus
 * snapshot and the preferences, decide for every (surface, channel) pair
 * whether to send now, defer, or skip — and why.
 *
 * The rules, in the order they apply to every non-in-app channel:
 *  1. `interrupt: 'silent'`, or an agent source the preferences mute:
 *     in-app only.
 *  4. Quiet hours (Station time zone): nothing interrupts, except
 *     `attention` when `allowAttention` is set. Checked before 2 and 3, so a
 *     quiet window never becomes a deferred interruption either.
 *  5. The surface's `minUrgency`.
 *  2. Some surface of the SAME person is focused: that surface gets the
 *     in-app toast only; that person's other surfaces get nothing for
 *     info/done, and attention/failed are deferred by `escalateAfterMs` and
 *     sent later only if still unread and not dismissed (the router
 *     re-checks and re-plans with `phase: 'escalation'`). Attention is
 *     never dropped because of focus elsewhere — only delayed.
 *     "Focused" means all three: the report says `focused`, it is within
 *     the lease, and the surface has a live in-app channel (`liveInApp`) —
 *     a tab whose event stream dropped cannot show the toast, so it must
 *     not silence the phone. Focus never crosses principals: another
 *     person's device (or a device scripting "focused") cannot quiet yours.
 *  3. Nothing focused: every channel on every audience surface, once.
 * In-app is planned for every surface and never suppressed.
 */
import type {
  NotificationEnvelopeV1,
  NotificationUrgency,
} from '@kontourai/station-contracts/notification';
import type {
  NotificationPreferencesV1,
  NotificationQuietHours,
} from '@kontourai/station-contracts/notification-preferences';
import { isNotificationSourceMuted } from '../notification-preferences.js';
import type { ChannelKind, SurfaceId } from './channel.js';

/** A focus report older than this no longer counts (#2585's lease). */
export const FOCUS_LEASE_MS = 120_000;

export type FocusState = 'focused' | 'visible' | 'hidden';

export interface FocusEntry {
  state: FocusState;
  /** Epoch milliseconds. */
  reportedAt: number;
  /** Who reported it; focus only ever quiets that principal's surfaces. */
  principalId: string;
}

export interface PlanSurface {
  id: SurfaceId;
  /**
   * The principal this surface reads as. A surface without one is never
   * quieted by another surface's focus.
   */
  principalId?: string;
  /** Non-in-app channels this surface has a registration on. */
  channels: readonly ChannelKind[];
}

export interface PlanInput {
  env: NotificationEnvelopeV1;
  now: number;
  surfaces: readonly PlanSurface[];
  focus: ReadonlyMap<SurfaceId, FocusEntry>;
  /** Surfaces with a connected in-app channel right now. */
  liveInApp: ReadonlySet<SurfaceId>;
  prefs: NotificationPreferencesV1;
  /** `deliveryKey(surface, channel)` already sent for this notification. */
  priorDeliveries: ReadonlySet<string>;
  /** `escalation`: the deferral already ran out and the record is unread. */
  phase?: 'initial' | 'escalation';
  /** IANA zone quiet hours are read in; the process's zone when absent. */
  timeZone?: string;
}

export type PlanAction = 'send' | 'defer' | 'skip';

export type PlanReason =
  | 'in-app'
  | 'silent'
  | 'muted'
  | 'quiet-hours'
  | 'below-min-urgency'
  | 'already-delivered'
  | 'focused-surface'
  | 'another-surface-focused'
  | 'escalate-if-unread'
  | 'escalation'
  | 'nothing-focused';

export interface PlanStep {
  surface: SurfaceId;
  channel: ChannelKind;
  action: PlanAction;
  reason: PlanReason;
  /** Present on `defer`: how long to wait before re-checking. */
  deferMs?: number;
}

const URGENCY_RANK: Record<NotificationUrgency, number> = {
  info: 0,
  done: 1,
  failed: 2,
  attention: 3,
};

export function deliveryKey(surface: SurfaceId, channel: ChannelKind): string {
  return `${surface}|${channel}`;
}

export function isFocused(entry: FocusEntry | undefined, now: number): boolean {
  return (
    entry !== undefined &&
    entry.state === 'focused' &&
    now - entry.reportedAt <= FOCUS_LEASE_MS
  );
}

/** Principals with a surface that is focused AND can show the in-app toast. */
function focusedPrincipals(input: PlanInput): Map<string, Set<SurfaceId>> {
  const result = new Map<string, Set<SurfaceId>>();
  for (const [surface, entry] of input.focus) {
    if (!isFocused(entry, input.now) || !input.liveInApp.has(surface)) continue;
    const surfaces = result.get(entry.principalId) ?? new Set<SurfaceId>();
    surfaces.add(surface);
    result.set(entry.principalId, surfaces);
  }
  return result;
}

export function plan(input: PlanInput): PlanStep[] {
  const { env, now, prefs } = input;
  const phase = input.phase ?? 'initial';
  const steps: PlanStep[] = [];
  const muted = isNotificationSourceMuted(prefs, env.source, env.urgency);
  const quiet =
    prefs.quietHours !== undefined &&
    isWithinQuietHours(prefs.quietHours, now, input.timeZone) &&
    !(env.urgency === 'attention' && prefs.quietHours.allowAttention);
  const focusedBy = focusedPrincipals(input);
  const escalates = env.urgency === 'attention' || env.urgency === 'failed';

  for (const surface of input.surfaces) {
    if (phase === 'initial')
      steps.push({
        surface: surface.id,
        channel: 'in-app',
        action: 'send',
        reason: 'in-app',
      });
    const sameOwner =
      surface.principalId === undefined
        ? undefined
        : focusedBy.get(surface.principalId);
    const focusedHere = sameOwner?.has(surface.id) === true;
    const focusedElsewhere =
      sameOwner !== undefined && [...sameOwner].some((id) => id !== surface.id);
    const surfacePrefs = prefs.perSurface[surface.id];
    for (const channel of new Set(surface.channels)) {
      if (channel === 'in-app') continue;
      const step = (action: PlanAction, reason: PlanReason) =>
        steps.push({ surface: surface.id, channel, action, reason });
      if (env.interrupt === 'silent') step('skip', 'silent');
      else if (muted) step('skip', 'muted');
      else if (quiet) step('skip', 'quiet-hours');
      else if (
        surfacePrefs &&
        URGENCY_RANK[env.urgency] < URGENCY_RANK[surfacePrefs.minUrgency]
      )
        step('skip', 'below-min-urgency');
      else if (input.priorDeliveries.has(deliveryKey(surface.id, channel)))
        step('skip', 'already-delivered');
      else if (focusedHere) step('skip', 'focused-surface');
      else if (phase === 'escalation') step('send', 'escalation');
      else if (focusedElsewhere && !escalates)
        step('skip', 'another-surface-focused');
      else if (focusedElsewhere)
        steps.push({
          surface: surface.id,
          channel,
          action: 'defer',
          reason: 'escalate-if-unread',
          deferMs: prefs.escalateAfterMs,
        });
      else step('send', 'nothing-focused');
    }
  }
  return steps;
}

/** `[start, end)` in the zone's wall clock; a window may wrap midnight. */
export function isWithinQuietHours(
  quietHours: NotificationQuietHours,
  now: number,
  timeZone?: string,
): boolean {
  const start = clockMinutes(quietHours.start);
  const end = clockMinutes(quietHours.end);
  if (start === undefined || end === undefined || start === end) return false;
  const minute = minuteOfDay(now, timeZone);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function clockMinutes(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minuteOfDay(now: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}
