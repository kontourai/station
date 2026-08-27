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
