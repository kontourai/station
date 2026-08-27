import { K } from '../../../../../src-shared/monitoring-keys';
import type { MonitoringEvent } from '../../../contexts/MonitoringContext';
import { getEventType } from '../../../views/monitoring-utils';
import { CheckGlyph, CloseGlyph } from '../../icons/Glyph';
import {
  buildToolInputDisplay,
  getArtifactSummary,
  getTotalChars,
  getTotalTokens,
} from './utils';

export function EventEntrySections({
  event,
  onCopyResult,
}: {
  event: MonitoringEvent;
  onCopyResult: (text: string) => void;
}) {
  return (
    <>
      <ReasoningSection event={event} />
      <HealthChecksSection event={event} />
      <ToolInputSection event={event} />
      <ToolResultSection event={event} onCopy={onCopyResult} />
      <ArtifactsSection event={event} />
    </>
  );
}

function ReasoningSection({ event }: { event: MonitoringEvent }) {
  if (!event[K.REASONING_TEXT]) return null;
  const text = event[K.REASONING_TEXT] as string;
  return (
    <details className="log-details">
      <summary>
        Output
        <span className="log-details-char-count">({text.length} chars)</span>
      </summary>
      <pre className="log-details-pre-scroll">{text}</pre>
    </details>
  );
}

function HealthChecksSection({ event }: { event: MonitoringEvent }) {
  const checks = event[K.HEALTH_CHECKS] as Record<string, boolean> | undefined;
  if (!checks) return null;
  const integrations = event[K.HEALTH_INTEGRATIONS] as
    | Array<{
        type: string;
        id: string;
        connected: boolean;
        metadata?: { transport: string; toolCount: number };
      }>
    | undefined;

  return (
    <details className="log-details">
      <summary>Health Checks</summary>
      <div className="health-checks-list">
        {Object.entries(checks).map(([key, value]) => (
          <div key={key} className="health-check-item">
            <span className="health-check-label">{key}:</span>
            <span
              className={
                value ? 'health-check-value-pass' : 'health-check-value-fail'
              }
            >
              {value ? <CheckGlyph /> : <CloseGlyph />}
            </span>
          </div>
        ))}
        {integrations && integrations.length > 0 && (
          <div className="health-integrations-section">
            <div className="health-integrations-label">Integrations:</div>
            {integrations.map((integration, idx) => (
              <div key={idx} className="health-integration-item">
                <div className="health-integration-name">
                  {integration.id} ({integration.type})
                  <span
                    className={
                      integration.connected
                        ? 'health-integration-status-ok'
                        : 'health-integration-status-err'
                    }
                  >
                    {integration.connected ? (
                      <>
                        <CheckGlyph /> Connected
                      </>
                    ) : (
                      <>
                        <CloseGlyph /> Disconnected
                      </>
                    )}
                  </span>
                </div>
                {integration.metadata && (
                  <div className="health-integration-meta">
                    Transport: {integration.metadata.transport} | Tools:{' '}
                    {integration.metadata.toolCount}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function ToolInputSection({ event }: { event: MonitoringEvent }) {
  const input = buildToolInputDisplay(event);
  if (!input) return null;

  return (
    <details className="log-details">
      <summary>Input ({input.label})</summary>
      <pre>{input.text}</pre>
    </details>
  );
}

function ToolResultSection({
  event,
  onCopy,
}: {
  event: MonitoringEvent;
  onCopy: (text: string) => void;
}) {
  const result = event[K.TOOL_CALL_RESULT];
  if (!result) return null;
  // station#3507: a producer (the OTLP agent-telemetry ingest route, or a
  // tool whose own return value is a plain string) can report an
  // already-string result — re-stringifying it here would wrap it in an
  // extra layer of quotes/escapes, the same double-encode this issue fixed
  // in ToolCallDisplay.tsx. Only a non-string value needs JSON encoding.
  const resultText =
    typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return (
    <details className="log-details">
      <summary>
        Result
        <button
          type="button"
          className="export-btn"
          onClick={(e) => {
            e.stopPropagation();
            onCopy(resultText);
          }}
          title="Copy to clipboard"
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </summary>
      <pre>{resultText}</pre>
    </details>
  );
}

function ArtifactsSection({ event }: { event: MonitoringEvent }) {
  if (getEventType(event) !== 'agent-complete') return null;

  const summary = getArtifactSummary(event);
  if (!summary) return null;

  return (
    <>
      {summary.finalOutput && (
        <details className="log-details">
          <summary>
            Output
            {summary.finalOutput.length > 200 && (
              <span className="log-details-char-count">
                ({summary.finalOutput.length} chars)
              </span>
            )}
          </summary>
          <pre className="log-details-pre-scroll">{summary.finalOutput}</pre>
        </details>
      )}
      {summary.toolCalls.length > 0 && (
        <details className="log-details">
          <summary>Tools Used ({summary.toolCalls.length})</summary>
          <div className="tool-result-list">
            {summary.toolCalls.map((tool, idx) => (
              <div key={idx} className="tool-result-item">
                <div className="tool-result-name">{tool.name}</div>
              </div>
            ))}
          </div>
        </details>
      )}
      <UsageStatsSection event={event} />
    </>
  );
}

function UsageStatsSection({ event }: { event: MonitoringEvent }) {
  if (event[K.INPUT_TOKENS] === undefined && event[K.INPUT_CHARS] === undefined)
    return null;

  const totalChars = getTotalChars(event);
  const totalTokens = getTotalTokens(event);

  return (
    <details className="log-details">
      <summary>Usage & Stats</summary>
      <div className="usage-stats-grid">
        {event[K.INPUT_CHARS] !== undefined && (
          <>
            <div className="usage-stat-label">Input:</div>
            <div className="usage-stat-value">
              {(event[K.INPUT_CHARS] as number).toLocaleString()} chars
            </div>
          </>
        )}
        {event[K.OUTPUT_CHARS] !== undefined && (
          <>
            <div className="usage-stat-label">Output:</div>
            <div className="usage-stat-value">
              {(event[K.OUTPUT_CHARS] as number).toLocaleString()} chars
            </div>
          </>
        )}
        {totalChars !== null && (
          <>
            <div className="usage-stat-label-bold">Total:</div>
            <div className="usage-stat-value-bold">
              {totalChars.toLocaleString()} chars
            </div>
          </>
        )}
        {event[K.INPUT_TOKENS] !== undefined && (
          <>
            <div className="usage-stat-label usage-stat-spaced">
              Input Tokens:
            </div>
            <div className="usage-stat-value usage-stat-spaced">
              {(event[K.INPUT_TOKENS] as number).toLocaleString()}
            </div>
          </>
        )}
        {event[K.OUTPUT_TOKENS] !== undefined && (
          <>
            <div className="usage-stat-label">Output Tokens:</div>
            <div className="usage-stat-value">
              {(event[K.OUTPUT_TOKENS] as number).toLocaleString()}
            </div>
          </>
        )}
        {totalTokens !== null && (
          <>
            <div className="usage-stat-label-bold">Total Tokens:</div>
            <div className="usage-stat-value-bold">
              {totalTokens.toLocaleString()}
            </div>
          </>
        )}
        {event[K.AGENT_STEPS] !== undefined && (
          <>
            <div className="usage-stat-label usage-stat-spaced">
              Steps Taken:
            </div>
            <div className="usage-stat-value usage-stat-spaced">
              {event[K.AGENT_STEPS] as number}
            </div>
          </>
        )}
        {event[K.AGENT_MAX_STEPS] !== undefined && (
          <>
            <div className="usage-stat-label">Max Steps:</div>
            <div className="usage-stat-value">
              {event[K.AGENT_MAX_STEPS] as number}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
