import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import {
  cacheInclusivePromptTokens,
  cacheInclusiveTotalTokens,
  providerPromptCacheInclusivity,
} from '@kontourai/station-shared/usage-fold';
import {
  conversationStatsMeasurementView,
  describeUnreportedMeasurements,
  formatMeasuredCostUsd,
  formatMeasuredTokens,
  UNREPORTED_MEASUREMENT_TEXT,
} from '@kontourai/station-shared/usage-measurement';
import { Button } from '../Button';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { describeReadFailure, ErrorState, SkeletonBlock } from '../state';
import type { ConversationStatsSnapshot } from './types';
import {
  formatAverageTokens,
  getContextBreakdownEntries,
  getContextWindowColor,
  getModelStatsEntries,
} from './utils';

interface ConversationStatsModalProps {
  stats: ConversationStatsSnapshot | null;
  isVisible: boolean;
  isLoading: boolean;
  /**
   * The stats READ failed  `stats === null` is true for a failed
   * read and for a settled empty one alike, so without this the modal drew
   * "No stats available" — a measurement claim — over a request that never
   * answered.
   */
  error?: unknown;
  onRetry?: () => void;
  onToggle: () => void;
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontWeight: 600,
          marginBottom: '4px',
          color: 'var(--text-secondary)',
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: '10px',
          color: 'var(--text-muted)',
          marginBottom: '8px',
        }}
      >
        {subtitle}
      </div>
      {children}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: '4px' }}>
      {label}: {value}
    </div>
  );
}

export function ConversationStatsModal({
  stats,
  isVisible,
  isLoading,
  error,
  onRetry,
  onToggle,
}: ConversationStatsModalProps) {
  if (!isVisible) return null;

  const unreportedNote = stats
    ? describeUnreportedMeasurements(
        conversationStatsMeasurementView(stats),
        engineDisplayLabel,
      )
    : null;

  /**
   * Cache honesty (archive#4196). The provider is only meaningful on an
   * engine-events view — Station's own memory accounting has no cache
   * concept and keeps its plain labels. The two derivations below return a
   * number ONLY when the provider's declared inclusivity ('disjoint') backs
   * summing input + cacheRead + cacheWrite; for an 'unverified'/'subset'/
   * undeclared provider they return `undefined` and the card renders the
   * provider's own figures unsummed, with cache as separate rows. The
   * "(uncached)" qualifier on the In rows is likewise shown only when the
   * declaration backs it — a label must never claim more than the declared
   * inclusivity does.
   */
  const usageProvider =
    stats?.measurement?.source === 'engine-events'
      ? stats.measurement.provider
      : undefined;
  const cacheInclusivity = providerPromptCacheInclusivity(usageProvider);
  const promptSideTotal = stats
    ? cacheInclusivePromptTokens(usageProvider, stats)
    : undefined;
  const cacheInclusiveTotal = stats
    ? cacheInclusiveTotalTokens(usageProvider, stats)
    : undefined;

  return (
    <ResponsiveDialogSurface
      onClose={onToggle}
      ariaLabelledBy="conversation-statistics-title"
      overlayStyle={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      panelStyle={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: '12px',
        padding: '24px',
        fontSize: '13px',
        color: 'var(--text-primary)',
        minWidth: 'min(320px, 90vw)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <h3
          id="conversation-statistics-title"
          style={{ margin: 0, fontSize: '16px' }}
        >
          Conversation Statistics
        </h3>
        <ResponsiveDialogCloseButton
          onClick={onToggle}
          label="Close conversation statistics"
        />
      </div>
      {isLoading ? (
        <SkeletonBlock count={3} label="Loading conversation statistics" />
      ) : error ? (
        <ErrorState
          variant="compact"
          title="Unable to load conversation statistics"
          description={describeReadFailure(error)}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
        />
      ) : stats ? (
        <div>
          {stats.contextWindowPercentage !== undefined && (
            <div
              style={{
                marginBottom: '16px',
                padding: '12px',
                background: 'var(--bg-primary)',
                borderRadius: '8px',
              }}
            >
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: '4px',
                  color: 'var(--text-secondary)',
                }}
              >
                Context Window Usage
              </div>
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--text-muted)',
                  marginBottom: '8px',
                }}
              >
                {stats.contextTokens?.toLocaleString() || 'N/A'} tokens (all
                messages + system instructions + tools)
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '12px',
                }}
              >
                <div
                  style={{
                    flex: 1,
                    height: '6px',
                    background: 'var(--border-primary)',
                    borderRadius: '3px',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(stats.contextWindowPercentage, 100)}%`,
                      height: '100%',
                      background: getContextWindowColor(
                        stats.contextWindowPercentage,
                      ),
                      transition: 'width 0.3s',
                    }}
                  />
                </div>
                <span style={{ fontWeight: 600 }}>
                  {(stats.contextWindowPercentage ?? 0).toFixed(1)}%
                </span>
              </div>
              {getContextBreakdownEntries(stats).length > 0 && (
                <div
                  style={{
                    fontSize: '11px',
                    paddingTop: '8px',
                    borderTop: '1px solid var(--border-primary)',
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      marginBottom: '6px',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Context Breakdown
                  </div>
                  {getContextBreakdownEntries(stats).map((entry) => (
                    <div
                      key={entry.label}
                      style={{
                        marginBottom: '3px',
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>{entry.label}:</span>
                      <span style={{ fontWeight: 600 }}>
                        {entry.value.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
              marginBottom: '16px',
            }}
          >
            <SectionCard
              title="Total LLM Consumption"
              subtitle="Tokens sent/received across all API calls"
            >
              <StatRow
                label={cacheInclusivity === 'disjoint' ? 'In (uncached)' : 'In'}
                value={formatMeasuredTokens(stats.inputTokens)}
              />
              {/* Cache rows render only when the engine reported the figure —
                  an absent field gets no row rather than an invented zero
                  (station#3201). */}
              {stats.cacheReadTokens !== undefined && (
                <StatRow
                  label="Cache read"
                  value={formatMeasuredTokens(stats.cacheReadTokens)}
                />
              )}
              {stats.cacheWriteTokens !== undefined && (
                <StatRow
                  label="Cache write"
                  value={formatMeasuredTokens(stats.cacheWriteTokens)}
                />
              )}
              {promptSideTotal !== undefined && (
                <StatRow
                  label="Prompt total"
                  value={promptSideTotal.toLocaleString()}
                />
              )}
              <StatRow
                label="Out"
                value={formatMeasuredTokens(stats.outputTokens)}
              />
              {/* When the declared inclusivity backs it, the total includes
                  cache; otherwise this is the provider's own figure,
                  unsummed. */}
              <div>
                Total:{' '}
                {formatMeasuredTokens(cacheInclusiveTotal ?? stats.totalTokens)}
              </div>
            </SectionCard>
            <SectionCard
              title="Per Turn Averages"
              subtitle="Average tokens per conversation turn"
            >
              {stats.turns > 0 && (
                <>
                  <StatRow
                    label="User"
                    value={
                      formatAverageTokens(
                        stats.userMessageTokens,
                        stats.turns,
                      ) ?? UNREPORTED_MEASUREMENT_TEXT
                    }
                  />
                  <StatRow
                    label="Assistant"
                    value={
                      formatAverageTokens(
                        stats.assistantMessageTokens,
                        stats.turns,
                      ) ?? UNREPORTED_MEASUREMENT_TEXT
                    }
                  />
                  <div>
                    {cacheInclusivity === 'disjoint'
                      ? 'Total In (uncached)'
                      : 'Total In'}
                    :{' '}
                    {formatAverageTokens(stats.inputTokens, stats.turns) ??
                      UNREPORTED_MEASUREMENT_TEXT}
                  </div>
                </>
              )}
            </SectionCard>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
              marginBottom: '16px',
            }}
          >
            <SectionCard
              title="Activity"
              subtitle="Conversation activity metrics"
            >
              <div style={{ marginBottom: '4px' }}>Turns: {stats.turns}</div>
              <div>Tool Calls: {stats.toolCalls}</div>
            </SectionCard>
            <SectionCard title="Cost" subtitle="Total and per-turn cost">
              <div style={{ marginBottom: '4px' }}>
                Total: {formatMeasuredCostUsd(stats.estimatedCost)}
              </div>
              {stats.turns > 0 && (
                <div>
                  Per Turn:{' '}
                  {formatMeasuredCostUsd(
                    stats.estimatedCost === undefined
                      ? undefined
                      : stats.estimatedCost / stats.turns,
                  )}
                </div>
              )}
            </SectionCard>
          </div>
          {unreportedNote && (
            <div
              style={{
                marginBottom: '16px',
                fontSize: '11px',
                lineHeight: 1.5,
                color: 'var(--text-muted)',
              }}
            >
              {unreportedNote}
            </div>
          )}
          {stats.modelStats &&
            getModelStatsEntries(stats.modelStats).length > 0 && (
              <div>
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: '8px',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Per-Model Breakdown
                </div>
                {getModelStatsEntries(stats.modelStats).map(
                  ([modelId, modelStat]) => (
                    <div
                      key={modelId}
                      style={{
                        marginBottom: '12px',
                        padding: '8px',
                        background: 'var(--bg-primary)',
                        borderRadius: '6px',
                        fontSize: '12px',
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          marginBottom: '6px',
                          fontSize: '11px',
                          opacity: 0.8,
                        }}
                      >
                        {modelId}
                      </div>
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr',
                          gap: '8px',
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontSize: '10px',
                              color: 'var(--text-muted)',
                              marginBottom: '2px',
                            }}
                          >
                            Consumed
                          </div>
                          <div>
                            In: {modelStat.inputTokens.toLocaleString()}
                          </div>
                          <div>
                            Out: {modelStat.outputTokens.toLocaleString()}
                          </div>
                          <div>
                            Total: {modelStat.totalTokens.toLocaleString()}
                          </div>
                        </div>
                        <div>
                          <div
                            style={{
                              fontSize: '10px',
                              color: 'var(--text-muted)',
                              marginBottom: '2px',
                            }}
                          >
                            Stats
                          </div>
                          <div>Turns: {modelStat.turns}</div>
                          <div>Tool Calls: {modelStat.toolCalls}</div>
                          <div style={{ marginTop: '4px' }}>
                            Cost: ${(modelStat.estimatedCost ?? 0).toFixed(4)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
        </div>
      ) : (
        <div>No stats available</div>
      )}
    </ResponsiveDialogSurface>
  );
}
