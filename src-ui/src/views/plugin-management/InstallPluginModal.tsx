import type { PluginLifecycleProposal } from '@kontourai/station-contracts/plugin';
import { FolderGlyph } from '../../components/icons/Glyph';
import { PathAutocomplete } from '../../components/PathAutocomplete';
import { PluginProposalSummary } from '../../components/plugins/PluginProposalSummary';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../../components/ResponsiveDialogSurface';

export function InstallPluginModal({
  installSource,
  installMessage,
  installPending,
  previewPending,
  onChangeSource,
  onBrowse,
  onInstall,
  onClose,
  proposal = null,
}: {
  /** #2323 S5: the proposal this install came from, when it did. */
  proposal?: PluginLifecycleProposal | null;
  installSource: string;
  installMessage: { type: 'success' | 'error'; text: string } | null;
  installPending: boolean;
  previewPending: boolean;
  onChangeSource: (value: string) => void;
  onBrowse: () => void;
  onInstall: () => void;
  onClose: () => void;
}) {
  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onClose}
      ariaLabelledBy="install-plugin-title"
      overlayClassName="plugins__modal-overlay"
      panelClassName="plugins__modal plugins__modal--install"
    >
      <div className="plugins__modal-header">
        <h3 id="install-plugin-title" className="plugins__modal-title">
          Install Plugin
        </h3>
        <ResponsiveDialogCloseButton
          onClick={onClose}
          label="Close install plugin"
        />
      </div>
      <div className="plugins__modal-body plugins__modal-body--visible">
        {installMessage && (
          <div
            className={`plugins__modal-message plugins__message--${installMessage.type}`}
          >
            {installMessage.text}
          </div>
        )}
        <div className="plugins__install plugins__install--modal">
          <span className="plugins__install-prefix">$</span>
          <PathAutocomplete
            className="plugins__install-input"
            value={installSource}
            onChange={onChangeSource}
            onSubmit={onInstall}
            placeholder="git@github.com:org/plugin.git or /local/path"
            disabled={installPending}
          />
          <button
            type="button"
            className="plugins__browse-btn"
            onClick={onBrowse}
            disabled={installPending}
            title="Browse local folders"
            aria-label="Browse local plugin folders"
          >
            <FolderGlyph />
          </button>
          <button
            type="button"
            className="plugins__install-btn"
            onClick={onInstall}
            disabled={installPending || previewPending || !installSource.trim()}
          >
            {installPending
              ? 'Installing...'
              : previewPending
                ? 'Validating...'
                : 'Install'}
          </button>
        </div>
        {proposal ? (
          <div
            className="plugins__install-hint"
            data-testid="install-plugin-proposal"
          >
            <PluginProposalSummary
              author={proposal.author}
              source={proposal.source}
              rationale={proposal.rationale}
              testId="install-plugin-proposal-summary"
            />
            <p>
              Install previews it first; nothing is installed until you confirm.
            </p>
          </div>
        ) : (
          <p className="plugins__install-hint">
            Paste a git URL or local path to a Station plugin.
          </p>
        )}
      </div>
    </ResponsiveDialogSurface>
  );
}
