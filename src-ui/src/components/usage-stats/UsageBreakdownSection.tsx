import { AgentIcon } from '../icons/AgentIcon';
import { AgentGlyph, TargetGlyph } from '../icons/Glyph';
import { Empty } from '../state';
import {
  formatRecordedCost,
  getTopUsageEntries,
  getUsageModelDisplayName,
} from './utils';

function ModelRow({
  model,
  models,
  onClick,
  stats,
  total,
}: {
  model: string;
  models: any[];
  onClick: () => void;
  stats: any;
  total: number;
}) {
  const percentage = total > 0 ? (stats.messages / total) * 100 : 0;
  const displayName = getUsageModelDisplayName(models, model);

  const tooltipLines = [
    `Model: ${displayName}`,
    `ID: ${model}`,
    `Messages: ${stats.messages}`,
    `Recorded cost: ${formatRecordedCost(stats)}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <button
      type="button"
      className="usage-breakdown-item"
      title={tooltipLines}
      onClick={onClick}
    >
      <span className="usage-breakdown-header">
        <span className="usage-breakdown-name">{displayName}</span>
        <span className="usage-breakdown-stats">
          {stats.messages} msgs · {formatRecordedCost(stats)}
        </span>
      </span>
      <span className="usage-breakdown-bar">
        <span
          className="usage-breakdown-bar-fill"
          style={{
            width: `${percentage}%`,
            backgroundColor: 'var(--accent-primary)',
          }}
        />
      </span>
    </button>
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
  const percentage = total > 0 ? (stats.messages / total) * 100 : 0;
  const agentConfig = agents.find((entry) => entry.slug === agent);
  const isAcp = agentConfig?.engineConnectionType === 'acp';
  const displayName =
    agentConfig?.name || (agent === '(unnamed)' ? 'Unattributed agent' : agent);

  return (
    <button type="button" className="usage-breakdown-item" onClick={onClick}>
      <span className="usage-breakdown-header">
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
          {stats.messages} msgs · {formatRecordedCost(stats)}
        </span>
      </span>
      <span className="usage-breakdown-bar">
        <span
          className="usage-breakdown-bar-fill"
          style={{
            width: `${percentage}%`,
            backgroundColor: isAcp
              ? 'var(--accent-acp)'
              : 'var(--accent-yellow)',
          }}
        />
      </span>
    </button>
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
  unallocatedModelMessages = 0,
}: {
  agents: any[];
  byAgent: Record<string, any>;
  byModel: Record<string, any>;
  models: any[];
  onAgentClick: (agentId: string) => void;
  onModelClick: (modelId: string) => void;
  totalMessages: number;
  unallocatedModelMessages?: number;
}) {
  return (
    <div className="usage-stats-breakdown">
      <div className="usage-breakdown-section">
        <h4>
          <AgentGlyph />
          <span>Recorded models</span>
        </h4>
        <div className="usage-breakdown-list">
          {getTopUsageEntries(byModel).map(([model, stats]) => (
            <ModelRow
              key={model}
              model={model}
              stats={stats}
              total={totalMessages}
              models={models}
              onClick={() => onModelClick(model)}
            />
          ))}
          {Object.keys(byModel).length === 0 && (
            <Empty variant="compact" label="No model data yet" />
          )}
        </div>
        {unallocatedModelMessages > 0 && (
          <p className="usage-period-note">
            {unallocatedModelMessages.toLocaleString()} messages / turns without
            a recorded model
          </p>
        )}
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
