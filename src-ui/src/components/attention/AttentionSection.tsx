import type { AttentionItem } from '@kontourai/station-sdk';
import { attentionCountLabel } from '../../utils/attention';
import { Empty } from '../state';
import { AttentionCard } from './AttentionCard';

/**
 * archive#3214: the heading takes BOTH counts, never one number whose meaning
 * depends on `filtered`. `pendingTotal` is the bell badge's own number
 * (`AttentionProjection.pendingCount`); `pendingVisible` is how many of those
 * survive the page's history filters. `attentionCountLabel` decides which of
 * them the label may honestly show.
 */
export function AttentionSection({
  items,
  pendingTotal,
  pendingVisible,
  filtered = false,
  focusedApprovalId,
}: {
  items: AttentionItem[];
  pendingTotal: number;
  pendingVisible: number;
  filtered?: boolean;
  focusedApprovalId?: string;
}) {
  const countLabel = attentionCountLabel({
    // This page narrows by its history filters; the tray narrows by
    // truncation. `attentionCountLabel` names the fact, not the mechanism.
    narrowed: filtered,
    pendingTotal,
    pendingVisible,
  });
  return (
    <section aria-labelledby="attention-heading">
      <h2 id="attention-heading" className="notifications-page__section-title">
        Needs attention {countLabel ? `(${countLabel})` : ''}
      </h2>
      {items.length === 0 ? (
        <Empty
          variant="compact"
          label={
            filtered ? 'No matching attention' : 'Nothing needs you right now'
          }
          description={
            filtered
              ? 'Try changing or clearing the history filters.'
              : 'Approvals, failures, and other work needing you appear here.'
          }
        />
      ) : (
        <div className="notifications-page__list">
          {items.map((item) => (
            <AttentionCard
              key={item.id}
              item={item}
              focused={
                item.kind === 'approval' &&
                item.source.notificationId === focusedApprovalId
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
