import type { PluginLifecycleProposal } from '@kontourai/station-contracts/plugin';
import { PluginProposalSummary } from '../../components/plugins/PluginProposalSummary';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import '../PluginManagementView.css';

/**
 * The one question Station asks before removing an installed plugin, wherever
 * the Remove is pressed: Apps › Library and the Added cards in Apps › Discover.
 */
export function RemovePluginModal({
  name,
  retainsData = false,
  proposal = null,
  onCancel,
  onConfirm,
}: {
  /** What the person sees named in the question. */
  name: string;
  /** The plugin keeps its stored data and code versions after removal. */
  retainsData?: boolean;
  /** An agent's removal proposal being completed, shown for provenance. */
  proposal?: PluginLifecycleProposal | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onCancel}
      ariaLabelledBy="remove-plugin-title"
      overlayClassName="plugins__confirm-overlay"
      panelClassName="plugins__confirm"
    >
      <h3 id="remove-plugin-title">Remove plugin</h3>
      <p>
        Remove &ldquo;{name}&rdquo; from Station?
        {retainsData
          ? ' Its stored data and code versions will be retained.'
          : ' This cannot be undone.'}
      </p>
      {proposal?.kind === 'remove' && proposal.pluginName === name && (
        <PluginProposalSummary
          author={proposal.author}
          rationale={proposal.rationale}
          testId="remove-plugin-proposal"
        />
      )}
      <ResponsiveSurfaceActions className="plugins__confirm-actions">
        <button
          type="button"
          className="plugins__confirm-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="plugins__confirm-delete"
          onClick={onConfirm}
        >
          Remove
        </button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>
  );
}
