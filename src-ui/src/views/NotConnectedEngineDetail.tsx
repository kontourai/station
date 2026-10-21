import { useDeleteACPConnectionMutation } from '@kontourai/station-sdk';
import { useState } from 'react';
import { ACPConnectionSetupPanel } from '../components/acp-connections/ACPConnectionSetupPanel';
import { ConnectionIcon } from '../components/acp-connections/ConnectionIcon';
import { useACPConnectionSetupOwner } from '../components/acp-connections/useACPConnectionSetupOwner';
import { useStartChatWithEngine } from '../components/acp-connections/useStartChatWithEngine';
import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import { DetailHeader } from '../components/DetailHeader';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import type { NotConnectedEngine } from './EngineAddFlow';

/**
 * A saved engine that never connected (a failed first add), on the Engines
 * page. It is not an engine Station has yet, so its only actions are the
 * repairs: check it again, edit a custom one's setup, or remove it. A check
 * or an edit runs in place and ends on the same result the add flow shows.
 */
export function NotConnectedEngineDetail({
  engine,
  repairing,
  onRepairingChange,
  onRemoved,
}: {
  engine: NotConnectedEngine;
  /** A check or edit is open; the owner keeps this page while it runs. */
  repairing: 'recheck' | 'edit' | null;
  onRepairingChange: (mode: 'recheck' | 'edit' | null) => void;
  onRemoved: () => void;
}) {
  const { connection, custom } = engine;
  const owner = useACPConnectionSetupOwner();
  const startChat = useStartChatWithEngine();
  const remove = useDeleteACPConnectionMutation();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  if (repairing) {
    return (
      <>
        <ACPConnectionSetupPanel
          key={repairing}
          {...owner}
          editConnection={connection}
          recheck={repairing === 'recheck'}
          editable={custom}
          onDone={() => onRepairingChange(null)}
          onStartChat={(result) => void startChat.start(result.id, result.name)}
          startChatPending={startChat.pending}
        />
        {startChat.notice ? (
          <p className="editor-help engine-setup__notice" role="status">
            {startChat.notice}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="editor-layout">
      <DetailHeader
        title={connection.name}
        icon={
          <ConnectionIcon
            icon={connection.icon}
            name={connection.name}
            id={connection.id}
            size={28}
          />
        }
        badge={{ label: 'Not connected yet', variant: 'warning' }}
      />
      <div className="agent-editor__section">
        <div className="acp-add-dialog__result" role="status">
          <strong>Not connected yet</strong>
          <span>
            Station saved this engine but has not connected to it. Its Agent is
            added once it connects.
          </span>
          {connection.lastError ? (
            <span className="acp-add-dialog__result-reason">
              {connection.lastError.message}
            </span>
          ) : null}
        </div>
        {/* Sign-in slot (engine sign-in lane): an account panel for this
            engine mounts here, beside the reason it did not connect. */}
        <ActionRow
          className="engine-setup__actions"
          overflowLabel={`Manage ${connection.name}`}
          primary={
            <Button
              variant="primary"
              onClick={() => onRepairingChange('recheck')}
            >
              Retry check
            </Button>
          }
          secondary={
            custom ? (
              <Button onClick={() => onRepairingChange('edit')}>
                Edit setup
              </Button>
            ) : undefined
          }
          overflow={[
            {
              key: 'remove',
              label: 'Remove',
              tone: 'danger',
              onSelect: () => setConfirmRemove(true),
            },
          ]}
        />
        {removeError ? <p className="editor-error">{removeError}</p> : null}
      </div>
      <ConfirmModal
        isOpen={confirmRemove}
        title="Remove engine"
        message={`Remove "${connection.name}"? This deletes its saved setup.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setConfirmRemove(false);
          setRemoveError(null);
          remove
            .mutateAsync(connection.id)
            .then(onRemoved, (error: unknown) =>
              setRemoveError(
                error instanceof Error ? error.message : String(error),
              ),
            );
        }}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
