/** @vitest-environment jsdom */
import type { PullRequestReviewGuideResult } from '@kontourai/station-contracts/pull-request-review-guide';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PullRequestGuide } from '../PullRequestGuide';

const remote = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@kontourai/station-sdk/pull-request-review', () => ({
  getPullRequestGuide: remote.read,
  writePullRequestGuide: remote.write,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'owner',
    isCurrent: () => true,
  }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const target = {
  project: 'p',
  provider: 'github',
  host: 'github.com',
  owner: 'o',
  repository: 'r',
  ref: '17',
};
const head = 'a'.repeat(40);
const result = (): PullRequestReviewGuideResult & { enabled: true } => ({
  enabled: true,
  currentHeadSha: head,
  run: null,
  excerptContents: [
    { path: 'a.ts', side: 'new', start: 1, lines: ['const visible = true;'] },
  ],
  guide: {
    headSha: head,
    generatedAt: '2026-10-17T00:00:00.000Z',
    modelSelection: 'test-model',
    stops: [
      {
        title: 'The new contract',
        summary: 'A clear contract.',
        attention: { kind: 'contract', note: 'Judge compatibility.' },
        excerpts: [
          { path: 'a.ts', side: 'new', start: 1, end: 1, caption: 'Contract' },
        ],
        files: [],
        notes: [],
        questions: ['Why this shape?'],
      },
      {
        title: 'Mechanical files',
        summary: 'Review the remaining files.',
        attention: null,
        excerpts: [],
        files: [{ path: 'lock.json' }],
        notes: [],
        questions: [],
      },
    ],
  },
});
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <PullRequestGuide target={target} headSha={head} />
    </QueryClientProvider>,
  );
}
test('renders excerpts and decisions, navigates stops, and sends rewrite through the generation client', async () => {
  remote.read.mockResolvedValue(result());
  remote.write.mockResolvedValue(result());
  mount();
  await screen.findByRole('heading', { name: 'The new contract' });
  expect(screen.getByText(/1\s+const visible = true;/)).toBeTruthy();
  expect(screen.getByText('Judge compatibility.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(
    screen.getByRole('heading', { name: 'Mechanical files' }),
  ).toBeTruthy();
  expect(screen.getByText('lock.json')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Rewrite guide' }));
  await waitFor(() => expect(remote.write).toHaveBeenCalledTimes(1));
});
test('hides obsolete code even if a stale response contains excerpts', async () => {
  const stale = result();
  stale.currentHeadSha = 'b'.repeat(40);
  remote.read.mockResolvedValue(stale);
  mount();
  await screen.findByRole('heading', { name: 'The new contract' });
  expect(screen.getByText(/earlier revision/)).toBeTruthy();
  expect(screen.queryByText(/1\s+const visible = true;/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Rewrite guide' })).toBeTruthy();
});
