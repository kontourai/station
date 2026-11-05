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
  const fetcher = vi.fn(async () => new Response('', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  mount(<ReleaseNotes version="0.1.11-nightly.2499.3" nativeApp />);
  await screen.findByText(
    'A changelog has not been published for this version.',
  );
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('alert')).toBeNull();
});
