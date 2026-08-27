import { AgentIcon } from '../icons/AgentIcon';
import { AgentGlyph, TargetGlyph } from '../icons/Glyph';
import { Empty } from '../state';
import {
  getTopUsageEntries,
  getUsageAgentsForModel,
  getUsageModelDisplayName,
} from './utils';

function ModelRow({
  agentSlug,
  agents,
  model,
  models,
  onClick,
  stats,
  total,
}: {
  agentSlug?: string;
  agents: any[];
  model: string;
  models: any[];
  onClick: () => void;
  stats: any;
  total: number;
}) {
  const percentage = (stats.messages / total) * 100;
  const modelInfo = models.find(
    (entry) => entry.id === model || entry.originalId === model,
  );
  const displayName = getUsageModelDisplayName(models, model);
  const usingAgents = getUsageAgentsForModel({
    agentSlug,
    agents,
    modelId: model,
    modelOriginalId: modelInfo?.originalId,
  });
  const isAcpOnly =
    usingAgents.length > 0 &&
    usingAgents.every((agent) => agent.engineConnectionType === 'acp');

  const tooltipLines = [
    `Model: ${displayName}`,
    `ID: ${model}`,
    `Messages: ${stats.messages}`,
    `Cost: $${(stats.cost ?? 0).toFixed(4)}`,
    usingAgents.length > 0
      ? `Agents: ${usingAgents.map((agent) => agent.name || agent.slug).join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: composite usage row can contain an independent plan link, so it cannot be a native button. */}
      <div
        className="usage-breakdown-item"
        title={tooltipLines}
        onClick={onClick}
        style={{ cursor: 'pointer' }}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        <div className="usage-breakdown-header">
          <span className="usage-breakdown-name">{displayName}</span>
          <span className="usage-breakdown-stats">
            {stats.messages} msgs ·{' '}
            {isAcpOnly ? (
              <a
                href={usingAgents[0]?.planUrl || '#'}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                style={{ color: 'var(--accent-acp)', textDecoration: 'none' }}
                onMouseEnter={(event) =>
                  (event.currentTarget.style.textDecoration = 'underline')
                }
                onMouseLeave={(event) =>
                  (event.currentTarget.style.textDecoration = 'none')
                }
              >
                {usingAgents[0]?.planLabel ||
                  usingAgents[0]?.connectionName ||
                  'Engine'}{' '}
                plan ↗
              </a>
            ) : (
              `$${(stats.cost ?? 0).toFixed(2)}`
            )}
          </span>
        </div>
        {usingAgents.length > 0 && (
          <div
            style={{
              fontSize: '11px',
              color: 'var(--text-muted)',
              marginTop: '2px',
            }}
          >
            {usingAgents
              .slice(0, 3)
              .map((agent) => agent.name || agent.slug)
              .join(', ')}
            {usingAgents.length > 3 && ` +${usingAgents.length - 3} more`}
          </div>
        )}
        <div className="usage-breakdown-bar">
          <div
            className="usage-breakdown-bar-fill"
            style={{
              width: `${percentage}%`,
              backgroundColor: isAcpOnly
                ? 'var(--accent-acp)'
                : 'var(--accent-primary)',
            }}
          />
        </div>
      </div>
    </>
  );
}

function AgentRow({
  agent,
  agents,
  onClick,
  stats,
  total,
}: {
  agent: string;
  agents: any[];
  onClick: () => void;
  stats: any;
  total: number;
}) {
  const percentage = (stats.messages / total) * 100;
  const agentConfig = agents.find((entry) => entry.slug === agent);
  const isAcp = agentConfig?.engineConnectionType === 'acp';
  const displayName = agentConfig?.name || agent;

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: composite usage row can contain an independent plan link, so it cannot be a native button. */}
      <div
        className="usage-breakdown-item"
        onClick={onClick}
        style={{ cursor: 'pointer' }}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        <div className="usage-breakdown-header">
          <span
            className="usage-breakdown-name"
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {agentConfig ? (
              <AgentIcon agent={agentConfig} size="small" />
            ) : (
              <AgentGlyph />
            )}
            {displayName}
          </span>
          <span className="usage-breakdown-stats">
            {stats.messages} msgs ·{' '}
            {isAcp && agentConfig?.planUrl ? (
              <a
                href={agentConfig.planUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                style={{ color: 'var(--accent-acp)', textDecoration: 'none' }}
                onMouseEnter={(event) =>
                  (event.currentTarget.style.textDecoration = 'underline')
                }
                onMouseLeave={(event) =>
                  (event.currentTarget.style.textDecoration = 'none')
                }
              >
                {agentConfig.planLabel ||
                  agentConfig.connectionName ||
                  'Engine'}{' '}
                plan ↗
              </a>
            ) : (
              `$${(stats.cost ?? 0).toFixed(2)}`
            )}
          </span>
        </div>
        <div className="usage-breakdown-bar">
          <div
            className="usage-breakdown-bar-fill"
            style={{
              width: `${percentage}%`,
              backgroundColor: isAcp
                ? 'var(--accent-acp)'
                : 'var(--accent-yellow)',
            }}
          />
        </div>
      </div>
    </>
  );
}

export function UsageBreakdownSection({
  agents,
  byAgent,
  byModel,
  models,
  onAgentClick,
  onModelClick,
  totalMessages,
}: {
  agents: any[];
  byAgent: Record<string, any>;
  byModel: Record<string, any>;
  models: any[];
  onAgentClick: (agentId: string) => void;
  onModelClick: (modelId: string) => void;
  totalMessages: number;
}) {
  return (
    <div className="usage-stats-breakdown">
      <div className="usage-breakdown-section">
        <h4>
          <AgentGlyph />
          <span>Top Models</span>
        </h4>
        <div className="usage-breakdown-list">
          {getTopUsageEntries(byModel).map(([model, stats]) => (
            <ModelRow
              key={model}
              model={model}
              stats={stats}
              total={totalMessages}
              models={models}
              agents={agents}
              onClick={() => onModelClick(model)}
            />
          ))}
          {Object.keys(byModel).length === 0 && (
            <Empty variant="compact" label="No model data yet" />
          )}
        </div>
      </div>

      <div className="usage-breakdown-section">
        <h4>
          <TargetGlyph />
          <span>Top Agents</span>
        </h4>
        <div className="usage-breakdown-list">
          {getTopUsageEntries(byAgent).map(([agent, stats]) => (
            <AgentRow
              key={agent}
              agent={agent}
              stats={stats}
              total={totalMessages}
              agents={agents}
              onClick={() => onAgentClick(agent)}
            />
          ))}
          {Object.keys(byAgent).length === 0 && (
            <Empty variant="compact" label="No agent data yet" />
          )}
        </div>
      </div>
    </div>
  );
}
