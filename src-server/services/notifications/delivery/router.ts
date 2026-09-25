/**
 * NotificationDeliveryRouter (#2582 §1b/§1e, #2586): the one EventBus
 * subscriber that takes a stored notification past the in-app feed.
 *
 * NOTIFICATION_DELIVERED → AudienceResolver → DeliveryPolicy.plan() →
 * channels. `defer` steps (attention/failed while the person is looking at
 * another surface) arm a timer; when it fires the record is read back and
 * the deferred pairs are sent only if it is still delivered, unread and not
 * dismissed. NOTIFICATION_UPDATED/_DISMISSED that make a record read,
 * dismissed or no longer delivered cancel its escalation and ask
 * retract-capable channels to take back what they showed.
 *
 * Never throws into the bus: EventBus drops a listener that throws, so the
 * callback, every channel call and every timer are independently caught.
 * Everything up to `channel.deliver` runs synchronously inside the callback,
 * so a delivery starts in the same turn the store emitted it.
 */
import type {
  Notification,
  ServerEventName,
} from '@kontourai/station-contracts';
import type { NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { errorMessage } from '../../../utils/error-message.js';
import type { EventBus } from '../../orchestration/event-bus.js';
import type { NotificationPreferencesReader } from '../notification-preferences.js';
import type {
  AudienceResolution,
  AudienceResolver,
} from './audience-resolver.js';
import {
  type ChannelKind,
  type ChannelTarget,
  type DeliveryChannel,
  deliveryEnvelopeFor,
  type SurfaceId,
} from './channel.js';
import {
  deliveryKey,
  type FocusEntry,
  type PlanStep,
  type PlanSurface,
  plan,
} from './policy.js';

/**
 * Where focus comes from: #2585's `FocusPresence.snapshotForPrincipals`.
 * Each entry names the principal that reported it. Until it is wired,
 * {@link NO_FOCUS} reports nothing focused, which is exactly today's
 * behaviour (every surface is interrupted).
 */
export interface FocusSource {
  snapshotForPrincipals(
    principalIds: readonly string[],
  ): ReadonlyMap<SurfaceId, FocusEntry>;
}

export const NO_FOCUS: FocusSource = { snapshotForPrincipals: () => new Map() };

/**
 * Whether a surface can show an in-app toast right now: a connected event
 * stream for that device or client session. A focused surface without one
 * does not count as focused, so it can never silence the others while
 * showing nothing itself. {@link NO_LIVE_IN_APP} says no surface is live,
 * which makes focus inert — the safe side (interrupt) until it is wired.
 */
export interface InAppLiveness {
  isLive(surface: SurfaceId): boolean;
}

export const NO_LIVE_IN_APP: InAppLiveness = { isLive: () => false };

interface RouterLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

type Cancel = () => void;

export interface NotificationDeliveryRouterOptions {
  eventBus: EventBus;
  channels: readonly DeliveryChannel[];
  resolver: AudienceResolver;
  preferences: Pick<NotificationPreferencesReader, 'current'> &
    Partial<Pick<NotificationPreferencesReader, 'unreadable'>>;
  logger: RouterLogger;
  focus?: FocusSource;
  inAppLiveness?: InAppLiveness;
  /**
   * The current record, for the escalation re-check. Absent or resolving to
   * undefined means "cannot confirm it is still unread", and nothing is sent.
   */
  readNotification?: (id: string) => Promise<Notification | undefined>;
  now?: () => number;
  /** Tests: replaces the unref'd `setTimeout` behind escalations. */
  setTimer?: (callback: () => void, delayMs: number) => Cancel;
  timeZone?: string;
}

export interface NotificationDeliveryRouter {
  stop(): void;
  /** Notification ids with an escalation armed (diagnostics and tests). */
  pendingEscalations(): string[];
}

interface Tracked {
  /** Pairs already sent: never sent twice, retracted on read/dismiss. */
  delivered: Map<string, { channel: ChannelKind; target: ChannelTarget }>;
  deferred?: { keys: Set<string>; cancel: Cancel };
}

/** Bound on remembered records; the oldest is forgotten first. */
const MAX_TRACKED = 500;

function defaultSetTimer(callback: () => void, delayMs: number): Cancel {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function wireNotificationDeliveryRouter(
  options: NotificationDeliveryRouterOptions,
): NotificationDeliveryRouter {
  const { eventBus, channels, resolver, logger } = options;
  const focus = options.focus ?? NO_FOCUS;
  const liveness = options.inAppLiveness ?? NO_LIVE_IN_APP;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const tracked = new Map<string, Tracked>();
  const channelByKind = new Map(channels.map((c) => [c.kind, c]));
  /** Content last routed per enveloped record, to tell an edit from a touch. */
  const contentSeen = new Map<string, string>();

  function forget(id: string): void {
    tracked.get(id)?.deferred?.cancel();
    tracked.delete(id);
  }

  function track(id: string): Tracked {
    let entry = tracked.get(id);
    if (!entry) {
      entry = { delivered: new Map() };
      tracked.set(id, entry);
      while (tracked.size > MAX_TRACKED) {
        const oldest = tracked.keys().next().value;
        if (oldest === undefined) break;
        forget(oldest);
      }
    }
    return entry;
  }

  function resolveAudience(
    envelope: NotificationEnvelopeV1,
  ): AudienceResolution | undefined {
    try {
      return resolver.resolve(envelope);
    } catch (error) {
      logger.warn('notification-delivery: audience resolution failed', {
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  function preferencesUnreadable(): boolean {
    try {
      return options.preferences.unreadable?.() === true;
    } catch {
      return true;
    }
  }

  function hideContentFor(surface: SurfaceId): boolean {
    // Unreadable preferences: the person's hideContent choices are unknown,
    // so every surface hides content.
    if (preferencesUnreadable()) return true;
    try {
      return (
        options.preferences.current().perSurface[surface]?.hideContent === true
      );
    } catch {
      return true;
    }
  }

  /**
   * Surfaces with their registrations, for the channels that carry this
   * record, limited to the audience.
   */
  function collectSurfaces(
    notification: Notification,
    envelope: NotificationEnvelopeV1,
    audience: AudienceResolution,
  ): { surfaces: PlanSurface[]; refs: Map<string, string[]> } {
    const byId = new Map<SurfaceId, Set<ChannelKind>>();
    const refs = new Map<string, string[]>();
    for (const channel of channels) {
      try {
        if (channel.accepts && !channel.accepts(notification, envelope))
          continue;
        for (const registration of channel.registrations()) {
          if (!inAudience(registration.surface, audience)) continue;
          let kinds = byId.get(registration.surface);
          if (!kinds) {
            kinds = new Set();
            byId.set(registration.surface, kinds);
          }
          kinds.add(channel.kind);
          const key = deliveryKey(registration.surface, channel.kind);
          refs.set(key, [...(refs.get(key) ?? []), registration.ref]);
        }
      } catch (error) {
        logger.warn('notification-delivery: channel registrations failed', {
          channel: channel.kind,
          error: errorMessage(error),
        });
      }
    }
    return {
      surfaces: [...byId].map(([id, kinds]) => ({
        id,
        ...principalField(id, audience),
        channels: [...kinds],
      })),
      refs,
    };
  }

  /** Focus of the audience's own principals, and which of it can toast. */
  function focusFor(audience: AudienceResolution): {
    focus: Map<SurfaceId, FocusEntry>;
    liveInApp: Set<SurfaceId>;
  } {
    const result = new Map<SurfaceId, FocusEntry>();
    const liveInApp = new Set<SurfaceId>();
    const principals = new Set(audience.principalOf?.values() ?? []);
    if (audience.includesOperator && audience.operatorPrincipalId)
      principals.add(audience.operatorPrincipalId);
    if (principals.size === 0) return { focus: result, liveInApp };
    try {
      for (const [surface, entry] of focus.snapshotForPrincipals([
        ...principals,
      ])) {
        if (!inAudience(surface, audience)) continue;
        // The report must come from the principal this Station resolves the
        // surface to; a mismatch is not trusted to quiet anyone.
        if (resolvedPrincipal(surface, audience) !== entry.principalId)
          continue;
        result.set(surface, {
          ...entry,
          principalId: groupPrincipal(entry.principalId, audience),
        });
        try {
          if (liveness.isLive(surface)) liveInApp.add(surface);
        } catch (error) {
          logger.warn('notification-delivery: in-app liveness check failed', {
            error: errorMessage(error),
          });
        }
      }
    } catch (error) {
      logger.warn('notification-delivery: focus snapshot failed', {
        error: errorMessage(error),
      });
    }
    return { focus: result, liveInApp };
  }

  /** Adds focused `local:` surfaces, which have no channel registrations. */
  function withFocusedSurfaces(
    surfaces: PlanSurface[],
    focusMap: Map<SurfaceId, FocusEntry>,
    audience: AudienceResolution,
  ): PlanSurface[] {
    const present = new Set(surfaces.map((surface) => surface.id));
    const extra: PlanSurface[] = [];
    for (const surface of focusMap.keys())
      if (!present.has(surface))
        extra.push({
          id: surface,
          ...principalField(surface, audience),
          channels: [],
        });
    return [...surfaces, ...extra];
  }

  function send(
    notification: Notification,
    envelope: NotificationEnvelopeV1,
    steps: PlanStep[],
    refs: Map<string, string[]>,
    entry: Tracked,
  ): void {
    const byChannel = new Map<ChannelKind, ChannelTarget[]>();
    for (const step of steps) {
      if (step.action !== 'send' || step.channel === 'in-app') continue;
      const key = deliveryKey(step.surface, step.channel);
      for (const ref of refs.get(key) ?? []) {
        const target: ChannelTarget = {
          surface: step.surface,
          ref,
          hideContent: hideContentFor(step.surface),
        };
        const list = byChannel.get(step.channel) ?? [];
        list.push(target);
        byChannel.set(step.channel, list);
        entry.delivered.set(`${key}|${ref}`, { channel: step.channel, target });
      }
    }
    for (const [kind, targets] of byChannel) {
      const channel = channelByKind.get(kind);
      if (!channel) continue;
      try {
        void channel.deliver(notification, envelope, targets).catch((error) => {
          logger.warn('notification-delivery: channel delivery failed', {
            channel: kind,
            error: errorMessage(error),
          });
        });
      } catch (error) {
        logger.warn('notification-delivery: channel delivery failed', {
          channel: kind,
          error: errorMessage(error),
        });
      }
    }
  }

  function route(notification: Notification): void {
    if (
      !notification ||
      typeof notification.id !== 'string' ||
      typeof notification.category !== 'string'
    )
      return;
    const { envelope, legacy } = deliveryEnvelopeFor(notification);
    if (!legacy)
      remember(
        contentSeen,
        notification.id,
        contentKey(notification, envelope),
      );
    // A fresh delivery (first, or after a snooze) starts a fresh record:
    // "once per surface" is per delivery, as Web Push has always behaved.
    forget(notification.id);
    const audience = resolveAudience(envelope);
    if (!audience) return;
    const { surfaces, refs } = collectSurfaces(
      notification,
      envelope,
      audience,
    );
    if (surfaces.length === 0) return;
    const { focus: focusMap, liveInApp } = focusFor(audience);
    const steps = plan({
      env: envelope,
      now: now(),
      surfaces: withFocusedSurfaces(surfaces, focusMap, audience),
      focus: focusMap,
      liveInApp,
      prefs: options.preferences.current(),
      preferencesUnreadable: preferencesUnreadable(),
      priorDeliveries: new Set(),
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    });
    const deferred = steps.filter((step) => step.action === 'defer');
    const sends = steps.some(
      (step) => step.action === 'send' && step.channel !== 'in-app',
    );
    if (!sends && deferred.length === 0) return;
    const entry = track(notification.id);
    send(notification, envelope, steps, refs, entry);
    if (deferred.length > 0) {
      const delayMs = Math.min(...deferred.map((step) => step.deferMs ?? 0));
      entry.deferred = {
        keys: new Set(deferred.map((s) => deliveryKey(s.surface, s.channel))),
        cancel: setTimer(() => {
          void escalate(notification.id).catch((error) => {
            logger.warn('notification-delivery: escalation failed', {
              error: errorMessage(error),
            });
          });
        }, delayMs),
      };
    }
    // Nothing to retract later and nothing armed: remember nothing.
    if (!entry.deferred && !hasRetractable(entry))
      tracked.delete(notification.id);
  }

  /**
   * A dedupe update of an enveloped record that is still delivered and
   * unread, whose content differs from what was last routed, is a new
   * delivery of that record. Anything else UPDATED carries — a read marker,
   * an expiry, a lease, or the same content again — is not, so repeating an
   * event never repeats an interruption. Legacy records keep their old
   * behaviour: only NOTIFICATION_DELIVERED reaches a device.
   */
  function isContentEdit(notification: Notification): boolean {
    if (typeof notification.id !== 'string' || !stillWanted(notification))
      return false;
    const envelope = readNotificationEnvelope(notification);
    const previous = contentSeen.get(notification.id);
    return (
      envelope !== undefined &&
      previous !== undefined &&
      previous !== contentKey(notification, envelope)
    );
  }

  function hasRetractable(entry: Tracked): boolean {
    for (const { channel } of entry.delivered.values())
      if (channelByKind.get(channel)?.capabilities.retract) return true;
    return false;
  }

  async function escalate(id: string): Promise<void> {
    const entry = tracked.get(id);
    const deferred = entry?.deferred;
    if (!entry || !deferred) return;
    entry.deferred = undefined;
    const current = await options.readNotification?.(id);
    if (!current || !stillWanted(current)) {
      if (!hasRetractable(entry)) tracked.delete(id);
      return;
    }
    // The record may have been read or dismissed while it was being read back.
    if (tracked.get(id) !== entry) return;
    const { envelope } = deliveryEnvelopeFor(current);
    const audience = resolveAudience(envelope);
    if (!audience) {
      if (!hasRetractable(entry)) tracked.delete(id);
      return;
    }
    const { surfaces, refs } = collectSurfaces(current, envelope, audience);
    const { focus: focusMap, liveInApp } = focusFor(audience);
    const priorDeliveries = new Set(
      [...entry.delivered.values()].map(({ channel, target }) =>
        deliveryKey(target.surface, channel),
      ),
    );
    const steps = plan({
      env: envelope,
      now: now(),
      surfaces: withFocusedSurfaces(surfaces, focusMap, audience),
      focus: focusMap,
      liveInApp,
      prefs: options.preferences.current(),
      preferencesUnreadable: preferencesUnreadable(),
      priorDeliveries,
      phase: 'escalation',
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).filter((step) =>
      deferred.keys.has(deliveryKey(step.surface, step.channel)),
    );
    send(current, envelope, steps, refs, entry);
    if (!hasRetractable(entry)) tracked.delete(id);
  }

  function settle(notification: Notification): void {
    if (!notification || typeof notification.id !== 'string') return;
    const entry = tracked.get(notification.id);
    if (!entry || stillWanted(notification)) return;
    forget(notification.id);
    const byChannel = new Map<ChannelKind, ChannelTarget[]>();
    for (const { channel, target } of entry.delivered.values()) {
      const list = byChannel.get(channel) ?? [];
      list.push(target);
      byChannel.set(channel, list);
    }
    for (const [kind, targets] of byChannel) {
      const channel = channelByKind.get(kind);
      if (!channel?.capabilities.retract || !channel.retract) continue;
      try {
        void channel.retract(notification.id, targets).catch((error) => {
          logger.warn('notification-delivery: retract failed', {
            channel: kind,
            error: errorMessage(error),
          });
        });
      } catch (error) {
        logger.warn('notification-delivery: retract failed', {
          channel: kind,
          error: errorMessage(error),
        });
      }
    }
  }

  const unsubscribe = eventBus.subscribe((message) => {
    try {
      const event: ServerEventName = message.event;
      const notification = message.data as unknown as Notification | undefined;
      if (event === SERVER_EVENTS.NOTIFICATION_DELIVERED) {
        if (notification) route(notification);
      } else if (event === SERVER_EVENTS.NOTIFICATION_UPDATED) {
        if (!notification) return;
        if (isContentEdit(notification)) route(notification);
        else settle(notification);
      } else if (event === SERVER_EVENTS.NOTIFICATION_DISMISSED) {
        if (notification) settle(notification);
      }
    } catch (error) {
      logger.warn('notification-delivery: listener failed unexpectedly', {
        error: errorMessage(error),
      });
    }
  });

  return {
    stop() {
      unsubscribe();
      for (const id of [...tracked.keys()]) forget(id);
      contentSeen.clear();
    },
    pendingEscalations() {
      return [...tracked]
        .filter(([, entry]) => entry.deferred !== undefined)
        .map(([id]) => id);
    },
  };
}

/** Delivered, unread and not dismissed: still worth interrupting for. */
function stillWanted(notification: Notification): boolean {
  if (notification.status !== 'delivered') return false;
  const envelope = readNotificationEnvelope(notification);
  return !envelope?.readAt && !envelope?.dismissedAt;
}

function inAudience(surface: SurfaceId, audience: AudienceResolution): boolean {
  return surface.startsWith('local:')
    ? audience.includesOperator
    : audience.deviceSurfaces.has(surface);
}

function contentKey(
  notification: Notification,
  envelope: NotificationEnvelopeV1,
): string {
  return JSON.stringify([
    notification.category,
    notification.title,
    notification.body ?? null,
    envelope.urgency,
    envelope.interrupt,
    envelope.target ?? null,
  ]);
}

function remember(map: Map<string, string>, id: string, value: string): void {
  map.delete(id);
  map.set(id, value);
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function resolvedPrincipal(
  surface: SurfaceId,
  audience: AudienceResolution,
): string | undefined {
  return surface.startsWith('local:')
    ? audience.operatorPrincipalId
    : audience.principalOf?.get(surface);
}

/** The focus grouping key: one key for a one-person audience. */
const ONE_PERSON = 'audience:one-person';
function groupPrincipal(
  principalId: string,
  audience: AudienceResolution,
): string {
  return audience.onePerson ? ONE_PERSON : principalId;
}

/** The surface's focus group for the policy; absent when unresolved. */
function principalField(
  surface: SurfaceId,
  audience: AudienceResolution,
): { principalId?: string } {
  const principalId = resolvedPrincipal(surface, audience);
  return principalId === undefined
    ? {}
    : { principalId: groupPrincipal(principalId, audience) };
}
