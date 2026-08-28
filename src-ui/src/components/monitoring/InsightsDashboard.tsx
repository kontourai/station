import {
  fetchMonitoringEvents,
  useAnalyzeFeedbackMutation,
  useClearFeedbackAnalysisMutation,
  useDeleteFeedbackRatingMutation,
  useFeedbackGuidelinesQuery,
  useFeedbackRatingsQuery,
  useFeedbackStatusQuery,
  useInsightsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import {
  ChartGlyph,
  CheckGlyph,
  CloseGlyph,
  MessageGlyph,
  RefreshGlyph,
  SearchGlyph,
  ThumbDownGlyph,
  ThumbUpGlyph,
  TimeGlyph,
} from '../icons/Glyph';
import { Empty, SkeletonBlock } from '../state';
import './InsightsDashboard.css';
import {
  formatRelativeFuture,
  formatRelativePast,
  getHourlyBarStyle,
  getInsightsUsageView,
  summarizeFeedbackRatings,
} from './insightsDashboardUtils';

// ── Types ──────────────────────────────────────────────

interface Insights {
  toolUsage: Record<
    string,
    { calls: number; errors: number; outcomeUnknown?: number }
  >;
  hourlyActivity: number[];
  agentUsage: Record<string, { chats: number; tokens: number }>;
  modelUsage: Record<string, number>;
  totalChats: number;
  totalToolCalls: number;
  totalErrors: number;
/** Results whose producer reported no terminal status (archive#3075). */
  totalOutcomeUnknown?: number;
  days: number;
  applied?: { agent?: string; tool?: string; engine?: string; limit?: number };
}

interface MessageRating {
  id: string;
  agentSlug: string;
  conversationId: string;
  messageIndex: number;
  messagePreview: string;
  rating: 'thumbs_up' | 'thumbs_down';
  reason?: string;
  analysis?: string;
  createdAt: string;
  analyzedAt?: string;
}

interface FeedbackSummary {
  reinforce: string[];
  avoid: string[];
  analyzedCount: number;
  updatedAt: string;
}

interface FeedbackStatus {
  lastAnalyzedAt?: string;
  nextAnalysisAt?: string;
  isAnalyzing: boolean;
  analyzeCallbackAvailable: boolean;
}

type Tab = 'usage' | 'feedback';

/**
 * Hand the user the rows behind the numbers (archive#3076).
 *
 * A dashboard that can only show its own aggregates makes the human the
 * query interface — the exact gap this closes. The rows arrive already
 * redacted by the server, so this is a download, not a new exposure.
 */
export async function downloadInsightEvents(
  days: number,
  filters: { agent?: string },
  expectedToolCalls?: number,
): Promise<{ written: boolean; rows: number; reason?: string }> {
// /monitoring/events, which owns the per-user and tenant authorization
// these rows require — not a parallel export (archive#3076).
  const events = await fetchMonitoringEvents(
    new Date(Date.now() - days * 24 * 60 * 60 * 1000),
    new Date(),
    undefined,
    { ...filters, tools: true },
  );

// REFUSE rather than hand over a file that misrepresents itself. This
// endpoint scopes rows to the requesting user; /api/insights, which
// produced the number displayed beside this button, does not — so on a
// corpus whose tool events were written without attribution the panel
// reads thousands and the export returns almost nothing (archive#3130).
// fetchMonitoringEvents used to flatten every failure — 401, 500, a parse
// error — into an empty array, so "no rows" and "the request failed" were
// the same value here. archive#3658 made every non-success read throw (a
// non-ok status as `StationHttpError` with the status preserved, an
// unreadable body or `success:false` as an Error carrying the route's own
// sentence), which this caller's `.catch` renders as "Export failed: …".
// Only a SUCCEEDED read with zero rows now reaches the branch below. A
// silently empty download asserting it holds the rows behind those numbers
// is the defect this whole change exists to remove, one layer down.
  if (events.length === 0) {
    return {
      written: false,
      rows: 0,
      reason:
        'No exportable rows came back. If the panel shows tool calls, they were recorded without a user id and this endpoint cannot return them (station#3130).',
    };
  }
  if (
    typeof expectedToolCalls === 'number' &&
    expectedToolCalls > 0 &&
    events.length < expectedToolCalls
  ) {
    return {
      written: false,
      rows: events.length,
      reason: `Only ${events.length} of about ${expectedToolCalls} tool calls are readable through this endpoint; the rest were recorded without a user id (station#3130).`,
    };
  }

  const ndjson = events.map((event) => JSON.stringify(event)).join('\n');
  const url = URL.createObjectURL(
    new Blob([ndjson], { type: 'application/x-ndjson' }),
  );
  const link = document.createElement('a');
  link.href = url;
// Name the filter too: the file outlives the UI state that produced it,
// and an unfiltered export and an agent-scoped one otherwise collide.
  const scope = filters.agent ? `-${filters.agent}` : '';
  link.download = `station-tool-events${scope}-${days}d.ndjson`;
  link.click();
  URL.revokeObjectURL(url);
  return { written: true, rows: events.length };
}

// ── Usage Tab ──────────────────────────────────────────

function UsageTab() {
  const [days, setDays] = useState(14);
// Server-side slicing (archive#3075). The dimensions were always on the
// data; only the endpoint refused to use them, so answering "what did THIS
// agent run" meant reading raw NDJSON by hand.
  const [agent, setAgent] = useState<string | undefined>();
  const [exportNote, setExportNote] = useState<string | undefined>();
// NO engine control, deliberately. The server accepts an `engine` filter,
// but it reads gen_ai.provider.name, and on a real corpus every tool event
// still carries null there — the attribution the server's own comment
// predicts would be missing. A selector that always narrows to nothing is
// worse than no selector. An earlier draft of this carried `engine` state
// whose setter was only ever called with undefined: an inert control, and
// a PR description claiming a filter that could not be set (archive#3075
// review). Wire it when the events carry the field (archive#3130).
  const { data } = useInsightsQuery(days, { agent }) as {
    data: Insights | undefined;
  };

  if (!data) return <SkeletonBlock count={3} label="Loading insights" />;

  const { agents, maxHourly, maxToolCalls, topTools } =
    getInsightsUsageView(data);

  return (
    <>
      <div className="insights-pill-row">
        {[7, 14, 30].map((d) => (
          <button
            type="button"
            key={d}
            onClick={() => setDays(d)}
            className={`insights-pill ${d === days ? 'is-active' : ''}`}
          >
            {d}d
          </button>
        ))}
      </div>

      {agent !== undefined && (
        <div className="insights-filter-row">
          <span className="insights-section-label">
{/* Only claim "Filtered" when the SERVER says it filtered. It
                echoes `applied` precisely so a client can tell a narrowed
                rollup from a whole-corpus one, and a UI that renders the
                chrome off its own local state would show "agent: dev" over
                unfiltered numbers against any server that ignored the
                param — an older Station over the tailnet, say. */}
            {data.applied?.agent === agent ? 'Filtered' : 'Filter not applied'}
          </span>
          <button
            type="button"
            className="insights-pill is-active"
            onClick={() => setAgent(undefined)}
          >
            agent: {agent} ✕
          </button>
        </div>
      )}

      <div className="insights-stat-grid">
        {[
          { label: 'Chats', value: data.totalChats },
          { label: 'Tool Calls', value: data.totalToolCalls },
          { label: 'Errors', value: data.totalErrors },
// Shown beside Errors deliberately: these results reported no
// terminal status, so an error rate that ignores them flatters
// itself, and a reader deserves the denominator (archive#3075).
          ...(data.totalOutcomeUnknown
            ? [{ label: 'Outcome unreported', value: data.totalOutcomeUnknown }]
            : []),
        ].map((s) => (
          <div key={s.label} className="insights-stat-cell">
            <div className="insights-section-label">{s.label}</div>
            <div className="insights-stat-value">
              {s.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <div className="insights-hourly">
        <div className="insights-section-label">Activity by Hour</div>
        <div className="insights-hourly-bars">
          {data.hourlyActivity.map((count, hour) => (
            <div
              key={hour}
              title={`${hour}:00 — ${count} events`}
              className={`insights-hourly-bar ${count > 0 ? 'has-data' : ''}`}
              style={getHourlyBarStyle(count, maxHourly)}
            />
          ))}
        </div>
        <div className="insights-hourly-labels">
          <span>12am</span>
          <span>6am</span>
          <span>12pm</span>
          <span>6pm</span>
          <span>11pm</span>
        </div>
      </div>

      <div className="insights-two-col">
        <div>
          <div className="insights-section-label">
            Top Tools
            <button
              type="button"
              className="insights-inline-action"
              onClick={() => {
                setExportNote(undefined);
                downloadInsightEvents(days, { agent }, data.totalToolCalls)
                  .then((result) => {
                    if (!result.written) setExportNote(result.reason);
                  })
                  .catch((error: unknown) => {
                    setExportNote(
                      error instanceof Error
                        ? `Export failed: ${error.message}`
                        : 'Export failed.',
                    );
                  });
              }}
            >
              export rows
            </button>
          </div>
          {exportNote !== undefined && (
            <div className="insights-export-note" role="alert">
              {exportNote}
            </div>
          )}
          {topTools.length === 0 ? (
            <Empty variant="compact" label="No tool usage yet" />
          ) : (
            topTools.map(([name, stats]) => (
              <div key={name} className="insights-tool-row">
                <div className="insights-tool-header">
                  <span className="insights-mono-sm">
                    {name.length > 25 ? `${name.slice(0, 25)}…` : name}
                  </span>
                  <span className="insights-muted">
                    {stats.calls}
                    {stats.errors > 0 ? ` (${stats.errors} err)` : ''}
                    {stats.outcomeUnknown
                      ? ` (${stats.outcomeUnknown} unreported)`
                      : ''}
                  </span>
                </div>
                <div className="insights-bar-track">
                  <div
                    className={`insights-bar-fill ${stats.errors > 0 ? 'has-errors' : ''}`}
                    style={{ width: `${(stats.calls / maxToolCalls) * 100}%` }}
                  />
                </div>
              </div>
            ))
          )}
        </div>
        <div>
          <div className="insights-section-label">Agent Usage</div>
          {agents.length === 0 ? (
            <Empty variant="compact" label="No agent usage yet" />
          ) : (
            agents.map(([name, stats]) => (
// Clicking an agent filters the whole rollup to it. The number
// and the thing it describes should be one gesture apart, not
// an API call the user has to know exists.
              <button
                type="button"
                key={name}
                className={`insights-agent-row is-selectable ${
                  agent === name ? 'is-active' : ''
                }`}
                aria-pressed={agent === name}
                onClick={() => setAgent(agent === name ? undefined : name)}
              >
                <span className="insights-text-primary">{name}</span>
                <span className="insights-mono-sm insights-muted">
                  {stats.chats} chats · {(stats.tokens / 1000).toFixed(1)}k tok
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ── Feedback Tab ───────────────────────────────────────

function FeedbackTab() {
  const [filter, setFilter] = useState<
    'all' | 'thumbs_up' | 'thumbs_down' | 'pending' | 'no_reason'
  >('all');

  const { data: ratings = [] } = useFeedbackRatingsQuery() as {
    data: MessageRating[];
  };
  const { data: summary } = useFeedbackGuidelinesQuery() as {
    data: FeedbackSummary | null;
  };
  const { data: status } = useFeedbackStatusQuery() as {
    data: FeedbackStatus | null;
  };

  const analyzeMutation = useAnalyzeFeedbackMutation();
  const clearMutation = useClearFeedbackAnalysisMutation();
  const deleteMutation = useDeleteFeedbackRatingMutation();

  const { disliked, liked, noReason, pending } =
    summarizeFeedbackRatings(ratings);

  const filtered = ratings.filter((r) => {
    if (filter === 'all') return true;
    if (filter === 'pending') return !r.analyzedAt;
    if (filter === 'no_reason') return !r.reason;
    return r.rating === filter;
  });

  return (
    <div className="feedback-grid">
{/* Left: Ratings list */}
      <div>
        <div className="insights-pill-row">
          {(
            [
              ['all', `All (${ratings.length})`, null],
              ['thumbs_up', `Liked (${liked})`, ThumbUpGlyph],
              ['thumbs_down', `Disliked (${disliked})`, ThumbDownGlyph],
              ['pending', `Pending (${pending})`, TimeGlyph],
              ['no_reason', `No Reason (${noReason})`, MessageGlyph],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              type="button"
              key={key}
              onClick={() => setFilter(key)}
              className={`insights-pill ${filter === key ? 'is-active' : ''}`}
            >
              {Icon && <Icon />} {label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="insights-empty feedback-empty">
            {ratings.length === 0
              ? 'No ratings yet. Rate agent messages to start building your feedback profile.'
              : 'No ratings match this filter.'}
          </div>
        ) : (
          <div className="feedback-grid">
            {filtered.map((r) => (
              <div key={r.id} className="feedback-card">
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate(r)}
                  title="Delete rating"
                  aria-label={`Delete rating for ${r.agentSlug} message ${r.messageIndex + 1} in ${r.conversationId}`}
                  className="feedback-delete-btn"
                >
                  <CloseGlyph />
                </button>
                <div className="feedback-card-header">
                  <span className="feedback-rating-icon">
                    {r.rating === 'thumbs_up' ? (
                      <ThumbUpGlyph />
                    ) : (
                      <ThumbDownGlyph />
                    )}{' '}
                    <span className="feedback-agent-slug">{r.agentSlug}</span>
                  </span>
                  <span className="feedback-date">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div
                  className={`feedback-preview ${r.reason || r.analysis ? 'has-extra' : ''}`}
                >
                  {r.messagePreview.length > 120
                    ? `${r.messagePreview.slice(0, 120)}…`
                    : r.messagePreview}
                </div>
                {r.reason && (
                  <div
                    className={`feedback-reason ${r.rating === 'thumbs_up' ? 'positive' : 'negative'}`}
                  >
                    &ldquo;{r.reason}&rdquo;
                  </div>
                )}
                {r.analysis && (
                  <div className="feedback-analysis">
                    <SearchGlyph /> {r.analysis}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

{/* Right: Behavior summary */}
      <div>
        <div className="feedback-behaviors-header">
          <div className="insights-section-label">Learned Behaviors</div>
          <div className="feedback-actions">
            <button
              type="button"
              onClick={() => analyzeMutation.mutate()}
              disabled={analyzeMutation.isPending}
              className={`insights-pill ${analyzeMutation.isPending ? 'is-disabled' : ''}`}
            >
              {analyzeMutation.isPending ? (
                <>
                  <TimeGlyph /> Analyzing...
                </>
              ) : (
                <>
                  <RefreshGlyph /> Analyze
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => clearMutation.mutate()}
              className="insights-pill"
            >
              Clear
            </button>
          </div>
        </div>

        {status && (
          <div className="feedback-status">
            {status.isAnalyzing && <span className="feedback-status-dot" />}
            {status.lastAnalyzedAt
              ? `Last analyzed: ${formatRelativePast(status.lastAnalyzedAt)}${status.nextAnalysisAt ? ` · Next: ${formatRelativeFuture(status.nextAnalysisAt)}` : ''}`
              : 'Not yet analyzed'}
          </div>
        )}

        {!summary ? (
          <div className="insights-empty feedback-empty">
            No analysis yet. Rate some messages, then click Analyze or wait for
            the automatic 10-minute cycle.
          </div>
        ) : (
          <>
            <div className="feedback-behavior-section">
              <div className="feedback-behaviors-header positive">
                <CheckGlyph /> Behaviors to Reinforce
              </div>
              {summary.reinforce.length === 0 ? (
                <div className="insights-empty">None identified yet</div>
              ) : (
                summary.reinforce.map((b, i) => (
                  <div key={i} className="feedback-behavior-item">
                    {b}
                  </div>
                ))
              )}
            </div>

            <div className="feedback-behavior-section">
              <div className="feedback-behaviors-header negative">
                <CloseGlyph /> Behaviors to Avoid
              </div>
              {summary.avoid.length === 0 ? (
                <div className="insights-empty">None identified yet</div>
              ) : (
                summary.avoid.map((b, i) => (
                  <div key={i} className="feedback-behavior-item">
                    {b}
                  </div>
                ))
              )}
            </div>

            <div className="feedback-meta">
              Based on {summary.analyzedCount} rated messages · Updated{' '}
              {new Date(summary.updatedAt).toLocaleString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Combined Dashboard ─────────────────────────────────

export function InsightsDashboard() {
  const [tab, setTab] = useState<Tab>('usage');

  return (
    <div className="insights-dashboard">
      <div className="insights-tab-row">
        <button
          type="button"
          onClick={() => setTab('usage')}
          className={`insights-tab ${tab === 'usage' ? 'is-active' : ''}`}
        >
          <ChartGlyph /> Usage
        </button>
        <button
          type="button"
          onClick={() => setTab('feedback')}
          className={`insights-tab ${tab === 'feedback' ? 'is-active' : ''}`}
        >
          <MessageGlyph /> Feedback
        </button>
      </div>
      {tab === 'usage' ? <UsageTab /> : <FeedbackTab />}
    </div>
  );
}
