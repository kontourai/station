/**
 * Human labels for notification categories and attention kinds.  Categories
 * arrive from distinct server projections, so this is deliberately the one
 * presentation map rather than two almost-identical local switches.
 */
const NOTIFICATION_LABELS: Readonly<Record<string, string>> = {
  approval: 'Approval request',
  'approval-request': 'Approval request',
  needs_input: 'Input needed',
  review_pending: 'Review pending',
  'session-failed': 'Session failed',
  'gate-route-back': 'Route back',
  'gate-blocked': 'Gate blocked',
  'gate-exception': 'Exception pending',
  // The attention kind and the notification category for the same fact
  // (#765 D5) — one map so the two surfaces cannot drift.
  'device-pairing': 'Device pairing',
  'pairing-request': 'Device pairing',
  // #1536 D8: Station's own Agent cannot run yet.
  'setup-incomplete': 'Setup incomplete',
  // #2064 D4: the two kinds Review used to own alone. Verdict vocabulary
  // applies here too — a proposed change is DECIDED (approve/reject), a gate
  // review is READ, and neither is an "approval request".
  'proposed-change': 'Change pending',
  'gate-review': 'Gate review',
};

export function notificationCategoryLabel(category: string): string {
  return (
    NOTIFICATION_LABELS[category] ??
    category
      .replaceAll(/[-_]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}
