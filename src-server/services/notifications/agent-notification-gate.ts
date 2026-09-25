/**
 * AgentNotificationGate (#2584, epic #2582 section 2): everything between a
 * verified `notify_user` caller and `NotificationService.schedule`.
 *
 * The route (`routes/operations/agent-notifications.ts`) has already
 * re-derived the caller from its forwarded credential; nothing here reads a
 * session, project or agent from the request body. In order:
 *
 *  1. hosted Station → `unavailable` (no tenant-bound delivery exists yet);
 *  2. preferences → `muted` (read through {@link AgentNotificationPreferences};
 *     the stored preferences arrive with the delivery router, #2586);
 *  3. redaction and caps on title/body; link → same-origin path, else the
 *     calling session;
 *  4. in-memory rate limits → `rate_limited` with `retryAfterSec`;
 *  5. `schedule('agent', …)` with an envelope → `sent` | `updated` | `deduped`.
 *
 * Results never carry device or delivery counts: the tool's answer must not
 * tell an agent who is listening.
 */
import { createHash } from 'node:crypto';
import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_DEDUPE_KEY_PATTERN,
  NOTIFICATION_LINK_MAX,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_URGENCIES,
  type NotificationEnvelopeV1,
  type NotificationTarget,
  type NotificationUrgency,
  type NotifyUserRequest,
  type NotifyUserResult,
  type ScheduleNotificationOpts,
} from '@kontourai/station-contracts/notification';
import {
  agentNotificationCategory,
  agentNotificationDedupeTag,
  isRelativeStationPath,
  notificationPriorityForUrgency,
} from '@kontourai/station-shared/notification-envelope';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { agentNotificationOps } from '../../telemetry/metrics.js';
import type { StationControlCaller } from '../../tools/station-control-shared.js';
import type {
  NotificationScheduleOutcome,
  NotificationService,
} from './notification-service.js';

/** `Notification.source` for every agent notification. */
export const AGENT_NOTIFICATION_SOURCE = 'agent';

export type AgentNotificationPreference = 'all' | 'attention-only' | 'off';

/**
 * The preferences seam. The stored preferences (`notification-preferences.json`,
 * per project/agent, #2586) do not exist yet; until they do the production
 * composition passes nothing and every notification is allowed
 * ({@link ALLOW_ALL_AGENT_NOTIFICATIONS}), which is the owner-decided default.
 */
export interface AgentNotificationPreferences {
  agentNotifications(scope: {
    readonly projectId?: string;
    readonly agent?: string;
  }): AgentNotificationPreference;
}

export const ALLOW_ALL_AGENT_NOTIFICATIONS: AgentNotificationPreferences = {
  agentNotifications: () => 'all',
};

/** What Station's own records say about the calling session. */
export interface AgentNotificationSessionContext {
  /**
   * The ROOT of the calling session's delegation tree (its root
   * conversation id), when the session is a delegated child. Rate limits and
   * dedupe keys are namespaced by it, so a child cannot multiply its root's
   * allowance or collide with a sibling tree's keys.
   */
  readonly rootId?: string;
  /** The agent slug the session started with (attribution only). */
  readonly agent?: string;
}

/**
 * The production {@link AgentNotificationSessionContext}, from the metadata
 * the session STARTED with (`firstStartedMetadataOfThread`): later
 * reconfiguration events drop fields, the start record does not.
 */
export function agentNotificationSessionContext(
  startedMetadata: Record<string, unknown> | undefined,
): AgentNotificationSessionContext | undefined {
  if (!startedMetadata) return undefined;
  const delegation = startedMetadata.delegation as
    | { rootConversationId?: unknown }
    | undefined;
  const rootId =
    typeof delegation?.rootConversationId === 'string' &&
    delegation.rootConversationId
      ? delegation.rootConversationId
      : undefined;
  const agent =
    typeof startedMetadata.agentSlug === 'string' && startedMetadata.agentSlug
      ? startedMetadata.agentSlug
      : undefined;
  return {
    ...(rootId ? { rootId } : {}),
    ...(agent ? { agent } : {}),
  };
}

export interface AgentNotificationRateLimits {
  /** Per root: burst size of the token bucket. */
  readonly rootBurst: number;
  /** Per root: one token is restored every this many ms. */
  readonly rootRefillMs: number;
  /** Per root: at most this many per rolling hour. */
  readonly rootPerHour: number;
  /** Per Station: at most this many `attention` notifications per hour. */
  readonly attentionPerHour: number;
  /** Per Station: at most this many agent notifications per hour. */
  readonly globalPerHour: number;
}

export const DEFAULT_AGENT_NOTIFICATION_RATE_LIMITS: AgentNotificationRateLimits =
  Object.freeze({
    rootBurst: 3,
    rootRefillMs: 60_000,
    rootPerHour: 20,
    attentionPerHour: 10,
    globalPerHour: 60,
  });

const HOUR_MS = 60 * 60 * 1000;
/** Upper bound on tracked roots; idle roots are pruned first. */
const MAX_TRACKED_ROOTS = 5_000;

interface RootState {
  tokens: number;
  refilledAt: number;
  sent: number[];
}

type RateDecision =
  | { readonly ok: true; readonly commit: () => void }
  | { readonly ok: false; readonly retryAfterMs: number };

/**
 * In-memory limiter. A restart forgets it, which at worst lets one more
 * burst through; persisting it would put a write on every notification.
 */
export class AgentNotificationRateLimiter {
  private readonly roots = new Map<string, RootState>();
  private readonly attention: number[] = [];
  private readonly global: number[] = [];

  constructor(
    private readonly limits: AgentNotificationRateLimits = DEFAULT_AGENT_NOTIFICATION_RATE_LIMITS,
  ) {}

  check(
    rootId: string,
    urgency: NotificationUrgency,
    now: number,
  ): RateDecision {
    this.prune(now);
    const existing = this.roots.get(rootId);
    const state: RootState = existing
      ? { ...existing, sent: existing.sent }
      : { tokens: this.limits.rootBurst, refilledAt: now, sent: [] };
    const elapsed = Math.max(0, now - state.refilledAt);
    const tokens = Math.min(
      this.limits.rootBurst,
      state.tokens + elapsed / this.limits.rootRefillMs,
    );
    const waits: number[] = [];
    // Tolerance for float refill arithmetic: a caller that waited the
    // advertised retryAfterSec must find a whole token.
    if (tokens < 1 - 1e-9) waits.push((1 - tokens) * this.limits.rootRefillMs);
    const hourWait = windowWait(state.sent, this.limits.rootPerHour, now);
    if (hourWait > 0) waits.push(hourWait);
    if (urgency === 'attention') {
      const wait = windowWait(
        this.attention,
        this.limits.attentionPerHour,
        now,
      );
      if (wait > 0) waits.push(wait);
    }
    const globalWait = windowWait(this.global, this.limits.globalPerHour, now);
    if (globalWait > 0) waits.push(globalWait);
    if (waits.length > 0)
      return { ok: false, retryAfterMs: Math.max(...waits) };
    return {
      ok: true,
      commit: () => {
        state.tokens = tokens - 1;
        state.refilledAt = now;
        state.sent.push(now);
        // Re-insert so Map order tracks recency for eviction.
        this.roots.delete(rootId);
        this.roots.set(rootId, state);
        if (urgency === 'attention') this.attention.push(now);
        this.global.push(now);
      },
    };
  }

  private prune(now: number): void {
    dropOlderThan(this.attention, now - HOUR_MS);
    dropOlderThan(this.global, now - HOUR_MS);
    for (const [rootId, state] of this.roots) {
      dropOlderThan(state.sent, now - HOUR_MS);
      // Idle for an hour: its bucket is full and its window empty, so
      // forgetting it changes no decision.
      if (state.sent.length === 0 && now - state.refilledAt >= HOUR_MS)
        this.roots.delete(rootId);
    }
    while (this.roots.size > MAX_TRACKED_ROOTS) {
      const oldest = this.roots.keys().next().value;
      if (oldest === undefined) break;
      this.roots.delete(oldest);
    }
  }
}

function dropOlderThan(times: number[], cutoff: number): void {
  let drop = 0;
  while (drop < times.length && times[drop] <= cutoff) drop += 1;
  if (drop > 0) times.splice(0, drop);
}

/** ms until a rolling-hour window has room, or 0 when it has room now. */
function windowWait(
  times: readonly number[],
  max: number,
  now: number,
): number {
  const inWindow = times.filter((time) => time > now - HOUR_MS);
  if (inWindow.length < max) return 0;
  return inWindow[inWindow.length - max] + HOUR_MS - now;
}

/**
 * Strict parse of the route body. Over-limit or wrongly typed fields are
 * refused rather than repaired: the tool's schema already enforces the same
 * limits, so only a caller bypassing the tool reaches this with bad input.
 */
export function parseNotifyUserRequest(
  value: unknown,
): NotifyUserRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set(['title', 'body', 'urgency', 'dedupeKey', 'link']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  const { title, body, dedupeKey, link } = record;
  const urgency = record.urgency ?? 'info';
  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > NOTIFICATION_TITLE_MAX
  )
    return undefined;
  if (
    body !== undefined &&
    (typeof body !== 'string' || body.length > NOTIFICATION_BODY_MAX)
  )
    return undefined;
  if (!(NOTIFICATION_URGENCIES as readonly unknown[]).includes(urgency))
    return undefined;
  if (
    dedupeKey !== undefined &&
    (typeof dedupeKey !== 'string' ||
      !NOTIFICATION_DEDUPE_KEY_PATTERN.test(dedupeKey))
  )
    return undefined;
  if (
    link !== undefined &&
    (typeof link !== 'string' || link.length > NOTIFICATION_LINK_MAX)
  )
    return undefined;
  return {
    title,
    urgency: urgency as NotificationUrgency,
    ...(body === undefined ? {} : { body }),
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
    ...(link === undefined ? {} : { link }),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Known credential shapes redacted, one line, bounded. */
export function agentNotificationTitle(title: string): string {
  return cap(
    redactSecrets(title).replace(/\s+/g, ' ').trim(),
    NOTIFICATION_TITLE_MAX,
  );
}

/** Known credential shapes redacted, control characters removed, bounded. */
export function agentNotificationBody(body: string): string | undefined {
  const text = redactSecrets(body).replace(CONTROL_EXCEPT_NEWLINE, ' ').trim();
  return text ? cap(text, NOTIFICATION_BODY_MAX) : undefined;
}

/**
 * A root id usable inside a dedupe tag (`agent:<root>:<key>`, no `:` in the
 * root). Ids that are not plain tokens are replaced by a digest, which keeps
 * them distinct without letting their characters reach the tag.
 */
export function agentNotificationNamespace(rootId: string): string {
  return /^[A-Za-z0-9._-]{1,128}$/.test(rootId)
    ? rootId
    : `h${createHash('sha256').update(rootId).digest('hex').slice(0, 32)}`;
}

/** What the gate hands the store: the record fields and, separately, its envelope. */
export interface AgentNotificationScheduleInput {
  readonly opts: ScheduleNotificationOpts;
  readonly envelope: NotificationEnvelopeV1;
}

export type ScheduleAgentNotification = (
  input: AgentNotificationScheduleInput,
) => Promise<{
  notification: { id: string };
  outcome: NotificationScheduleOutcome;
}>;

/**
 * The ONE place an agent notification's envelope meets the store. It rides
 * in `metadata.envelope` today; when the store gains a trusted envelope
 * write path (the #2583 security fix), only this adapter changes.
 */
export function scheduleAgentNotificationVia(
  service: Pick<NotificationService, 'scheduleWithOutcome'>,
): ScheduleAgentNotification {
  return ({ opts, envelope }) =>
    service.scheduleWithOutcome(AGENT_NOTIFICATION_SOURCE, {
      ...opts,
      metadata: { ...opts.metadata, envelope },
    });
}

export interface AgentNotificationGateDeps {
  schedule: ScheduleAgentNotification;
  /** True on a hosted Station: agent notifications are unavailable there. */
  isHosted(): boolean;
  preferences?: AgentNotificationPreferences;
  sessionContext?(
    sessionId: string,
  ): AgentNotificationSessionContext | undefined;
  now?: () => number;
  limits?: AgentNotificationRateLimits;
  logger?: { info(message: string, context?: unknown): void };
}

export class AgentNotificationGate {
  private readonly limiter: AgentNotificationRateLimiter;
  private readonly now: () => number;
  private readonly preferences: AgentNotificationPreferences;

  constructor(private readonly deps: AgentNotificationGateDeps) {
    this.limiter = new AgentNotificationRateLimiter(deps.limits);
    this.now = deps.now ?? Date.now;
    this.preferences = deps.preferences ?? ALLOW_ALL_AGENT_NOTIFICATIONS;
  }

  async notify(
    caller: StationControlCaller,
    request: NotifyUserRequest,
  ): Promise<NotifyUserResult> {
    const result = await this.decide(caller, request);
    recordAgentNotification(result.status, request.urgency);
    // Session id and outcome only: never the title, body or link.
    this.deps.logger?.info('Agent notification', {
      sessionId: caller.sessionId,
      status: result.status,
      urgency: request.urgency,
    });
    return result;
  }

  private async decide(
    caller: StationControlCaller,
    request: NotifyUserRequest,
  ): Promise<NotifyUserResult> {
    if (this.deps.isHosted()) return { status: 'unavailable' };
    const context = this.deps.sessionContext?.(caller.sessionId);
    // Project identity only when Station recorded it at session start; a
    // slug looked up now may name a different project (attribution and
    // per-project muting both key on it).
    const projectId =
      caller.projectIdSource === 'session-record'
        ? caller.localProjectId
        : undefined;
    const agent = context?.agent;
    const preference = this.preferences.agentNotifications({
      ...(projectId ? { projectId } : {}),
      ...(agent ? { agent } : {}),
    });
    if (
      preference === 'off' ||
      (preference === 'attention-only' && request.urgency !== 'attention')
    )
      return { status: 'muted' };

    // A delegated child names its tree's root conversation; a root session
    // is keyed by its own conversation, which is the id its children carry
    // as `rootConversationId`. A session with neither falls back to itself.
    const rootId = context?.rootId ?? caller.conversationId ?? caller.sessionId;
    const decision = this.limiter.check(rootId, request.urgency, this.now());
    if (!decision.ok)
      return {
        status: 'rate_limited',
        // Whole ms first, so float refill arithmetic cannot add a second.
        retryAfterSec: Math.max(
          1,
          Math.ceil(Math.round(decision.retryAfterMs) / 1000),
        ),
      };

    const link =
      request.link !== undefined && isRelativeStationPath(request.link.trim())
        ? request.link.trim()
        : undefined;
    const target: NotificationTarget = link
      ? { kind: 'path', path: link }
      : { kind: 'session', sessionId: caller.sessionId };
    const envelope: NotificationEnvelopeV1 = {
      v: 1,
      source: {
        kind: 'agent',
        sessionId: caller.sessionId,
        ...(projectId ? { projectId } : {}),
        ...(agent ? { agent } : {}),
        ...(caller.conversationId
          ? { conversationId: caller.conversationId }
          : {}),
        assurance: caller.assurance,
      },
      audience: { kind: 'session-readers', sessionId: caller.sessionId },
      urgency: request.urgency,
      target,
      interrupt: 'default',
    };
    const body =
      request.body === undefined
        ? undefined
        : agentNotificationBody(request.body);
    decision.commit();
    const { notification, outcome } = await this.deps.schedule({
      envelope,
      opts: {
        category: agentNotificationCategory(request.urgency),
        title: agentNotificationTitle(request.title),
        ...(body === undefined ? {} : { body }),
        priority: notificationPriorityForUrgency(request.urgency),
        ...(request.dedupeKey
          ? {
              dedupeTag: agentNotificationDedupeTag(
                agentNotificationNamespace(rootId),
                request.dedupeKey,
              ),
            }
          : {}),
        metadata: {
          // `sessionId` is what the notification routes' read check keys on,
          // so only readers of the calling session see it in the inbox.
          sessionId: caller.sessionId,
          ...(caller.projectSlug ? { projectSlug: caller.projectSlug } : {}),
          ...(link ? { link } : {}),
        },
      },
    });
    return {
      status:
        outcome === 'created'
          ? 'sent'
          : outcome === 'updated'
            ? 'updated'
            : 'deduped',
      notificationId: notification.id,
    };
  }
}

/** One count per `notify_user` answer, including refusals before the gate. */
export function recordAgentNotification(
  status: NotifyUserResult['status'],
  urgency: NotificationUrgency | 'unknown',
): void {
  agentNotificationOps.add(1, { result: status, urgency });
}
