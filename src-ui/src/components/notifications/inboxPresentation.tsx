import type { Notification } from '@kontourai/station-contracts/notification';
import type { AttentionItem } from '@kontourai/station-sdk';
import type { ComponentType } from 'react';
import {
  BellGlyph,
  CheckGlyph,
  DiffGlyph,
  LockGlyph,
  MessageGlyph,
  PhoneGlyph,
  PlugGlyph,
  ReturnGlyph,
  SettingsGlyph,
  ShieldGlyph,
  TargetGlyph,
  WarningGlyph,
} from '../icons/Glyph';
import './inboxPresentation.css';

/**
 * The inbox's visual vocabulary: which glyph and tone mark a row. Tones are
 * the design system's status tones; `neutral` is the default, so a row is
 * only coloured when its KIND says something about urgency. Activity rows are
 * always neutral: a stored notification's category names where it came from,
 * not whether anything went wrong, and its tone must not claim otherwise.
 */
export type InboxTone = 'caution' | 'negative' | 'active' | 'neutral';

interface InboxMark {
  Glyph: ComponentType<{ className?: string }>;
  tone: InboxTone;
}

export function attentionKindMark(kind: AttentionItem['kind']): InboxMark {
  switch (kind) {
    case 'approval':
      return { Glyph: ShieldGlyph, tone: 'caution' };
    case 'device-pairing':
      return { Glyph: PhoneGlyph, tone: 'caution' };
    case 'tool-request':
      return { Glyph: PlugGlyph, tone: 'caution' };
    case 'setup-incomplete':
      return { Glyph: SettingsGlyph, tone: 'caution' };
    case 'gate-route-back':
      return { Glyph: ReturnGlyph, tone: 'caution' };
    case 'gate-exception':
      return { Glyph: TargetGlyph, tone: 'caution' };
    case 'session-failed':
      return { Glyph: WarningGlyph, tone: 'negative' };
    case 'gate-blocked':
      return { Glyph: LockGlyph, tone: 'negative' };
    case 'needs_input':
      return { Glyph: MessageGlyph, tone: 'active' };
    case 'review_pending':
    case 'gate-review':
      return { Glyph: CheckGlyph, tone: 'active' };
    case 'proposed-change':
      return { Glyph: DiffGlyph, tone: 'active' };
    case 'plugin-lifecycle-proposal':
      return { Glyph: PlugGlyph, tone: 'active' };
  }
}

export function notificationMark(notification: Notification): InboxMark {
  switch (notification.category) {
    case 'approval-request':
      return { Glyph: ShieldGlyph, tone: 'neutral' };
    case 'pairing-request':
      return { Glyph: PhoneGlyph, tone: 'neutral' };
    default:
      return { Glyph: BellGlyph, tone: 'neutral' };
  }
}

/** The tinted glyph tile at the start of every inbox row. Decorative: the
 * row's kind label carries the same meaning as text. */
export function InboxMarkTile({ mark }: { mark: InboxMark }) {
  const { Glyph, tone } = mark;
  return (
    <span className={`inbox-mark inbox-mark--${tone}`} aria-hidden="true">
      <Glyph />
    </span>
  );
}

/**
 * The day an activity row belongs to, for the page's day groups. Local-time
 * calendar days, so "Yesterday" means what the reader's clock says.
 */
export function inboxDayLabel(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  const startOf = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Consecutive rows that share a day label, in their incoming order. */
export function groupByDay<T>(
  rows: readonly T[],
  timestampOf: (row: T) => string,
  now = new Date(),
): { label: string; rows: T[] }[] {
  const groups: { label: string; rows: T[] }[] = [];
  for (const row of rows) {
    const label = inboxDayLabel(timestampOf(row), now);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}
