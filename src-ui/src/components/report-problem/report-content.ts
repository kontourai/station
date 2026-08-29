/**
 * Pure content builders for the Report-a-problem dialog (#766 item 4).
 *
 * Dependency-free and side-effect-free so the URL/truncation contract can be
 * pinned in unit tests. Nothing here reads the environment: every field in a
 * report arrives explicitly via `ReportContext`, which is also exactly what
 * the dialog renders for the user to review first. No env, no tokens, no
 * filesystem paths beyond the in-app route.
 */

import type { CapturedConsoleEntry } from './console-capture';

export interface ReportContext {
  /** In-app route pathname only — never query params or host identity. */
  route: string;
  /** Build label, e.g. `v0.1.2 · abc1234` (`v0.0.0 · dev` on dev builds). */
  version: string;
  /** Update channel when the platform reports one (native shells only). */
  channel?: string;
  /** Platform target, e.g. `web`, `macos (dev build)`. */
  platform: string;
  consoleEntries: CapturedConsoleEntry[];
}

export const REPORT_ISSUE_REPO = 'kontourai/station';

/**
 * GitHub rejects new-issue URLs somewhere past ~8k characters. Stay clearly
 * under it: the browser adds nothing, but the margin keeps this immune to
 * small template edits outgrowing the ceiling unnoticed.
 */
export const MAX_ISSUE_URL_LENGTH = 7_900;

function consoleSection(
  entries: CapturedConsoleEntry[],
  omittedCount: number,
): string {
  const lines =
    entries.length === 0
      ? '_None captured._'
      : [
          '```',
          ...entries.map(
            (entry) => `[${entry.level} ${entry.at}] ${entry.message}`,
          ),
          '```',
        ].join('\n');
  const omissionNote =
    omittedCount > 0
      ? `\n\n_${omittedCount} older console ${
          omittedCount === 1 ? 'entry was' : 'entries were'
        } omitted to fit GitHub's issue-URL length limit. Use "Save report bundle" for the full capture._`
      : '';
  return `${lines}${omissionNote}`;
}

function reportBody(context: ReportContext, omittedCount: number): string {
  return [
    '## What happened',
    '',
    '<!-- Describe what you expected and what you saw instead. If you took a screenshot, attach it here manually — Station never uploads anything automatically. -->',
    '',
    '## Captured context',
    '',
    `- Route: \`${context.route}\``,
    `- Version: ${context.version}`,
    ...(context.channel ? [`- Channel: ${context.channel}`] : []),
    `- Platform: ${context.platform}`,
    '',
    '## Recent console errors and warnings',
    '',
    consoleSection(context.consoleEntries, omittedCount),
    '',
  ].join('\n');
}

export function reportTitle(context: ReportContext): string {
  return `Problem report: ${context.route}`;
}

/** The full, untruncated report — what "Save report bundle" writes. */
export function renderReportBundleText(context: ReportContext): string {
  return `# Station problem report\n\n${reportBody(context, 0)}`;
}

export interface IssueUrlResult {
  url: string;
  /** Console entries dropped (oldest first) to fit the URL limit. */
  omittedEntryCount: number;
}

function assembleIssueUrl(context: ReportContext, omitted: number): string {
  const params = new URLSearchParams({
    title: reportTitle(context),
    body: reportBody(context, omitted),
    labels: 'bug',
  });
  return `https://github.com/${REPORT_ISSUE_REPO}/issues/new?${params.toString()}`;
}

/**
 * Builds the prefilled new-issue URL, dropping the OLDEST console entries one
 * at a time until the URL fits `MAX_ISSUE_URL_LENGTH`. When anything was
 * dropped, the body says so and points at the bundle — the report never
 * silently pretends the omitted entries did not exist.
 */
export function buildGitHubIssueUrl(context: ReportContext): IssueUrlResult {
  let entries = context.consoleEntries;
  let omitted = 0;
  let url = assembleIssueUrl({ ...context, consoleEntries: entries }, omitted);
  while (url.length > MAX_ISSUE_URL_LENGTH && entries.length > 0) {
    entries = entries.slice(1);
    omitted += 1;
    url = assembleIssueUrl({ ...context, consoleEntries: entries }, omitted);
  }
  return { url, omittedEntryCount: omitted };
}
