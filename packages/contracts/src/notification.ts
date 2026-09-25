export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type NotificationStatus =
  | 'pending'
  | 'delivered'
  | 'dismissed'
  | 'expired'
  | 'actioned';

export interface NotificationAction {
  id: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger';
}

export interface Notification {
  id: string;
  source: string;
  category: string;
  title: string;
  body?: string;
  priority: NotificationPriority;
  status: NotificationStatus;
  scheduledAt?: string | null;
  deliveredAt?: string | null;
  ttl?: number;
  actions?: NotificationAction[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleNotificationOpts {
  category: string;
  title: string;
  body?: string;
  priority?: NotificationPriority;
  scheduledAt?: string;
  ttl?: number;
  actions?: NotificationAction[];
  metadata?: Record<string, unknown>;
  dedupeTag?: string;
}

/**
 * Categories whose notifications are a person BLOCKING something — a decision
 * the system cannot make and that expires if nobody answers (a device pairing
 * request lives five minutes).
 *
 * Declared here because both halves depend on the exact strings and neither
 * owns them: the producers (`DevicePairingNotificationProvider`,
 * `ApprovalInbox`) emit them, and the client escalates them past the in-app
 * tray. station#1912 shipped that escalation keyed off the attention
 * projection's `kind: 'approval'`, which is derived ONLY from
 * `approval-request` — so the pairing case that motivated the work could
 * never have fired. A shared constant makes that drift a type error instead
 * of silence.
 */
export const BLOCKING_NOTIFICATION_CATEGORIES = {
  devicePairing: 'pairing-request',
  approvalRequest: 'approval-request',
} as const;

export type BlockingNotificationCategory =
  (typeof BLOCKING_NOTIFICATION_CATEGORIES)[keyof typeof BLOCKING_NOTIFICATION_CATEGORIES];

/**
 * Unified notification envelope (#2582 / #2583).
 *
 * Stored at `Notification.metadata.envelope`, never as a new top-level
 * column: the server's store validator rejects unknown top-level keys and the
 * store fails closed on an invalid document, so a new column would make every
 * previous build refuse the whole file. Records without an envelope keep
 * working; readers must treat a missing or malformed envelope as "legacy".
 *
 * The strict reader (`readNotificationEnvelope`) is a runtime parser and lives
 * in `@kontourai/station-shared/notification-envelope` — this package carries
 * shapes and constants only.
 */
export type NotificationUrgency = 'info' | 'attention' | 'done' | 'failed';

export const NOTIFICATION_URGENCIES: readonly NotificationUrgency[] = [
  'info',
  'attention',
  'done',
  'failed',
];

export const NOTIFICATION_TITLE_MAX = 80;
export const NOTIFICATION_BODY_MAX = 300;
export const NOTIFICATION_DEDUPE_KEY_MAX = 64;
/** Allowed agent dedupe keys: 1..NOTIFICATION_DEDUPE_KEY_MAX of `[A-Za-z0-9._:-]`. */
export const NOTIFICATION_DEDUPE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
export const NOTIFICATION_LINK_MAX = 512;

/** Assurance of the verified station-control caller that sent the notification. */
export type NotificationAgentAssurance =
  | 'bound'
  | 'delegated-custody'
  | 'bearer-exposed';

export type NotificationSource =
  | {
      kind: 'agent';
      sessionId: string;
      projectId?: string;
      agent?: string;
      conversationId?: string;
      assurance: NotificationAgentAssurance;
    }
  | { kind: 'system'; subsystem: string }
  | { kind: 'provider'; providerId: string };

export type NotificationAudience =
  | { kind: 'owner' }
  | { kind: 'session-readers'; sessionId: string }
  /** Reserved for future accounts; no resolver produces surfaces for it yet. */
  | { kind: 'principal'; principalId: string };

export type NotificationTarget =
  | { kind: 'session'; sessionId: string }
  /** Same-origin relative Station path (e.g. `/sessions/abc`). */
  | { kind: 'path'; path: string };

export type NotificationInterrupt = 'default' | 'silent';

export interface NotificationEnvelopeV1 {
  v: 1;
  source: NotificationSource;
  audience: NotificationAudience;
  urgency: NotificationUrgency;
  target?: NotificationTarget;
  interrupt: NotificationInterrupt;
  /** First surface to read it wins; later reads never overwrite these. */
  readAt?: string;
  readBy?: string;
  dismissedAt?: string;
  dismissedBy?: string;
}

/** Categories agent notifications are stored under, one per urgency. */
export const AGENT_NOTIFICATION_CATEGORIES = {
  info: 'agent-info',
  attention: 'agent-attention',
  done: 'agent-done',
  failed: 'agent-failed',
} as const satisfies Record<NotificationUrgency, string>;

export type AgentNotificationCategory =
  (typeof AGENT_NOTIFICATION_CATEGORIES)[NotificationUrgency];

/** What the `notify_user` station-control tool accepts from an agent. */
export interface NotifyUserRequest {
  title: string;
  body?: string;
  urgency: NotificationUrgency;
  dedupeKey?: string;
  /** Relative Station path; defaults to the calling session. */
  link?: string;
}

export type NotifyUserStatus =
  | 'sent'
  | 'updated'
  | 'deduped'
  | 'muted'
  | 'rate_limited'
  | 'unavailable'
  | 'caller-required';

/** Never carries device or delivery counts. */
export interface NotifyUserResult {
  status: NotifyUserStatus;
  notificationId?: string;
  retryAfterSec?: number;
}
