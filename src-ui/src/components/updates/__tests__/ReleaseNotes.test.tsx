/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ReleaseHistory, ReleaseNotes } from '../ReleaseNotes';

const clients: QueryClient[] = [];
function mount(ui: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});
const release = (tag: string, body: string) => ({
  tag_name: tag,
  name: `Station ${tag}`,
  body,
  draft: false,
});

test('the proposal renders the exact desktop release markdown without sending Station credentials or loading images', async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      release(
        'desktop-v0.1.11-nightly.2499.3',
        '## Features\n- New workspace tools\n\n[More](https://example.test/notes)\n\n![Screenshot](https://example.test/tracker.png)',
      ),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  mount(<ReleaseNotes version="0.1.11-nightly.2499.3" nativeApp />);
  expect(await screen.findByRole('heading', { name: 'Features' })).toBeTruthy();
  expect(screen.getByText('New workspace tools').tagName).toBe('LI');
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByRole('link', { name: 'More' }).getAttribute('rel')).toBe(
    'noopener noreferrer',
  );
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.github.com/repos/kontourai/station/releases/tags/desktop-v0.1.11-nightly.2499.3',
    expect.objectContaining({
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' },
    }),
  );
});

test('history loads on demand and lets the person select a previous version', async () => {
  const fetcher = vi.fn(async () =>
    Response.json([
      release('desktop-v0.1.11-nightly.2499.3', '- Latest desktop changes'),
      release('v0.1.10', '- Earlier release changes'),
      release('nightly-desktop', 'Rolling metadata'),
    ]),
  );
  vi.stubGlobal('fetch', fetcher);
  mount(<ReleaseHistory />);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Previous versions and changelogs'));
  await screen.findByText('Latest desktop changes');
  fireEvent.change(screen.getByRole('combobox', { name: 'Release' }), {
    target: { value: 'v0.1.10' },
  });
  expect(screen.getByText('Earlier release changes')).toBeTruthy();
  expect(screen.queryByText('Latest desktop changes')).toBeNull();
  expect(screen.queryByText('Rolling metadata')).toBeNull();
  expect(
    screen
      .getByRole('link', { name: 'View this release on GitHub' })
      .getAttribute('href'),
  ).toBe('https://github.com/kontourai/station/releases/tag/v0.1.10');
});

test('an unavailable GitHub read retains updater notes and can be retried', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockImplementation(async () =>
      Response.json(release('v0.1.12', '- Published features')),
    );
  vi.stubGlobal('fetch', fetcher);
  mount(<ReleaseNotes version="0.1.12" notes="- Notes from the update feed" />);
  expect(screen.getByText('Notes from the update feed')).toBeTruthy();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Retry release notes' }),
  );
  expect(await screen.findByText('Published features')).toBeTruthy();
});

test('a missing exact release never substitutes the rolling latest release', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockImplementation(async () =>
      Response.json(
        release(
          'desktop-v0.1.11-nightly.2499.3',
          '- Newly published changelog',
        ),
      ),
    );
  vi.stubGlobal('fetch', fetcher);
  mount(<ReleaseNotes version="0.1.11-nightly.2499.3" nativeApp />);
  await screen.findByText(
    'A changelog has not been published for this version.',
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(
    screen.getByRole('button', { name: 'Check release notes again' }),
  );
  expect(await screen.findByText('Newly published changelog')).toBeTruthy();
});

test('in-app changelogs omit installation instructions but retain later change sections', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        release(
          'v0.1.11',
          '## Features\n- Workspace changes\n\n## Installation\n\n```sh\ncurl https://example.test/install.sh | sh\n```\n\n## Fixes\n- Recovery fix',
        ),
      ),
    ),
  );
  mount(<ReleaseNotes version="0.1.11" />);
  await screen.findByText('Workspace changes');
  expect(screen.queryByText('Installation')).toBeNull();
  expect(screen.queryByText(/curl https/)).toBeNull();
  expect(screen.getByText('Recovery fix')).toBeTruthy();
});

const legacyBody =
  "Portable server Nightly 0.1.11-nightly.2026111300 from 76c30c3b8dbaf4b36795ec4b0ed73902b3674509. Install with: curl -fsSL https://raw.githubusercontent.com/kontourai/station/main/install.sh | STATION_CHANNEL=nightly sh (this release's install.sh and install.ps1 are the installers at 76c30c3b8dbaf4b36795ec4b0ed73902b3674509). These assets are immutable.";
test.each([
  '\n\n## Installation\n\nInstall fixture\n',
  legacyBody,
  'Portable server Nightly 0.1.11-nightly.247504 from f5e21369361e6edf855dc9a2671f68aa3473556f. Install through the signed rolling manifest (portable-nightly); these assets are immutable.',
])(
  'install-only published bodies show the missing changelog state: %s',
  async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(release('v0.1.11', body))),
    );
    mount(<ReleaseNotes version="0.1.11" />);
    expect(await screen.findByText('Release notes unavailable')).toBeTruthy();
    expect(screen.queryByText(/Install fixture|curl -fsSL/)).toBeNull();
  },
);
test('legacy stripping preserves ordinary installation discussion', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        release(
          'v0.1.11',
          '- Improved install.sh diagnostics. Install with curl as usual.',
        ),
      ),
    ),
  );
  mount(<ReleaseNotes version="0.1.11" />);
  expect(
    await screen.findByText(
      'Improved install.sh diagnostics. Install with curl as usual.',
    ),
  ).toBeTruthy();
});

test.each([false, true])(
  'long notes show fifty entries and a full release link (fallback=%s)',
  async (fallback) => {
    const body =
      '## What Changed\n' +
      Array.from({ length: 2000 }, (_, i) => `- Entry ${i + 1}`).join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fallback
          ? new Response('', { status: 404 })
          : Response.json(release('v0.1.11', body)),
      ),
    );
    mount(
      <ReleaseNotes version="0.1.11" notes={fallback ? body : undefined} />,
    );
    await screen.findByText('Entry 50');
    expect(screen.queryByText('Entry 51')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(
      screen
        .getByRole('link', { name: 'See all changes' })
        .getAttribute('href'),
    ).toBe('https://github.com/kontourai/station/releases/tag/v0.1.11');
  },
);
