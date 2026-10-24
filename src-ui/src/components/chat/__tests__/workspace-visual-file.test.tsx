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
import { MarkdownLinkContext } from '../MarkdownLinkContext';
import { MarkdownRenderer } from '../MarkdownRenderer';

const readVisual = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/workspace-file-preview', () => ({
  readProjectWorkspaceVisualFile: readVisual,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'operator',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/DeviceSettingsContext', () => ({
  useDeviceSettings: () => ({ theme: 'dark' }),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.clearAllMocks();
});
const path =
  '/home/brian/dev/github/kontourai/station-worktrees/queue-ui-concepts/mockups/queue/index.html';
function mount(markdown: string) {
  const client = new QueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MarkdownLinkContext.Provider
        value={{
          projectSlug: 'station',
          projectId: 'project',
          dockProjectSlug: 'station',
          projectRoots: ['/home/brian/dev/github/kontourai/station'],
          openPathInMain: null,
        }}
      >
        <MarkdownRenderer>{markdown}</MarkdownRenderer>
      </MarkdownLinkContext.Provider>
    </QueryClientProvider>,
  );
}

test('a host HTML link outside the session cwd mounts an isolated inline viewer instead of a navigation anchor', async () => {
  readVisual.mockResolvedValue({
    kind: 'html',
    page: { version: 1, html: '<h1>Queue concepts</h1>', height: 600 },
    frameOrigin: 'http://sandbox.test',
  });
  mount(`[Interactive mockup](${path}#a)`);
  const frame = await screen.findByTitle('Visual reply');
  expect(frame.getAttribute('src')).toBe(
    'http://sandbox.test/html-reply/frame',
  );
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
  expect(screen.queryByRole('link')).toBeNull();
  expect(readVisual.mock.calls[0].slice(0, 3)).toEqual([
    'http://station.test',
    'station',
    path,
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  expect(screen.getByRole('dialog', { name: 'Visual reply' })).toBeTruthy();
});

test('a host image reference reads image bytes through the Project instead of requesting a local app URL', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  readVisual.mockResolvedValue({
    kind: 'image',
    preview: {
      status: 'ready',
      path: 'mockups/queue/option-a.png',
      renderKind: 'image',
      mimeType: 'image/png',
      dataUrl: png,
    },
  });
  mount(`![Option A](${path.replace('index.html', 'option-a.png')})`);
  const image = await screen.findByAltText('option-a.png');
  expect(image.getAttribute('src')).toBe(png);
});

test('an unavailable local visual stays in the conversation with a visible error', async () => {
  readVisual.mockRejectedValue(
    new Error('This visual file is unavailable in this Project.'),
  );
  mount(`[Interactive mockup](${path})`);
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('unavailable'),
  );
  expect(screen.queryByRole('link')).toBeNull();
});
