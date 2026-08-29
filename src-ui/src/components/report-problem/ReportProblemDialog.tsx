/**
 * Report-a-problem dialog (#766 item 4).
 *
 * Shows the user exactly what a report would contain BEFORE anything is
 * built: route, build identity, channel, platform, and the recent captured
 * console errors/warnings. Two explicit exits — a prefilled GitHub new-issue
 * URL and a local Markdown bundle download — and nothing is ever sent
 * anywhere automatically.
 *
 * No screenshot capture: the only dependency-free browser API
 * (`getDisplayMedia`) is unavailable in the WKWebView the desktop app runs
 * in, so offering a checkbox that silently fails there would be a claim the
 * runtime cannot back. The issue template tells the user to attach
 * screenshots manually instead.
 *
 * Styling: reuses the eager `station-dialog__*` chrome plus inline styles
 * (the HelpMenu precedent) — deliberately no new CSS, because the entry
 * stylesheet ceiling has almost no headroom and this dialog lives in a lazy
 * chunk.
 */

import { useMemo } from 'react';
import { buildLabel } from '../../build-info';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import type { CapturedConsoleEntry } from './console-capture';
import {
  buildGitHubIssueUrl,
  type ReportContext,
  renderReportBundleText,
} from './report-content';

const fieldRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '4px 0',
  fontSize: 13,
};

const fieldLabelStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  flexShrink: 0,
};

export interface ReportProblemDialogProps {
  /**
   * Snapshot taken by `ReportProblemHost` at the moment of open. A prop, not
   * a `console-capture` value import: importing it here would force the
   * overlays chunk to grow a named export, whose facade costs the entry
   * chunk measured bytes (see the comment in `ReportProblemHost`).
   */
  consoleEntries: CapturedConsoleEntry[];
  onClose: () => void;
}

export function downloadReportBundle(
  text: string,
  now: Date = new Date(),
): void {
  const blob = new Blob([text], { type: 'text/markdown' });
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = `station-problem-report-${now.toISOString().slice(0, 10)}.md`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

export default function ReportProblemDialog({
  consoleEntries,
  onClose,
}: ReportProblemDialogProps) {
  const profile = usePlatformProfile();

  const context = useMemo<ReportContext>(
    () => ({
      // Pathname only — query params can carry session/conversation ids the
      // user did not review line-by-line, and the host is identity.
      route: window.location.pathname,
      version: buildLabel,
      ...(profile.channel ? { channel: profile.channel } : {}),
      platform: `${profile.target}${profile.isDevBuild ? ' (dev build)' : ''}`,
      consoleEntries,
    }),
    [consoleEntries, profile.channel, profile.isDevBuild, profile.target],
  );

  return (
    <Dialog
      eyebrow="Feedback"
      title="Report a problem"
      subtitle="Review what will be included. Nothing is sent until you choose where it goes."
      closeLabel="Close report a problem"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() =>
              downloadReportBundle(renderReportBundleText(context))
            }
          >
            Save report bundle
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              window.open(
                buildGitHubIssueUrl(context).url,
                '_blank',
                'noopener,noreferrer',
              );
            }}
          >
            Open GitHub issue
          </Button>
        </>
      }
    >
      <dl style={{ margin: 0 }}>
        <div style={fieldRowStyle}>
          <dt style={fieldLabelStyle}>Route</dt>
          <dd style={{ margin: 0 }} data-testid="report-problem-route">
            {context.route}
          </dd>
        </div>
        <div style={fieldRowStyle}>
          <dt style={fieldLabelStyle}>Version</dt>
          <dd style={{ margin: 0 }}>{context.version}</dd>
        </div>
        {context.channel && (
          <div style={fieldRowStyle}>
            <dt style={fieldLabelStyle}>Channel</dt>
            <dd style={{ margin: 0 }}>{context.channel}</dd>
          </div>
        )}
        <div style={fieldRowStyle}>
          <dt style={fieldLabelStyle}>Platform</dt>
          <dd style={{ margin: 0 }}>{context.platform}</dd>
        </div>
      </dl>

      <p
        style={{
          margin: '10px 0 6px',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        Recent console errors and warnings
      </p>
      {context.consoleEntries.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
          None captured.
        </p>
      ) : (
        <ul
          data-testid="report-problem-console"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 8,
            maxHeight: 180,
            overflowY: 'auto',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
          }}
        >
          {context.consoleEntries.map((entry, index) => (
            <li
              key={`${entry.at}-${index}`}
              style={{
                padding: '2px 0',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              [{entry.level}] {entry.message}
            </li>
          ))}
        </ul>
      )}

      <p
        style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)' }}
      >
        Screenshots are not captured automatically. If one would help, take it
        yourself and attach it to the GitHub issue — the issue body reminds you
        where.
      </p>
    </Dialog>
  );
}
