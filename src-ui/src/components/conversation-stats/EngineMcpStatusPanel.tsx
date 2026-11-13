import { type SemanticTone, StatusBadge } from '@kontourai/ui/react';
import type { ChatEngineMcpServer } from '../../contexts/active-chats-state';
import { Button } from '../Button';
import './EngineMcpStatusPanel.css';

/** Ask the engine to restart one of its MCP servers; `startOAuth` begins a sign-in. */
export type EngineMcpReconnect = (
  serverName: string,
  options: { startOAuth: boolean },
) => void;

const STATE_LABEL: Record<ChatEngineMcpServer['state'], string> = {
  starting: 'Starting',
  ready: 'Ready',
  failed: 'Failed',
  'needs-auth': 'Sign-in needed',
  disabled: 'Disabled',
};

const STATE_TONE: Record<ChatEngineMcpServer['state'], SemanticTone> = {
  starting: 'active',
  ready: 'positive',
  failed: 'negative',
  'needs-auth': 'caution',
  disabled: 'neutral',
};

interface EngineMcpStatusPanelProps {
  servers: readonly ChatEngineMcpServer[];
  /** Absent when this session's engine has no reconnect; no button is shown. */
  onReconnect?: EngineMcpReconnect;
  /** The server a reconnect is in flight for; its button is disabled. */
  pendingServer?: string;
  /** What the last reconnect came to, in words; absent before any. */
  notice?: string;
}

/**
 * The MCP servers the ENGINE reports for this session (`engine-mcp.status`),
 * with a Sign in / Reconnect action where the engine supports one. A failed
 * server's sign-in link is never shown: the engine reports it after its
 * callback listener closed, so Sign in asks the engine to start a new one.
 */
export function EngineMcpStatusPanel({
  servers,
  onReconnect,
  pendingServer,
  notice,
}: EngineMcpStatusPanelProps) {
  if (servers.length === 0) return null;
  return (
    <section
      className="engine-mcp-status"
      aria-labelledby="engine-mcp-status-title"
    >
      <h4 id="engine-mcp-status-title" className="engine-mcp-status__title">
        Engine MCP servers
      </h4>
      <ul className="engine-mcp-status__list">
        {servers.map((server) => {
          const action =
            server.state === 'needs-auth'
              ? { label: 'Sign in', startOAuth: true }
              : server.state === 'failed'
                ? { label: 'Reconnect', startOAuth: false }
                : undefined;
          return (
            <li key={server.name} className="engine-mcp-status__row">
              <div className="engine-mcp-status__identity">
                <span className="engine-mcp-status__name">{server.name}</span>
                <StatusBadge
                  status={STATE_LABEL[server.state]}
                  tone={STATE_TONE[server.state]}
                />
                {server.toolCount !== undefined && server.state === 'ready' ? (
                  <span className="engine-mcp-status__meta">
                    {server.toolCount === 1
                      ? '1 tool'
                      : `${server.toolCount} tools`}
                  </span>
                ) : null}
              </div>
              {action && onReconnect ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pendingServer === server.name}
                  aria-label={`${action.label}: ${server.name}`}
                  onClick={() =>
                    onReconnect(server.name, { startOAuth: action.startOAuth })
                  }
                >
                  {action.label}
                </Button>
              ) : null}
              {server.error ? (
                <p className="engine-mcp-status__error">{server.error}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {notice ? (
        <p className="engine-mcp-status__notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
