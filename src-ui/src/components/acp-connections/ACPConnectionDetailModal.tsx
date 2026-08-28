import { ENGINE_CAPABILITY_MATRICES } from '@kontourai/station-contracts/engine-capability-matrix';
import { useIntegrationsQuery } from '@kontourai/station-sdk';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { ACPConnectionInfo } from '../../hooks/useACPConnections';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { AgentSummary } from '../../types';
import { Checkbox } from '../Checkbox';
import { FolderGlyph } from '../icons/Glyph';
import { ResponsiveDialogSurface } from '../ResponsiveDialogSurface';
import { ConnectionIcon } from './ConnectionIcon';
import { EngineCapabilitySummary } from './EngineCapabilitySummary';
import { getACPConnectionStatusView } from './utils';

/** Order-insensitive id-set equality. */
function sameToolServerIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
}

export function ACPConnectionDetailModal({
  conn,
  agents,
  onClose,
  onUpdateToolServers,
  isUpdatingToolServers,
}: {
  conn: ACPConnectionInfo;
  agents: AgentSummary[];
  onClose: () => void;
  /**
   * Explicit per-agent opt-in (docs/design/connections-onboarding.md §5):
   * persist the connection's `provideToolServers` selection. Absent means
   * this surface can't mutate the toggle (falls back to read-only display).
   * May return a promise; internal serialization awaits it to detect
   * settlement (see the dispatch/reconcile logic below) rather than relying
   * on an externally-passed pending flag alone.
   */
  onUpdateToolServers?: (ids: string[]) => void | Promise<void>;
  /**
   * Optional external "a provideToolServers mutation is pending" signal —
   * OR'd into the disabled-while-sending UI affordance. Not load-bearing
   * for correctness: the dispatch/reconcile logic below is self-contained
   * and does not depend on this prop's timing (it can lag a render behind
   * the internal ref state).
   */
  isUpdatingToolServers?: boolean;
}) {
  const isMobile = useIsMobile();
  // Plugin-owned connections are projected from plugin configuration. The
  // connection update endpoint intentionally only persists user-owned
  // connections, so this detail view must never imply these controls can
  // change a plugin-owned connection.
  const isPluginManaged = conn.source === 'plugin';
  const canUpdateToolServers = !isPluginManaged && Boolean(onUpdateToolServers);
  const { isConnecting, statusLabel, statusColor } =
    getACPConnectionStatusView(conn);
  const { data: integrations = [] } = useIntegrationsQuery();
  // ACP can receive only local stdio MCP servers. Remote transports stay
  // Station-owned and are not offered in this external-engine picker.
  const stdioToolServers = integrations.filter(
    (integration) =>
      integration.kind === 'mcp' && integration.transport === 'stdio',
  );

  // Serialization : rapid toggles must never lose a
  // selection to a reversed-completion race. `desiredRef` is the
  // latest-wanted selection, updated synchronously on every toggle;
  // `lastSentRef` is what the most recent dispatch actually sent;
  // `inFlightRef` is true for the duration of exactly one dispatch. A toggle
  // while a dispatch is in flight only updates `desiredRef`/local state — it
  // does NOT fire a second overlapping call. When the in-flight dispatch
  // settles, it compares `desiredRef` against `lastSentRef` and, if they
  // differ (a toggle happened mid-flight), dispatches the delta once. This
  // is intentionally independent of the `isUpdatingToolServers` prop, which
  // can lag a render behind (it reflects a parent-owned mutation object).
  const [localToolServerIds, setLocalToolServerIds] = useState<string[]>(
    () => conn.provideToolServers ?? [],
  );
  const [sending, setSending] = useState(false);
  const [toolServerError, setToolServerError] = useState<string | null>(null);
  const desiredRef = useRef<string[]>(localToolServerIds);
  const lastSentRef = useRef<string[]>(localToolServerIds);
  const confirmedRef = useRef<string[]>(localToolServerIds);
  const inFlightRef = useRef(false);
  const prevConnIdRef = useRef(conn.id);

  useEffect(() => {
    if (prevConnIdRef.current !== conn.id) {
      // Switched to a different connection (the modal instance is reused
      // across selections) — reset all local/ref state from scratch.
      prevConnIdRef.current = conn.id;
      const next = conn.provideToolServers ?? [];
      desiredRef.current = next;
      lastSentRef.current = next;
      confirmedRef.current = next;
      inFlightRef.current = false;
      setSending(false);
      setToolServerError(null);
      setLocalToolServerIds(next);
      return;
    }
    // Same connection: only resync from the server echo when there is no
    // pending local edit (idle), so a confirmed server value can still
    // reconcile local state without clobbering an in-progress change.
    if (
      !inFlightRef.current &&
      sameToolServerIds(desiredRef.current, lastSentRef.current)
    ) {
      const serverIds = conn.provideToolServers ?? [];
      if (!sameToolServerIds(serverIds, desiredRef.current)) {
        desiredRef.current = serverIds;
        lastSentRef.current = serverIds;
        confirmedRef.current = serverIds;
        setLocalToolServerIds(serverIds);
      }
    }
  }, [conn.id, conn.provideToolServers]);

  const dispatchSelection = (next: string[]) => {
    if (!canUpdateToolServers || !onUpdateToolServers) return;
    inFlightRef.current = true;
    lastSentRef.current = next;
    setSending(true);
    setToolServerError(null);
    Promise.resolve(onUpdateToolServers(next))
      .then(() => {
        confirmedRef.current = next;
      })
      .catch(() => {
        const confirmed = confirmedRef.current;
        desiredRef.current = confirmed;
        lastSentRef.current = confirmed;
        setLocalToolServerIds(confirmed);
        setToolServerError(
          'Tool server choices could not be saved. Your previous choices were restored.',
        );
      })
      .finally(() => {
        inFlightRef.current = false;
        const desired = desiredRef.current;
        if (!sameToolServerIds(desired, lastSentRef.current)) {
          // A toggle landed while this dispatch was in flight — send the
          // reconciled delta once, rather than dropping it.
          dispatchSelection(desired);
          return;
        }
        setSending(false);
      });
  };

  const toggleToolServer = (id: string, checked: boolean) => {
    if (!canUpdateToolServers) return;
    const base = desiredRef.current;
    const next = checked
      ? [...new Set([...base, id])]
      : base.filter((existing) => existing !== id);
    desiredRef.current = next;
    setLocalToolServerIds(next);
    if (inFlightRef.current) {
      // A dispatch is already in flight; its settle handler will notice
      // `desiredRef` moved and send this update once that one resolves.
      return;
    }
    dispatchSelection(next);
  };

  const sectionLabel: CSSProperties = {
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '8px',
  };

  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabel={`${conn.name} connection details`}
      overlayStyle={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      panelStyle={{
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-primary)',
        borderRadius: '12px',
        width: isMobile ? '94%' : '90%',
        maxWidth: '600px',
        maxHeight: isMobile ? '90vh' : '80vh',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '20px',
          borderBottom: '1px solid var(--border-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <ConnectionIcon
          icon={conn.icon}
          name={conn.name}
          id={conn.id}
          size={32}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '18px', fontWeight: 600 }}>{conn.name}</div>
        </div>
        <span
          className="acp-badge"
          style={{
            fontSize: '12px',
            padding: '4px 10px',
            background: `color-mix(in srgb, ${statusColor} 12%, transparent)`,
            color: statusColor,
          }}
        >
          <span
            className={`acp-badge__dot${isConnecting ? ' acp-badge__dot--pulse' : ''}`}
            style={{ background: statusColor }}
          />
          {statusLabel}
        </span>
      </div>

      <div
        style={{
          padding: '20px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
        }}
      >
        <div className="provider-detail__summary">
          <div>
            <span className="provider-detail__summary-label">Status</span>
            <strong>{statusLabel}</strong>
          </div>
          <div>
            <span className="provider-detail__summary-label">Agents</span>
            <strong>{agents.length}</strong>
          </div>
          <div>
            <span className="provider-detail__summary-label">Commands</span>
            <strong>{conn.slashCommands?.length ?? 0}</strong>
          </div>
        </div>

        {/* archive#3722: the two-row capability description, derived
            from the engine capability matrix. Custom engines all resolve
            through the 'acp' matrix — per-connection capability discovery is
            the issue's remaining scope. */}
        <EngineCapabilitySummary
          matrix={ENGINE_CAPABILITY_MATRICES.acp}
          connectionName={conn.name || conn.id}
        />

        <details className="provider-detail__advanced">
          <summary>Advanced</summary>
          <div className="provider-detail__advanced-fields">
            <div>
              <div style={sectionLabel}>Connection ID</div>
              <code className="provider-detail__code">{conn.id}</code>
            </div>
            <div>
              <div style={sectionLabel}>Command</div>
              <code
                style={{
                  fontSize: '13px',
                  color: 'var(--text-primary)',
                  background: 'var(--bg-tertiary)',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  display: 'block',
                  fontFamily: 'monospace',
                  overflowWrap: 'anywhere',
                }}
              >
                {conn.command} {(conn.args || []).join(' ')}
              </code>
              {conn.cwd && (
                <div
                  style={{
                    fontSize: '12px',
                    color: 'var(--text-muted)',
                    marginTop: '4px',
                  }}
                >
                  <FolderGlyph /> {conn.cwd}
                </div>
              )}
            </div>

            <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend style={{ ...sectionLabel, padding: 0 }}>
                Tool servers (MCP passthrough)
              </legend>
              <div
                style={{
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  marginBottom: '8px',
                }}
              >
                {isPluginManaged
                  ? 'This connection is managed by its plugin. Tool server choices are read-only here.'
                  : "Off by default. Checking a tool server passes it through to this engine's sessions as an MCP server it can call directly."}
              </div>
              {toolServerError && (
                <div role="alert" className="form-error">
                  {toolServerError}
                </div>
              )}
              {stdioToolServers.length === 0 ? (
                <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                  No stdio tool servers installed yet — install one from the
                  Registry.
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  {stdioToolServers.map((toolServer) => {
                    const disabledForSecrets = Boolean(
                      toolServer.requiresEnvSecrets,
                    );
                    return (
                      <div key={toolServer.id}>
                        <Checkbox
                          id={`acp-tool-server-${conn.id}-${toolServer.id}`}
                          checked={localToolServerIds.includes(toolServer.id)}
                          disabled={
                            !canUpdateToolServers ||
                            sending ||
                            Boolean(isUpdatingToolServers) ||
                            disabledForSecrets
                          }
                          onChange={(checked) =>
                            toggleToolServer(toolServer.id, checked)
                          }
                        >
                          {toolServer.displayName || toolServer.id}
                        </Checkbox>
                        {disabledForSecrets && (
                          <div
                            style={{
                              fontSize: '11px',
                              color: 'var(--text-muted)',
                              marginLeft: '28px',
                            }}
                          >
                            Requires environment secrets — not shared with
                            external engines.
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </fieldset>

            {agents.length > 0 && (
              <div>
                <div style={sectionLabel}>Agents ({agents.length})</div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  {agents.map((agent) => (
                    <div
                      key={agent.slug}
                      style={{
                        fontSize: '13px',
                        padding: '8px 10px',
                        borderRadius: '6px',
                        background: 'var(--bg-tertiary)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: isMobile ? 'column' : 'row',
                          justifyContent: 'space-between',
                          alignItems: isMobile ? 'flex-start' : 'center',
                          gap: isMobile ? '2px' : '8px',
                        }}
                      >
                        <span style={{ fontWeight: 500, minWidth: 0 }}>
                          {agent.name}
                        </span>
                        <span
                          style={{
                            color: 'var(--text-muted)',
                            fontFamily: 'monospace',
                            fontSize: '11px',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {agent.slug}
                        </span>
                      </div>
                      {agent.description && (
                        <div
                          style={{
                            fontSize: '12px',
                            color: 'var(--text-muted)',
                            marginTop: '4px',
                          }}
                        >
                          {agent.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {conn.configOptions && conn.configOptions.length > 0 && (
              <div>
                <div style={sectionLabel}>Configuration</div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                >
                  {conn.configOptions.map((opt, index) => (
                    <div
                      key={index}
                      style={{
                        fontSize: '13px',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        background: 'var(--bg-tertiary)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '8px',
                      }}
                    >
                      <span
                        style={{ color: 'var(--text-secondary)', minWidth: 0 }}
                      >
                        {opt.category}
                      </span>
                      <span
                        style={{
                          fontFamily: 'monospace',
                          fontSize: '12px',
                          overflowWrap: 'anywhere',
                          textAlign: 'right',
                        }}
                      >
                        {opt.currentValue || '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {conn.slashCommands && conn.slashCommands.length > 0 && (
              <div>
                <div style={sectionLabel}>
                  Native Commands ({conn.slashCommands.length})
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  {conn.slashCommands.map((command) => (
                    <div
                      key={command.name}
                      style={{
                        fontSize: '13px',
                        padding: '8px 10px',
                        borderRadius: '6px',
                        background: 'var(--bg-tertiary)',
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>
                        {command.name.startsWith('/')
                          ? command.name
                          : `/${command.name}`}
                      </div>
                      {command.description && (
                        <div
                          style={{
                            fontSize: '12px',
                            color: 'var(--text-muted)',
                            marginTop: '4px',
                          }}
                        >
                          {command.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {conn.sessionId && (
              <div>
                <div style={sectionLabel}>Session</div>
                <code
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    fontFamily: 'monospace',
                    overflowWrap: 'anywhere',
                    display: 'block',
                  }}
                >
                  {conn.sessionId}
                </code>
              </div>
            )}
          </div>
        </details>
      </div>

      <div
        style={{
          padding: '16px 20px',
          borderTop: '1px solid var(--border-primary)',
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <button
          type="button"
          className="button button--secondary"
          onClick={onClose}
          style={isMobile ? { minHeight: '44px', flex: 1 } : undefined}
        >
          Close
        </button>
      </div>
    </ResponsiveDialogSurface>
  );
}
