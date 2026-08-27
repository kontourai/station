import type { ToolProgressSummary } from '../../utils/chat-progress';

interface ToolProgressIndicatorProps {
  summary: ToolProgressSummary;
}

export function ToolProgressIndicator({ summary }: ToolProgressIndicatorProps) {
  const alternativeLabel = `Running ${summary.toolName}`;
  const showToolName = summary.label !== alternativeLabel;

  return (
    <div className="streaming-progress" role="status" aria-live="polite">
      <span className="streaming-progress__pulse" aria-hidden="true" />
      <div className="streaming-progress__body">
        <div className="streaming-progress__label">{summary.label}</div>
        {showToolName && (
          <div className="streaming-progress__tool">{summary.toolName}</div>
        )}
      </div>
    </div>
  );
}
