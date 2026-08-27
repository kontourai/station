import type { FlowGateVerdictInfo } from '../../contexts/active-chats-state';
import './flow-events.css';

const VERDICT_TITLES: Record<FlowGateVerdictInfo['verdict'], string> = {
  pass: 'Flow gates passed',
  'route-back': 'Flow gate routed work back',
  block: 'Flow gate blocked completion',
  wait: 'Flow gate waiting on expectations',
};

interface FlowGateVerdictCardProps {
  verdict: FlowGateVerdictInfo;
  onCopy?: (text: string) => void;
}

export function FlowGateVerdictCard({
  verdict,
  onCopy,
}: FlowGateVerdictCardProps) {
  const attemptLabel =
    verdict.attempt != null && verdict.maxAttempts != null
      ? `attempt ${verdict.attempt} of ${verdict.maxAttempts}`
      : verdict.attempt != null
        ? `attempt ${verdict.attempt}`
        : null;

  return (
    <section
      className={`flow-gate-card flow-gate-card--${verdict.verdict}`}
      aria-label={`Flow gate verdict: ${verdict.verdict}`}
    >
      <div className="flow-gate-card__header">
        <span className="flow-gate-card__title">
          {VERDICT_TITLES[verdict.verdict]}
        </span>
        {verdict.verdict === 'route-back' && attemptLabel && (
          <span className="flow-gate-card__attempt">{attemptLabel}</span>
        )}
      </div>

      {verdict.summary && (
        <p className="flow-gate-card__summary">{verdict.summary}</p>
      )}

      {verdict.verdict === 'route-back' && (
        <>
          {verdict.nextAction && (
            <div className="flow-gate-card__guidance">{verdict.nextAction}</div>
          )}
          {verdict.routeBackTo && (
            <div className="flow-gate-card__meta">
              Routed back to step: <strong>{verdict.routeBackTo}</strong>
            </div>
          )}
        </>
      )}

      {verdict.verdict === 'block' && (
        <p className="flow-gate-card__exception">
          A human-accepted exception is required to proceed.
        </p>
      )}

      {verdict.verdict === 'wait' &&
        verdict.missing &&
        verdict.missing.length > 0 && (
          <>
            <div className="flow-gate-card__meta">Missing expectations:</div>
            <ul className="flow-gate-card__missing">
              {verdict.missing.map((expectation) => (
                <li key={expectation}>{expectation}</li>
              ))}
            </ul>
          </>
        )}

      {verdict.verdict === 'pass' && verdict.reportPaths && (
        <div className="flow-gate-card__reports">
          <ReportPathRow
            label="Run report (markdown)"
            path={verdict.reportPaths.markdown}
            onCopy={onCopy}
          />
          <ReportPathRow
            label="Run report (json)"
            path={verdict.reportPaths.json}
            onCopy={onCopy}
          />
        </div>
      )}

      {verdict.gateId && (
        <div className="flow-gate-card__meta">Gate: {verdict.gateId}</div>
      )}
    </section>
  );
}

function ReportPathRow({
  label,
  path,
  onCopy,
}: {
  label: string;
  path: string;
  onCopy?: (text: string) => void;
}) {
  return (
    <div className="flow-gate-card__report">
      <span className="flow-gate-card__report-path" title={label}>
        {path}
      </span>
      <button
        type="button"
        className="flow-gate-card__copy-btn"
        onClick={() => onCopy?.(path)}
        title={`Copy ${label} path`}
        aria-label={`Copy ${label} path`}
      >
        Copy path
      </button>
    </div>
  );
}
