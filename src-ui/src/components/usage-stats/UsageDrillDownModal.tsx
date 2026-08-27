import {
  cacheInclusivePromptTokens,
  providerPromptCacheInclusivity,
} from '@kontourai/station-shared/usage-fold';
import { AgentIcon } from '../icons/AgentIcon';
import {
  AgentGlyph,
  ChartGlyph,
  CheckGlyph,
  CloseGlyph,
  FolderGlyph,
  InboxGlyph,
  MessageGlyph,
  MoneyGlyph,
  OutboxGlyph,
  TargetGlyph,
} from '../icons/Glyph';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { StatCard } from './StatCard';
import {
  getAgentModelBreakdown,
  getTotalUsageConversations,
  getUsageModelDisplayName,
} from './utils';

type DrillDownType = 'model' | 'agent' | null;

export function UsageDrillDownModal({
  agents,
  id,
  models,
  onClose,
  type,
  usageStats,
}: {
  agents: any[];
  id: string;
  models: any[];
  onClose: () => void;
  type: DrillDownType;
  usageStats: any;
}) {
  if (type === 'model') {
    const modelStats = usageStats.byModel[id];
    // A historical model bucket may include old persisted usage with no
    // provider identity, or multiple providers under the same model id. In
    // either case its cache components remain useful facts, but a cache-
    // inclusive prompt sum would be a guess. Require the aggregator's
    // single-provider attribution AND the declaration it recorded to still
    // match the shared authority before asking the shared derivation to sum.
    const cacheProvider =
      modelStats.cacheProviderAttribution === 'single' &&
      modelStats.cacheProvider !== undefined &&
      modelStats.cacheInclusivity ===
        providerPromptCacheInclusivity(modelStats.cacheProvider)
        ? modelStats.cacheProvider
        : undefined;
    const cacheInclusivity = cacheProvider
      ? modelStats.cacheInclusivity
      : undefined;
    const promptTotal = cacheInclusivePromptTokens(cacheProvider, modelStats);
    const modelInfo = models.find(
      (model) => model.id === id || model.originalId === id,
    );
    const displayName = getUsageModelDisplayName(models, id);
    const agentsUsingModel = Object.entries(usageStats.byAgent)
      .filter(([, stats]: [string, any]) => stats.models?.[id])
      .map(([agentId, stats]: [string, any]) => ({
        agentId,
        agentName: agentId,
        messages: stats.models[id].messages,
        cost: stats.models[id].cost,
      }))
      .sort((a, b) => b.messages - a.messages);

    return (
      <ResponsiveDialogSurface
        onClose={onClose}
        ariaLabelledBy="model-usage-title"
        overlayClassName="drill-down-overlay"
        panelClassName="drill-down-modal"
      >
        <div className="drill-down-header">
          <h3 id="model-usage-title">
            <AgentGlyph /> {displayName}
          </h3>
          <ResponsiveDialogCloseButton
            onClick={onClose}
            label="Close model usage details"
          />
        </div>
        <div className="drill-down-content">
          <div className="drill-down-stats-grid">
            <StatCard
              icon={<MessageGlyph />}
              label="Messages"
              value={modelStats.messages.toLocaleString()}
              color="var(--accent-primary)"
            />
            <StatCard
              icon={<InboxGlyph />}
              label={
                cacheInclusivity === 'disjoint'
                  ? 'Input Tokens (uncached)'
                  : 'Input Tokens'
              }
              value={modelStats.inputTokens.toLocaleString()}
            />
            {modelStats.cacheReadTokens !== undefined && (
              <StatCard
                icon={<InboxGlyph />}
                label="Cache Read Tokens"
                value={modelStats.cacheReadTokens.toLocaleString()}
              />
            )}
            {modelStats.cacheWriteTokens !== undefined && (
              <StatCard
                icon={<InboxGlyph />}
                label="Cache Write Tokens"
                value={modelStats.cacheWriteTokens.toLocaleString()}
              />
            )}
            {promptTotal !== undefined && (
              <StatCard
                icon={<InboxGlyph />}
                label="Prompt Total"
                value={promptTotal.toLocaleString()}
              />
            )}
            <StatCard
              icon={<OutboxGlyph />}
              label="Output Tokens"
              value={modelStats.outputTokens.toLocaleString()}
            />
            <StatCard
              icon={<MoneyGlyph />}
              label="Total Cost"
              value={`$${modelStats.cost.toFixed(2)}`}
            />
            <StatCard
              icon={<ChartGlyph />}
              label="Avg Cost/Turn"
              value={`$${(modelStats.cost / modelStats.messages).toFixed(4)}`}
            />
            <StatCard
              icon={<InboxGlyph />}
              label={
                cacheInclusivity === 'disjoint'
                  ? 'Input Tokens (uncached)/Turn'
                  : 'Input Tokens/Turn'
              }
              value={Math.round(
                modelStats.inputTokens / modelStats.messages,
              ).toLocaleString()}
            />
            {promptTotal !== undefined && (
              <StatCard
                icon={<InboxGlyph />}
                label="Prompt Total/Turn"
                value={Math.round(
                  promptTotal / modelStats.messages,
                ).toLocaleString()}
              />
            )}
            <StatCard
              icon={<OutboxGlyph />}
              label="Output Tokens/Turn"
              value={Math.round(
                modelStats.outputTokens / modelStats.messages,
              ).toLocaleString()}
            />
          </div>

          {agentsUsingModel.length > 0 && (
            <div className="drill-down-section">
              <h4>Agents Using This Model</h4>
              <div className="drill-down-list">
                {agentsUsingModel.map(
                  ({ agentId, agentName, messages, cost }) => (
                    <div key={agentId} className="drill-down-list-item">
                      <span className="drill-down-list-name">{agentName}</span>
                      <span className="drill-down-list-stats">
                        {messages} msgs · ${cost.toFixed(2)}
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}

          <div className="drill-down-section">
            <h4>Model Details</h4>
            <div className="drill-down-details">
              <div>
                <strong>Model ID:</strong> {id}
              </div>
              {modelInfo?.originalId && (
                <div>
                  <strong>Original ID:</strong> {modelInfo.originalId}
                </div>
              )}
              <div>
                <strong>Display Name:</strong> {displayName}
              </div>
              {modelInfo?.inputCostPer1kTokens && (
                <div>
                  <strong>Input Cost:</strong> $
                  {(modelInfo.inputCostPer1kTokens ?? 0).toFixed(4)}/1K tokens
                </div>
              )}
              {modelInfo?.outputCostPer1kTokens && (
                <div>
                  <strong>Output Cost:</strong> $
                  {(modelInfo.outputCostPer1kTokens ?? 0).toFixed(4)}/1K tokens
                </div>
              )}
              {modelInfo?.supportsStreaming !== undefined && (
                <div>
                  <strong>Streaming:</strong>{' '}
                  {modelInfo.supportsStreaming ? (
                    <>
                      <CheckGlyph /> Supported
                    </>
                  ) : (
                    <>
                      <CloseGlyph /> Not supported
                    </>
                  )}
                </div>
              )}
              {modelInfo?.supportsVision !== undefined && (
                <div>
                  <strong>Vision:</strong>{' '}
                  {modelInfo.supportsVision ? (
                    <>
                      <CheckGlyph /> Supported
                    </>
                  ) : (
                    <>
                      <CloseGlyph /> Not supported
                    </>
                  )}
                </div>
              )}
              {modelInfo?.maxTokens && (
                <div>
                  <strong>Max Tokens:</strong>{' '}
                  {modelInfo.maxTokens.toLocaleString()}
                </div>
              )}
            </div>
          </div>
        </div>
      </ResponsiveDialogSurface>
    );
  }

  if (type === 'agent') {
    const agentStats = usageStats.byAgent[id];
    const agentName = id;
    const agent = agents.find((entry) => entry.slug === id || entry.id === id);
    const conversationCount = getTotalUsageConversations({
      totalConversations: agentStats.conversations,
      totalSessions: agentStats.sessions,
    });
    const modelBreakdown = getAgentModelBreakdown({ agentStats, models });

    return (
      <ResponsiveDialogSurface
        onClose={onClose}
        ariaLabelledBy="agent-usage-title"
        overlayClassName="drill-down-overlay"
        panelClassName="drill-down-modal"
      >
        <div className="drill-down-header">
          <h3
            id="agent-usage-title"
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            {agent ? (
              <AgentIcon agent={agent} size="medium" />
            ) : (
              <TargetGlyph />
            )}{' '}
            {agent?.name || agentName}
          </h3>
          <ResponsiveDialogCloseButton
            onClick={onClose}
            label="Close agent usage details"
          />
        </div>
        <div className="drill-down-content">
          <div className="drill-down-stats-grid">
            <StatCard
              icon={<MessageGlyph />}
              label="Messages"
              value={agentStats.messages.toLocaleString()}
              color="var(--accent-primary)"
            />
            <StatCard
              icon={<FolderGlyph />}
              label="Conversations"
              value={conversationCount.toLocaleString()}
            />
            <StatCard
              icon={<MoneyGlyph />}
              label="Total Cost"
              value={`$${agentStats.cost.toFixed(2)}`}
            />
            <StatCard
              icon={<ChartGlyph />}
              label="Avg Cost/Turn"
              value={`$${(agentStats.cost / agentStats.messages).toFixed(4)}`}
            />
          </div>

          {modelBreakdown.length > 0 && (
            <div className="drill-down-section">
              <h4>Models Used</h4>
              <div className="drill-down-list">
                {modelBreakdown.map(
                  ({ modelId, displayName, messages, cost }) => (
                    <div key={modelId} className="drill-down-list-item">
                      <span className="drill-down-list-name">
                        {displayName}
                      </span>
                      <span className="drill-down-list-stats">
                        {messages} msgs · ${cost.toFixed(2)}
                      </span>
                    </div>
                  ),
                )}
              </div>
            </div>
          )}

          <div className="drill-down-section">
            <h4>Agent Details</h4>
            <div className="drill-down-details">
              <div>
                <strong>Agent ID:</strong> {id}
              </div>
              <div>
                <strong>Display Name:</strong> {agentName}
              </div>
              {agent?.model && (
                <div>
                  <strong>Default Model:</strong> {agent.model}
                </div>
              )}
              {agent?.description && (
                <div>
                  <strong>Description:</strong> {agent.description}
                </div>
              )}
            </div>
          </div>
        </div>
      </ResponsiveDialogSurface>
    );
  }

  return null;
}
