import { useState } from 'react';
import type { ACPConnectionInfo } from '../../hooks/useACPConnections';
import type { AgentSummary } from '../../types';
import { FolderGlyph } from '../icons/Glyph';
import { ConfirmModal } from '../modals/ConfirmModal';
import { ConnectionIcon } from './ConnectionIcon';
import { getACPConnectionStatusView } from './utils';
import './ACPConnections.css';

export function ACPConnectionCard({
  conn,
  agents,
  onClick,
  onToggle,
  onRemove,
  onReconnect,
}: {
  conn: ACPConnectionInfo;
  agents: AgentSummary[];
  onClick: () => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onReconnect: () => void;
}) {
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const {
    isConnected,
    isConnecting,
    isPlugin,
    statusLabel,
    statusTone,
    recommendedAction,
  } = getACPConnectionStatusView(conn);

  return (
    <div className={`acp-connection-card acp-connection-card--${statusTone}`}>
      <button
        type="button"
        className="acp-connection-card__open"
        onClick={onClick}
        aria-label={`Open ${conn.name} connection details`}
      >
        <div className="acp-connection-card__header">
          <div className="acp-connection-card__identity">
            <ConnectionIcon
              icon={conn.icon}
              name={conn.name}
              id={conn.id}
              size={32}
            />
            <div className="acp-connection-card__name-group">
              <div className="acp-connection-card__name-row">
                <span className="acp-connection-card__name">{conn.name}</span>
                {isPlugin && (
                  <span className="acp-connection-card__plugin-badge">
                    Provided by plugin
                  </span>
                )}
              </div>
              <span className="acp-connection-card__summary">
                {isPlugin
                  ? 'Managed by its plugin.'
                  : 'Configured custom engine — it runs its own tools and Station relays your chats to it.'}
              </span>
            </div>
          </div>
          <span
            className={`acp-connection-card__status acp-connection-card__status--${statusTone}`}
            role="status"
            aria-label={`Readiness: ${statusLabel}`}
          >
            <span
              className={`acp-connection-card__status-dot${isConnecting ? ' acp-connection-card__status-dot--pulse' : ''}`}
            />
            {statusLabel}
          </span>
        </div>
      </button>

      <details className="acp-connection-card__advanced">
        <summary>Advanced</summary>
        <div className="acp-connection-card__advanced-content">
          <div className="acp-connection-card__advanced-field">
            <span>Command</span>
            <code>
              {conn.command} {(conn.args || []).join(' ')}
            </code>
          </div>
          {conn.cwd && (
            <div className="acp-connection-card__advanced-field">
              <span>Working directory</span>
              <code>
                <FolderGlyph /> {conn.cwd}
              </code>
            </div>
          )}
        </div>
      </details>

      {isConnected && agents.length > 0 && (
        <div className="acp-connection-card__agents">
          <div className="acp-connection-card__agents-label">
            {agents.length} agents
          </div>
          <div className="acp-connection-card__agent-list">
            {agents.slice(0, 8).map((agent) => (
              <span key={agent.slug} className="acp-connection-card__agent">
                {agent.name}
              </span>
            ))}
            {agents.length > 8 && (
              <span className="acp-connection-card__agent-more">
                +{agents.length - 8} more
              </span>
            )}
          </div>
        </div>
      )}

      <div className="acp-connection-card__actions">
        {!isPlugin && conn.enabled && (
          <button
            type="button"
            className="button button--small button--success"
            onClick={(e) => {
              e.stopPropagation();
              setShowDisableConfirm(true);
            }}
          >
            Disable
          </button>
        )}
        {!isPlugin && recommendedAction === 'Enable' && (
          <button
            type="button"
            className="button button--small button--secondary"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(true);
            }}
          >
            Enable
          </button>
        )}
        {!isPlugin && recommendedAction === 'Reconnect' && conn.enabled && (
          <button
            type="button"
            className="button button--small button--secondary"
            onClick={(e) => {
              e.stopPropagation();
              onReconnect();
            }}
          >
            Reconnect
          </button>
        )}
        <div className="acp-connection-card__actions-spacer" />
        {!isPlugin && (
          <button
            type="button"
            className="button button--small button--danger-outline"
            onClick={(e) => {
              e.stopPropagation();
              setShowRemoveConfirm(true);
            }}
          >
            Remove
          </button>
        )}
      </div>
      <ConfirmModal
        isOpen={showDisableConfirm}
        title="Disable Connection"
        message={`Disable "${conn.name}"? This will disconnect the engine session and its agents will become unavailable.`}
        confirmLabel="Disable"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setShowDisableConfirm(false);
          onToggle(false);
        }}
        onCancel={() => setShowDisableConfirm(false)}
      />
      <ConfirmModal
        isOpen={showRemoveConfirm}
        title="Remove Connection"
        message={`Remove "${conn.name}"? This will permanently delete the connection configuration.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setShowRemoveConfirm(false);
          onRemove();
        }}
        onCancel={() => setShowRemoveConfirm(false)}
      />
    </div>
  );
}
