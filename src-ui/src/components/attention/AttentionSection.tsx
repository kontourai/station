import type {
  AttentionItem,
  AttentionSourceUnavailable,
} from '@kontourai/station-sdk';
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
/**
 * Names each gap with the source's OWN reported reason, never a rewording:
 * the remedy for an unreadable workspace differs from the remedy for an
 * unreadable session file, and a single "some things failed" sentence sends
 * the operator nowhere.
 */
function unavailableSourcesNotice(
  sources: readonly AttentionSourceUnavailable[],
): string {
  const detail = sources
    .map((entry) =>
      entry.projectSlug
        ? `${entry.projectSlug} (${entry.reason})`
        : entry.reason,
    )
    .join(', ');
  return `Some work needing you could not be read, so this list may be incomplete: ${detail}.`;
}

export function AttentionSection({
  items,
  pendingTotal,
  pendingVisible,
  filtered = false,
  focusedApprovalId,
  unavailableSources = [],
}: {
  items: AttentionItem[];
  pendingTotal: number;
  pendingVisible: number;
  filtered?: boolean;
  focusedApprovalId?: string;
  /**
   * #2064 review (c): sources this read could not fully cover. Rendered
   * whether or not there are items — a partial read under a populated list is
   * the same absence-as-success failure, one level down, and the empty state
   * below would otherwise say "Nothing needs you right now" on evidence it
   * does not have.
   */
  unavailableSources?: readonly AttentionSourceUnavailable[];
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
      {unavailableSources.length > 0 ? (
        <p role="alert">{unavailableSourcesNotice(unavailableSources)}</p>
      ) : null}
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
