import { useState } from 'react';
import { Button } from '../../components/Button';
import { ResponsiveSurfaceActions } from '../../components/ResponsiveDialogSurface';

/**
 * Shown when the plugin was scaffolded but no chat pane took the request to
 * open an authoring chat (for example, only a chat bound to another Project
 * is on screen). The opening message is kept here to copy, instead of being
 * dropped.
 */
export function AuthoringChatFallback({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  return (
    <div className="plugins__modal-body plugins__modal-body--visible plugins__new-plugin">
      <p className="plugins__new-plugin-error" role="alert">
        Chat couldn't open here. The plugin's files are in the Project folder;
        start a chat in this Project and paste this opening message.
      </p>
      <label className="editor-label" htmlFor="authoring-chat-fallback-message">
        Opening message
      </label>
      <textarea
        id="authoring-chat-fallback-message"
        className="editor-input plugins__new-plugin-primer"
        readOnly
        value={message}
        rows={8}
      />
      {copyState !== 'idle' && (
        <p className="plugins__install-hint" role="status">
          {copyState === 'copied'
            ? 'Copied.'
            : "Couldn't copy. Select the text above and copy it."}
        </p>
      )}
      <ResponsiveSurfaceActions className="plugins__confirm-actions">
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
        <Button variant="primary" onClick={() => void copy()}>
          Copy opening message
        </Button>
      </ResponsiveSurfaceActions>
    </div>
  );
}
