/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CapturedConsoleEntry } from '../console-capture';
import ReportProblemDialog from '../ReportProblemDialog';

let profileMock: Record<string, unknown> = {
  target: 'macos',
  channel: 'stable',
  isDevBuild: false,
};

vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => profileMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  profileMock = { target: 'macos', channel: 'stable', isDevBuild: false };
});

function entries(...messages: string[]): CapturedConsoleEntry[] {
  return messages.map((message) => ({
    level: 'error' as const,
    message,
    at: '2026-08-29T00:00:00.000Z',
  }));
}

describe('ReportProblemDialog', () => {
  test('previews every captured field before anything is built', () => {
    window.history.pushState({}, '', '/agents?chat=secret-id');
    render(
      <ReportProblemDialog
        consoleEntries={entries('capabilities fetch failed', 'second failure')}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Report a problem' }),
    ).toBeTruthy();
    // Route is the pathname ONLY — query params never enter the report.
    expect(screen.getByTestId('report-problem-route').textContent).toBe(
      '/agents',
    );
    // jsdom has no build meta tags, so the honest dev fallback renders.
    expect(screen.getByText('v0.0.0 · dev')).toBeTruthy();
    expect(screen.getByText('stable')).toBeTruthy();
    expect(screen.getByText('macos')).toBeTruthy();
    const consoleList = screen.getByTestId('report-problem-console');
    expect(consoleList.textContent).toContain('capabilities fetch failed');
    expect(consoleList.textContent).toContain('second failure');
    expect(
      screen.getByRole('button', { name: 'Open GitHub issue' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Save report bundle' }),
    ).toBeTruthy();
    // The screenshot story is explicit: manual attachment, no capture.
    expect(
      screen.getByText(/Screenshots are not captured automatically/),
    ).toBeTruthy();
  });

  test('says "None captured." rather than hiding an empty console section', () => {
    render(<ReportProblemDialog consoleEntries={[]} onClose={vi.fn()} />);
    expect(screen.getByText('None captured.')).toBeTruthy();
  });

  test('Open GitHub issue opens the prefilled new-issue URL in a new tab', () => {
    window.history.pushState({}, '', '/schedule');
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(null as unknown as Window);

    render(
      <ReportProblemDialog
        consoleEntries={entries('job never ran')}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open GitHub issue' }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target, features] = openSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      'https://github.com/kontourai/station/issues/new?',
    );
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get('title')).toBe('Problem report: /schedule');
    expect(parsed.searchParams.get('body')).toContain('job never ran');
    expect(target).toBe('_blank');
    expect(features).toContain('noopener');
  });

  test('Save report bundle downloads the full markdown report locally', async () => {
    window.history.pushState({}, '', '/computers');

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:report');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    render(
      <ReportProblemDialog
        consoleEntries={entries('peers add does not exist')}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save report bundle' }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    const text = await (blob as Blob).text();
    expect(text).toContain('# Station problem report');
    expect(text).toContain('- Route: `/computers`');
    expect(text).toContain('peers add does not exist');
  });

  test('omits the channel row when the platform reports no channel', () => {
    profileMock = { target: 'web', isDevBuild: false };
    render(<ReportProblemDialog consoleEntries={[]} onClose={vi.fn()} />);
    expect(screen.queryByText('Channel')).toBeNull();
    expect(screen.getByText('web')).toBeTruthy();
  });
});
