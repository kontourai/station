import { LazyMarkdown } from './LazyMarkdown';
import './chat.css';

interface SystemEventMessageProps {
  content: string;
  messageKey: string;
  /**
   * Optional recovery affordance rendered under the message — used by the
   * failed-turn marker so a cut-short turn can be resent without retyping
   * (#797).
   */
  action?: { label: string; onClick: () => void };
}

export function SystemEventMessage({
  content,
  messageKey,
  action,
}: SystemEventMessageProps) {
  return (
    <div
      key={messageKey}
      className="message system-event"
      style={{
        padding: '8px 12px',
        margin: '8px 0',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: '6px',
        fontSize: '0.85em',
        fontStyle: 'italic',
        color: 'var(--text-muted)',
        textAlign: 'center',
      }}
    >
      <LazyMarkdown>{content}</LazyMarkdown>
      {action && (
        <button
          type="button"
          className="system-event__action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
