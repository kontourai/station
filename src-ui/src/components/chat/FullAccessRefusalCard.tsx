import { useState } from 'react';
import type { FullAccessRefusalNotice } from '../../utils/approvalMode';

/**
 * #1796: a refused full-access pick or send, rendered from the refusal's
 * parsed `details` as plain React text. Nothing here is Markdown or HTML:
 * the device's name is chosen by whoever paired it, so it is shown only as
 * text, never as a link or formatting.
 */
export function FullAccessRefusalCard({
  notice,
}: {
  notice: FullAccessRefusalNotice;
}) {
  const { details, outcome } = notice;
  const grant = details?.grant ?? null;
  const requester = details?.requester;
  const command =
    grant?.cli ??
    (details
      ? undefined
      : 'station environment access scope <device> --add approval:full-access');
  return (
    <div data-testid="full-access-refusal" style={{ lineHeight: 1.5 }}>
      <div style={{ fontWeight: 600 }}>Full access was not applied</div>
      <p style={{ margin: '4px 0 0' }}>
        {outcome === 'message-not-sent'
          ? `Your message was not sent, and nothing ran.${
              notice.draftRestored ? ' It is back in the composer.' : ''
            }`
          : 'Your pick was not applied. This chat keeps its current approval mode.'}
      </p>
      {requester?.kind === 'agent' || (details && !grant) ? (
        <p style={{ margin: '8px 0 0' }}>
          An agent can never put itself, or any session, at full access. A
          person must choose it in Station, from a device the operator has
          allowed full access.
        </p>
      ) : (
        <>
          <p style={{ margin: '8px 0 0' }}>
            Ask the operator to allow full access for{' '}
            {requester?.kind === 'device' ? (
              <>
                <strong>{requester.deviceName}</strong>{' '}
                <span style={{ color: 'var(--text-muted)' }}>
                  (id {requester.deviceId})
                </span>
              </>
            ) : (
              'this device'
            )}
            .
          </p>
          {command && (
            <>
              <p style={{ margin: '8px 0 4px' }}>
                On the Station&apos;s host, the operator runs:
              </p>
              <CommandBlock command={command} />
            </>
          )}
          {grant && grant.uiSteps.length > 0 && (
            <>
              <p style={{ margin: '8px 0 4px' }}>
                {command
                  ? 'Or, in the Station desktop app:'
                  : 'In the Station desktop app:'}
              </p>
              <ol style={{ margin: 0, paddingLeft: '20px' }}>
                {grant.uiSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </div>
  );
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        background: 'var(--bg-tertiary, var(--bg-primary))',
        border: '1px solid var(--border-primary)',
        borderRadius: '4px',
        padding: '8px',
      }}
    >
      <pre
        style={{
          margin: 0,
          flex: 1,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: '0.9em',
        }}
      >
        <code>{command}</code>
      </pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        aria-label="Copy the command"
        style={{
          background: 'none',
          border: '1px solid var(--border-primary)',
          borderRadius: '4px',
          color: 'var(--text-secondary, inherit)',
          cursor: 'pointer',
          fontSize: '12px',
          padding: '2px 8px',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
