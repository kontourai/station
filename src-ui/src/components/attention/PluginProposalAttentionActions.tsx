import type { PluginLifecycleProposalAttentionItem } from '@kontourai/station-sdk';
import { useDismissPluginLifecycleProposalMutation } from '@kontourai/station-sdk';
import { PluginProposalSummary } from '../plugins/PluginProposalSummary';

/**
 * #2323 S5: an agent proposed installing, updating or removing a plugin.
 *
 * Nothing on this row decides the change. "Open in Plugins" lands on the
 * ordinary flow — the install preview with its consent, or the update or
 * remove confirmation — and that is where the person decides. Dismiss closes
 * the proposal through `POST /api/plugin-proposals/:id/dismiss`, the one
 * resolution besides completing it.
 *
 * Loaded on demand from `AttentionCard`, so the proposal summary and its
 * formatting helpers stay off the first paint.
 */
export function PluginProposalAttentionActions({
  item,
}: {
  item: PluginLifecycleProposalAttentionItem;
}) {
  const dismiss = useDismissPluginLifecycleProposalMutation();
  return (
    <>
      <div className="attention-item__detail">
        <PluginProposalSummary
          author={item.author}
          source={item.pluginSource}
          pluginName={item.pluginName}
          rationale={item.rationale}
          testId="attention-plugin-proposal"
        />
      </div>
      <div className="attention-item__actions">
        <a
          className="attention-item__action attention-item__action--primary"
          href={item.openHref}
        >
          Open in Plugins
        </a>
        <button
          type="button"
          className="attention-item__action attention-item__action--ghost"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate(item.source.proposalId)}
        >
          Dismiss
        </button>
      </div>
      {dismiss.error != null ? (
        <p className="attention-error" role="alert">
          {dismiss.error instanceof Error
            ? dismiss.error.message
            : 'Unable to update inbox item.'}
        </p>
      ) : null}
    </>
  );
}
