import { monitoringAgentName } from '@shared/monitoring-keys';
import type {
  MonitoringEvent,
  MonitoringStats,
} from '../../contexts/MonitoringContext';
import { type ActivateEvent, activatable } from '../../utils/activatable';
import { getAgentColor } from '../monitoring-utils';
import {
  getHistoricalAgentSlugs,
  getMonitoringAgentCountLabel,
  getRunningConversations,
} from './view-utils';

function formatAgentStatusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function MonitoringSidebar({
  stats,
  events,
  filteredEvents,
  selectedAgents,
  onAgentClick,
  onConversationClick,
  resolveModelName,
}: {
  stats: MonitoringStats | null;
  events: MonitoringEvent[];
  filteredEvents: MonitoringEvent[];
  selectedAgents: string[];
  onAgentClick: (agentSlug: string, event: ActivateEvent) => void;
  onConversationClick: (conversationId: string, agentSlug: string) => void;
  resolveModelName: (modelId: string) => string;
}) {
  const activeAgents = stats?.agents || [];
  const historicalSlugs = getHistoricalAgentSlugs(filteredEvents, activeAgents);

  return (
    <div className="monitoring-sidebar">
      <div className="sidebar-header">
        <h3>Agents</h3>
        <span className="agent-count">
          {getMonitoringAgentCountLabel(stats, filteredEvents)}
        </span>
      </div>

      <div className="agent-list">
        {activeAgents.map((agent) => {
          const runningConversations = getRunningConversations(
            events,
            agent.slug,
          );
          const isSelected = selectedAgents.includes(agent.slug);
          const agentColor = getAgentColor(agent.slug);

          return (
            // The card itself must NOT be a button: it contains the
            // conversation controls below, and a button's descendants are
            // flattened to presentational in accessibility APIs — a screen
            // reader user would never discover "Active Chats" inside it
            //  The card stays a mouse
            // convenience surface for the whole area; the real keyboard
            // control is the agent-header row, a SIBLING of the
            // conversation list.
            // biome-ignore lint/a11y/noStaticElementInteractions: mouse convenience surface; the keyboard control is the agent-header row inside.
            // biome-ignore lint/a11y/useKeyWithClickEvents: same — the agent-header row carries the keyboard path.
            <div
              key={agent.slug}
              className={`agent-card status-${agent.status} ${isSelected ? 'selected' : ''}`}
              onClick={(event) => onAgentClick(agent.slug, event)}
              style={{
                borderLeftColor: agentColor,
                background: isSelected
                  ? `color-mix(in srgb, ${agentColor} 10%, var(--bg-secondary))`
                  : undefined,
              }}
            >
              <div
                className="agent-header"
                {...activatable((event) => {
                  // The card's own onClick above covers the mouse; without
                  // this a click here would select the agent twice (toggling
                  // it straight back off).
                  event.stopPropagation();
                  onAgentClick(agent.slug, event);
                })}
              >
                <span className="agent-name">
                  <span
                    className={`health-dot ${agent.healthy === false ? 'unhealthy' : agent.healthy === true ? 'healthy' : 'unknown'}`}
                    title={
                      agent.healthy === false
                        ? 'Unhealthy'
                        : agent.healthy === true
                          ? 'Healthy'
                          : 'Status unknown'
                    }
                  ></span>
                  {agent.name}
                </span>
                <span className={`agent-status ${agent.status}`}>
                  {formatAgentStatusLabel(agent.status)}
                </span>
              </div>

              {agent.status === 'running' &&
                runningConversations.length > 0 && (
                  <div className="running-conversations">
                    <div className="conversations-label">Active Chats</div>
                    {runningConversations.map((conversation) => (
                      <div
                        key={conversation.id}
                        className="conversation-item"
                        style={{ borderLeftColor: conversation.color }}
                        {...activatable((event) => {
                          // Nested inside the agent card: without this,
                          // choosing a conversation also reselects the agent.
                          event.stopPropagation();
                          onConversationClick(conversation.id, agent.slug);
                        })}
                      >
                        <span className="conversation-id">
                          {conversation.id.split(':').pop()?.substring(0, 8)}...
                        </span>
                      </div>
                    ))}
                  </div>
                )}

              <div className="agent-meta">
                <div className="meta-item">
                  <span className="meta-label">Model:</span>
                  <span className="meta-value">
                    {resolveModelName(agent.model)}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Messages:</span>
                  <span className="meta-value">{agent.messageCount}</span>
                </div>
              </div>
            </div>
          );
        })}

        {historicalSlugs.length > 0 && (
          <>
            <div className="agent-historical-header">Historical</div>
            {historicalSlugs.map((slug) => {
              // Count through the SAME naming rule the list was built with.
              // Comparing the raw field to a derived name meant the
              // '(unnamed)' card reported 0 events and then filtered to N —
              // a number contradicting what selecting it produced, which is
              // exactly the label-vs-derivation defect this work is about.
              const eventCount = filteredEvents.filter(
                (event) =>
                  monitoringAgentName(event as Record<string, unknown>) ===
                  slug,
              ).length;
              const isSelected = selectedAgents.includes(slug);
              const agentColor = getAgentColor(slug);

              return (
                // Same structure as the running card above: card = mouse
                // convenience, header row = the keyboard control. This card
                // has no interactive descendants, but the shared shape keeps
                // its meta rows readable as text instead of flattened into
                // one long button label.
                // biome-ignore lint/a11y/noStaticElementInteractions: mouse convenience surface; the keyboard control is the agent-header row inside.
                // biome-ignore lint/a11y/useKeyWithClickEvents: same — the agent-header row carries the keyboard path.
                <div
                  key={slug}
                  className={`agent-card historical ${isSelected ? 'selected' : ''}`}
                  onClick={(event) => onAgentClick(slug, event)}
                  style={{
                    borderLeftColor: agentColor,
                    background: isSelected
                      ? `color-mix(in srgb, ${agentColor} 10%, var(--bg-secondary))`
                      : undefined,
                  }}
                >
                  <div
                    className="agent-header"
                    {...activatable((event) => {
                      event.stopPropagation();
                      onAgentClick(slug, event);
                    })}
                  >
                    <span className="agent-name">{slug}</span>
                    <span className="agent-status historical-status">
                      Historical
                    </span>
                  </div>
                  <div className="agent-meta">
                    <div className="meta-item">
                      <span className="meta-label">Events:</span>
                      <span className="meta-value">{eventCount}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
