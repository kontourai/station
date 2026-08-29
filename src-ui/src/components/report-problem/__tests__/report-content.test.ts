import { describe, expect, test } from 'vitest';
import type { CapturedConsoleEntry } from '../console-capture';
import {
  buildGitHubIssueUrl,
  MAX_ISSUE_URL_LENGTH,
  type ReportContext,
  renderReportBundleText,
  reportTitle,
} from '../report-content';

function entry(message: string, level: 'error' | 'warn' = 'error') {
  return { level, message, at: '2026-08-29T00:00:00.000Z' };
}

const baseContext: ReportContext = {
  route: '/agents',
  version: 'v0.1.2 · abc1234',
  channel: 'stable',
  platform: 'macos',
  consoleEntries: [entry('Failed to fetch /api/system/capabilities', 'warn')],
};

function decodedBody(url: string): string {
  const body = new URL(url).searchParams.get('body');
  expect(body).toBeTruthy();
  return body as string;
}

describe('buildGitHubIssueUrl', () => {
  test('pins the new-issue URL shape: repo, title, labels, encoded body', () => {
    const { url, omittedEntryCount } = buildGitHubIssueUrl(baseContext);

    expect(omittedEntryCount).toBe(0);
    expect(
      url.startsWith('https://github.com/kontourai/station/issues/new?'),
    ).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('title')).toBe('Problem report: /agents');
    expect(parsed.searchParams.get('labels')).toBe('bug');

    const body = decodedBody(url);
    expect(body).toContain('- Route: `/agents`');
    expect(body).toContain('- Version: v0.1.2 · abc1234');
    expect(body).toContain('- Channel: stable');
    expect(body).toContain('- Platform: macos');
    expect(body).toContain(
      '[warn 2026-08-29T00:00:00.000Z] Failed to fetch /api/system/capabilities',
    );
    // The template owns the manual-screenshot contract: nothing uploads.
    expect(body).toContain('attach it here manually');
    expect(body).toContain('never uploads anything automatically');
    // Everything after `?` is URLSearchParams-encoded — no raw spaces,
    // backticks, or newlines survive into the URL itself.
    const query = url.slice(url.indexOf('?') + 1);
    expect(query).not.toMatch(/[ \n`]/);
  });

  test('URL-encodes hostile route and message characters round-trip', () => {
    const { url } = buildGitHubIssueUrl({
      ...baseContext,
      route: '/agents/a&b=c#d',
      consoleEntries: [entry('<img src=x> & "quotes" + 100%')],
    });
    const body = decodedBody(url);
    expect(body).toContain('- Route: `/agents/a&b=c#d`');
    expect(body).toContain('<img src=x> & "quotes" + 100%');
  });

  test('omits a channel line when the platform reports no channel', () => {
    const { channel: _channel, ...noChannel } = baseContext;
    const body = decodedBody(buildGitHubIssueUrl(noChannel).url);
    expect(body).not.toContain('- Channel:');
  });

  test('drops oldest console entries with a note to stay under the URL limit', () => {
    const entries: CapturedConsoleEntry[] = Array.from(
      { length: 20 },
      (_, index) => entry(`entry-${index} ${'x'.repeat(580)}`),
    );
    const context = { ...baseContext, consoleEntries: entries };

    const { url, omittedEntryCount } = buildGitHubIssueUrl(context);

    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    expect(omittedEntryCount).toBeGreaterThan(0);
    expect(omittedEntryCount).toBeLessThan(20);

    const body = decodedBody(url);
    // Oldest dropped, newest kept.
    expect(body).not.toContain('entry-0 ');
    expect(body).toContain('entry-19 ');
    // The omission is disclosed in the body, pointing at the full bundle.
    expect(body).toContain(
      `${omittedEntryCount} older console entries were omitted`,
    );
    expect(body).toContain('Save report bundle');
  });

  test('a fitting report carries no omission note', () => {
    const body = decodedBody(buildGitHubIssueUrl(baseContext).url);
    expect(body).not.toContain('omitted to fit');
  });
});

describe('renderReportBundleText', () => {
  test('carries the full untruncated capture and the same context fields', () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry(`bundle-entry-${index}`),
    );
    const text = renderReportBundleText({
      ...baseContext,
      consoleEntries: entries,
    });

    expect(text).toContain('# Station problem report');
    expect(text).toContain('- Route: `/agents`');
    expect(text).toContain('- Version: v0.1.2 · abc1234');
    expect(text).toContain('bundle-entry-0');
    expect(text).toContain('bundle-entry-19');
    expect(text).not.toContain('omitted to fit');
  });

  test('reports an empty capture as such rather than omitting the section', () => {
    const text = renderReportBundleText({
      ...baseContext,
      consoleEntries: [],
    });
    expect(text).toContain('## Recent console errors and warnings');
    expect(text).toContain('_None captured._');
  });
});

describe('reportTitle', () => {
  test('names the route', () => {
    expect(reportTitle(baseContext)).toBe('Problem report: /agents');
  });
});
