import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import type { CapturedConsoleEntry } from '../console-capture';
import {
  buildGitHubIssueUrl,
  MAX_ISSUE_URL_LENGTH,
  type ReportContext,
  renderReportBundleText,
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

/** Query keys that steer GitHub's new-issue page rather than a form field. */
const PAGE_PARAMS = new Set(['template', 'title']);

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

function field(url: string, id: string): string {
  const value = params(url).get(id);
  expect(value, `missing field '${id}'`).toBeTruthy();
  return value as string;
}

interface IssueFormField {
  type: string;
  id?: string;
}

function bugReportFormFields(): IssueFormField[] {
  const source = readFileSync(
    join(
      import.meta.dirname,
      '../../../../../.github/ISSUE_TEMPLATE/bug-report.yml',
    ),
    'utf8',
  );
  const form = load(source) as { body: IssueFormField[] };
  return form.body;
}

describe('buildGitHubIssueUrl', () => {
  test('opens the bug-report form prefilled by field id, with no free-form body or labels', () => {
    const { url, omittedEntryCount } = buildGitHubIssueUrl(baseContext);

    expect(omittedEntryCount).toBe(0);
    expect(
      url.startsWith('https://github.com/kontourai/station/issues/new?'),
    ).toBe(true);
    const query = params(url);
    expect(query.get('template')).toBe('bug-report.yml');
    expect(query.get('title')).toBe('bug: problem on /agents');
    // A `body` would replace the form's fields; the form applies `bug`.
    expect(query.has('body')).toBe(false);
    expect(query.has('labels')).toBe(false);
    expect([...query.keys()].sort()).toEqual([
      'build-identity',
      'observed-behavior',
      'redacted-diagnostic',
      'template',
      'title',
    ]);

    expect(field(url, 'build-identity')).toBe(
      'v0.1.2 · abc1234 (stable channel)',
    );
    const observed = field(url, 'observed-behavior');
    expect(observed).toContain('- Route: `/agents`');
    // The platform dropdown is not URL-prefillable, so it travels as text.
    expect(observed).toContain('- Platform: macos');
    // The form keeps the manual-screenshot contract: nothing uploads.
    expect(observed).toContain('attach it here');
    expect(observed).toContain('never uploads anything automatically');
    expect(field(url, 'redacted-diagnostic')).toContain(
      '[warn 2026-08-29T00:00:00.000Z] Failed to fetch /api/system/capabilities',
    );
    // Everything after `?` is URLSearchParams-encoded — no raw spaces,
    // backticks, or newlines survive into the URL itself.
    expect(url.slice(url.indexOf('?') + 1)).not.toMatch(/[ \n`]/);
  });

  test('every prefilled field id is a text field declared in bug-report.yml', () => {
    const fields = bugReportFormFields();
    const declared = new Map(
      fields.flatMap((formField) =>
        formField.id ? [[formField.id, formField.type] as const] : [],
      ),
    );
    // Pinned next to the derived set, so the test cannot pass vacuously.
    expect(declared.get('build-identity')).toBe('input');
    expect(declared.get('observed-behavior')).toBe('textarea');
    expect(declared.get('redacted-diagnostic')).toBe('textarea');

    const { url } = buildGitHubIssueUrl(baseContext);
    const fieldIds = [...params(url).keys()].filter(
      (key) => !PAGE_PARAMS.has(key),
    );
    expect(fieldIds.length).toBeGreaterThan(0);
    for (const id of fieldIds) {
      expect(declared.has(id), `'${id}' is not a bug-report.yml field`).toBe(
        true,
      );
      expect(['input', 'textarea']).toContain(declared.get(id));
    }
  });

  test('URL-encodes hostile route and message characters round-trip', () => {
    const { url } = buildGitHubIssueUrl({
      ...baseContext,
      route: '/agents/a&b=c#d',
      consoleEntries: [entry('<img src=x> & "quotes" + 100%')],
    });
    expect(field(url, 'observed-behavior')).toContain(
      '- Route: `/agents/a&b=c#d`',
    );
    expect(params(url).get('title')).toBe('bug: problem on /agents/a&b=c#d');
    expect(field(url, 'redacted-diagnostic')).toContain(
      '<img src=x> & "quotes" + 100%',
    );
  });

  test('omits the channel when the platform reports none', () => {
    const { channel: _channel, ...noChannel } = baseContext;
    const { url } = buildGitHubIssueUrl(noChannel);
    expect(field(url, 'build-identity')).toBe('v0.1.2 · abc1234');
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

    const diagnostic = field(url, 'redacted-diagnostic');
    // Oldest dropped, newest kept.
    expect(diagnostic).not.toContain('entry-0 ');
    expect(diagnostic).toContain('entry-19 ');
    // The omission is disclosed, pointing at the full bundle.
    expect(diagnostic).toContain(
      `${omittedEntryCount} older console entries were omitted`,
    );
    expect(diagnostic).toContain('Save report bundle');
  });

  test('a fitting report carries no omission note', () => {
    const { url } = buildGitHubIssueUrl(baseContext);
    expect(field(url, 'redacted-diagnostic')).not.toContain('omitted to fit');
  });

  test('an empty capture says so in the diagnostic field', () => {
    const { url } = buildGitHubIssueUrl({ ...baseContext, consoleEntries: [] });
    expect(field(url, 'redacted-diagnostic')).toBe('_None captured._');
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
    expect(text).toContain('- Channel: stable');
    expect(text).toContain('- Platform: macos');
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
