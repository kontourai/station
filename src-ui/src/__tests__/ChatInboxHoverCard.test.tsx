// @vitest-environment jsdom

/**
 * The inbox row's metadata hover card: hover/focus opens a display-only
 * card carrying the row's project/machine/engine/status metadata, the local
 * session's git facts,
 * the conversation's linked pull requests, and the session's basis
 * inventory.
 *
 * Every test enters through `InboxRow` — the real caller — because the
 * feature IS the row→card handoff: a card tested in isolation would not
 * prove hover opens it, that a touch pointer does not, or that the host
 * resolves the cwd the git section reads.
 *
 * Honesty contracts pinned here (each would fail if reverted):
 * - a touch/pen pointer never opens the card;
 * - no host-resolved cwd renders no git section and never queries git;
 * - a checkout the git endpoint positively reported as a NON-repo
 *   suppresses the pull-request section entirely (pull requests are listed
 *   for projects that have Git) — and the links endpoint is not fetched;
 * - PR rows are bounded previews with a "+N more" pointer, and each row
 *   keeps its provenance (explicit / branch-derived / Task-kept);
 * - the basis section reads the WHOLE-SESSION scope for the row's own
   session id, renders real group counts and item labels, and is absent
 *   for a row with no session id — never fabricated.
 */

import { SESSION_INVENTORY_V2 } from '@kontourai/station-contracts/session-inventory';
import {
  type OrchestrationSessionSummary,
  useGitStatusQuery,
  useOrchestrationSessionsQuery,
} from '@kontourai/station-sdk';
import { getConversationPullRequestLinks } from '@kontourai/station-sdk/conversation-pull-request-links';
import { useSessionInventoryQuery } from '@kontourai/station-sdk/session-inventory';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxRow } from '../components/chat-dock/ChatDockInboxRows';
import { HomeRecentWorkSection } from '../components/home/HomeRecentWorkSection';
import {
  buildOrchestrationItems,
  type HomeWorkItem,
} from '../views/home/home-view-model';
import { useHomeWorkLanes } from '../views/home/useHomeWorkLanes';

vi.mock(
  '@kontourai/station-sdk',
  async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return {
      ...actual,
      useGitStatusQuery: vi.fn(),
      // Home's rows read their git locations and project colours from these
      // (`useGitLocationByThreadId`, `useProjectAccents`).
      useOrchestrationSessionsQuery: vi.fn(() => ({ data: [] })),
      useProjectsQuery: vi.fn(() => ({ data: [], isSuccess: true })),
    };
  },
);
vi.mock('@kontourai/station-sdk/conversation-pull-request-links', () => ({
  getConversationPullRequestLinks: vi.fn(),
  linkConversationPullRequest: vi.fn(),
  unlinkConversationPullRequest: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/session-inventory', () => ({
  useSessionInventoryQuery: vi.fn(),
}));
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'test-authority',
    isCurrent: () => true,
  }),
}));

const NOW = Date.parse('2026-09-13T12:00:00Z');

function workItem(overrides: Partial<HomeWorkItem> = {}): HomeWorkItem {
  return {
    id: 'thread-1',
    kind: 'orchestration',
    kindLabel: 'Session',
    title: 'Cross-machine project repository mapping',
    projectLabel: 'kontourai/station',
    agentLabel: 'Codex',
    modelLabel: 'GPT-6 Astra',
    updatedAt: NOW - 60_000,
    lifecycleLabel: 'Failed',
    failureNotice: 'Engine exited before answering.',
    conversationId: 'conv-1',
    orchestrationThreadId: 'thread-1',
    ...overrides,
  };
}

function gitRepo() {
  return {
    isRepo: true as const,
    branch: 'main',
    changes: ['a.ts', 'b.ts', 'c.ts'],
    staged: 1,
    unstaged: 2,
    untracked: 0,
    lastCommit: {
      sha: 'abc1234',
      author: 'Casey',
      relativeTime: '2h ago',
      message: 'feat(projects): expose portable identity',
    },
    ahead: 2,
    behind: 0,
  };
}

function v2Projection() {
  // Widened field types so individual tests can override state/items without
  // fighting the all-empty literal the base fixture starts as.
  const groups = (
    [
      'inputs',
      'sources',
      'work-items',
      'execution',
      'decisions',
      'outputs',
      'verification-delivery',
      'live-now',
      'kept',
      'attention',
      'resources',
    ] as const
  ).map((id) => ({
    id,
    owner: { owner: 'station.inventory', id: 'v2' },
    state: 'empty' as 'empty' | 'available',
    count: { kind: 'exact' as const, value: 0 },
    items: [] as Array<Record<string, unknown>>,
    gaps: [] as string[],
  }));
  return {
    version: SESSION_INVENTORY_V2,
    scope: { kind: 'whole-session', sessionId: 'thread-1' },
    groups,
  };
}

function prLinks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    provider: 'github',
    host: 'github.com',
    repository: { owner: 'kontourai', name: 'station' },
    ref: String(2033 + index),
    source: index === 0 ? ('explicit' as const) : ('branch-derived' as const),
    observedAt: '2026-09-13T11:00:00.000Z',
    status: {
      state: 'current' as const,
      title: `feat(projects): portable identity part ${index}`,
      pullRequestState: 'OPEN',
    },
  }));
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderRow(
  item: HomeWorkItem,
  cwd?: string,
  project: { projectAccent?: string; projectIcon?: string } = {},
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <InboxRow
        item={item}
        isCurrent={false}
        isSnoozed={false}
        isOpenChat={false}
        now={NOW}
        onActivate={vi.fn()}
        gitLocation={
          cwd ? { projectSlug: 'station', workingDir: cwd } : undefined
        }
        {...project}
      />
    </QueryClientProvider>,
  );
}

function hoverRow() {
  fireEvent.pointerEnter(screen.getByTestId('inbox-row'), {
    pointerType: 'mouse',
  });
}

async function openCard(
  item: HomeWorkItem,
  cwd?: string,
  project?: { projectAccent?: string; projectIcon?: string },
) {
  renderRow(item, cwd, project);
  // Focus opens immediately (no hover delay) — the keyboard path, and the
  // deterministic way for a test to mount the card.
  fireEvent.focus(screen.getByTestId('inbox-row'));
  return screen.findByTestId('inbox-row-hover-card');
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  vi.mocked(useGitStatusQuery).mockReturnValue({
    data: null,
    isLoading: false,
    error: null,
  } as never);
  vi.mocked(useSessionInventoryQuery).mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
  } as never);
  vi.mocked(getConversationPullRequestLinks).mockResolvedValue({
    conversationId: 'conv-1',
    observedAt: '2026-09-13T11:00:00.000Z',
    links: [],
  });
});

describe('inbox hover card opening (through the real row)', () => {
  it('hover opens the metadata card after the reveal delay', async () => {
    renderRow(workItem());
    hoverRow();
    // Not immediate: a row crossed in passing must not flash a card.
    expect(screen.queryByTestId('inbox-row-hover-card')).toBeNull();
    // Generous ceiling: this pins "not instant, then open" — the first open
    // also pays the card chunk's import, so latency here is not the claim.
    await waitFor(
      () => expect(screen.getByTestId('inbox-row-hover-card')).toBeTruthy(),
      { timeout: 8_000 },
    );
  });

  it('a touch pointer never opens the card', async () => {
    renderRow(workItem());
    fireEvent.pointerEnter(screen.getByTestId('inbox-row'), {
      pointerType: 'touch',
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByTestId('inbox-row-hover-card')).toBeNull();
  });

  it('leaving the row closes the card', async () => {
    renderRow(workItem());
    hoverRow();
    await screen.findByTestId('inbox-row-hover-card');
    fireEvent.pointerLeave(screen.getByTestId('inbox-row'));
    expect(screen.queryByTestId('inbox-row-hover-card')).toBeNull();
  });

  it('focus opens it immediately and blur closes it', async () => {
    renderRow(workItem());
    // Focus runs no reveal timer: the card mounts as soon as its chunk
    // resolves (first open pays the import), with no hover dwell anywhere in
    // the path — no pointerEnter has happened in this test.
    fireEvent.focus(screen.getByTestId('inbox-row'));
    await screen.findByTestId('inbox-row-hover-card');
    fireEvent.blur(screen.getByTestId('inbox-row'));
    expect(screen.queryByTestId('inbox-row-hover-card')).toBeNull();
  });

  it('any scroll closes the card — a detached tooltip is a lie about the row under it', async () => {
    const card = await openCard(workItem());
    expect(card.style.visibility).toBe('visible');
    fireEvent.scroll(window);
    expect(screen.queryByTestId('inbox-row-hover-card')).toBeNull();
  });
});

describe('inbox hover card metadata sections', () => {
  it("the Project row carries the row's project icon, else its colour", async () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    await openCard(workItem(), undefined, {
      projectAccent: 'var(--event-tool-call)',
      projectIcon: image,
    });
    const projectRow = screen
      .getByText('Project', { selector: 'dt' })
      .closest('div') as HTMLElement;
    const mark = projectRow.querySelector<HTMLElement>(
      '.chat-dock-inbox-hover-card__project-mark',
    );
    expect(mark?.querySelector('img')?.getAttribute('src')).toBe(image);
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(projectRow.textContent).toContain('kontourai/station');
  });

  it('a project with no icon shows its colour dot in the Project row', async () => {
    await openCard(workItem(), undefined, {
      projectAccent: 'var(--event-tool-call)',
    });
    const mark = screen
      .getByText('Project', { selector: 'dt' })
      .closest('div')
      ?.querySelector<HTMLElement>('.chat-dock-inbox-hover-card__project-mark');
    expect(mark?.classList.contains('project-icon--dot')).toBe(true);
    expect(mark?.style.backgroundColor).toBe('var(--event-tool-call)');
  });

  it('renders the project, machine, engine, and status the row already knows', async () => {
    await openCard(
      workItem({
        kind: 'remote-session',
        environmentId: 'env-1',
        environmentLabel: 'desktop-win',
        orchestrationThreadId: undefined,
        conversationId: undefined,
      }),
    );
    const card = screen.getByTestId('inbox-row-hover-card');
    expect(card.textContent).toContain('kontourai/station');
    expect(card.textContent).toContain('desktop-win');
    expect(card.textContent).toContain('Codex · GPT-6 Astra');
    // The failure chip's observation, same contract as the row: the chip is
    // a pointer, this is what computed it.
    expect(card.textContent).toContain('Engine exited before answering.');
  });

  it('asks git about the host-resolved cwd and renders its facts', async () => {
    vi.mocked(useGitStatusQuery).mockReturnValue({
      data: gitRepo(),
      isLoading: false,
      error: null,
    } as never);
    await openCard(workItem(), '/repo/station');
    // #2412: the read names the row's Project alongside its folder.
    expect(vi.mocked(useGitStatusQuery).mock.calls[0]![0]).toEqual({
      projectSlug: 'station',
      workingDir: '/repo/station',
    });
    const card = screen.getByTestId('inbox-row-hover-card');
    expect(card.textContent).toContain('main');
    expect(card.textContent).toContain('3 changes');
    expect(card.textContent).toContain('↑2');
    expect(card.textContent).toContain(
      'feat(projects): expose portable identity',
    );
  });

  it('renders a named gap while git is being read — never a fabricated state', async () => {
    vi.mocked(useGitStatusQuery).mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
    } as never);
    await openCard(workItem(), '/repo/station');
    expect(screen.getByTestId('inbox-row-hover-card').textContent).toContain(
      'Reading git state…',
    );
  });

  it('no host-resolved cwd means no git section and no git read at all', async () => {
    await openCard(workItem());
    expect(vi.mocked(useGitStatusQuery).mock.calls[0]![0]).toBeNull();
    const card = screen.getByTestId('inbox-row-hover-card');
    expect(card.textContent).not.toContain('Git');
  });
});

describe('inbox hover card pull requests (projects that have Git)', () => {
  it('lists linked pull requests with number, title, and provenance — bounded', async () => {
    vi.mocked(useGitStatusQuery).mockReturnValue({
      data: gitRepo(),
      isLoading: false,
      error: null,
    } as never);
    vi.mocked(getConversationPullRequestLinks).mockResolvedValue({
      conversationId: 'conv-1',
      observedAt: '2026-09-13T11:00:00.000Z',
      links: prLinks(9),
    });
    await openCard(workItem(), '/repo/station');
    await waitFor(() =>
      expect(vi.mocked(getConversationPullRequestLinks).mock.calls[0]![1]).toBe(
        'conv-1',
      ),
    );
    const card = screen.getByTestId('inbox-row-hover-card');
    expect(card.textContent).toContain('#2033');
    expect(card.textContent).toContain(
      'feat(projects): portable identity part 0',
    );
    expect(card.textContent).toContain('Explicit');
    expect(card.textContent).toContain('From branch');
    // Bounded preview with an honest pointer to the full list: the ninth
    // link appears ONLY as the count, never inline.
    expect(card.textContent).toContain('#2040');
    expect(card.textContent).not.toContain('#2041feat');
    expect(card.textContent).toContain('+1 more in Linked pull requests');
  });

  it('a project the git endpoint reported as a NON-repo suppresses the pull-request section and never fetches it', async () => {
    vi.mocked(useGitStatusQuery).mockReturnValue({
      data: { isRepo: false },
      isLoading: false,
      error: null,
    } as never);
    await openCard(workItem(), '/not-a-repo');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const card = screen.getByTestId('inbox-row-hover-card');
    expect(card.textContent).not.toContain('Pull requests');
    expect(getConversationPullRequestLinks).not.toHaveBeenCalled();
  });

  it('an unreadable links projection renders a named gap, not silence', async () => {
    vi.mocked(getConversationPullRequestLinks).mockRejectedValue(
      new Error('provider offline'),
    );
    await openCard(workItem(), '/repo/station');
    await waitFor(() =>
      expect(screen.getByTestId('inbox-row-hover-card').textContent).toContain(
        'Pull requests unavailable',
      ),
    );
  });
});

describe('inbox hover card basis section', () => {
  it('reads the whole-session scope for the row’s own session and renders its artifacts', async () => {
    const projection = v2Projection();
    const outputs = projection.groups.find((group) => group.id === 'outputs')!;
    outputs.state = 'available';
    outputs.count = { kind: 'exact', value: 1 };
    outputs.items = [
      {
        kind: 'station-session-output',
        key: 'output-1',
        relations: [],
        output: {
          ref: { sessionId: 'thread-1', eventId: 'evt-1' },
          turnId: 'turn-1',
          toolCallId: 'call-1',
          declaredAt: '2026-09-13T10:00:00.000Z',
          label: 'Feed refresh worker',
          descriptor: {
            kind: 'pull-request',
            liveExternal: true,
            provider: 'github',
            host: 'github.com',
            repository: { owner: 'kontourai', name: 'station' },
            ref: '2041',
            nativeId: '2041',
          },
        },
      },
    ];
    const kept = projection.groups.find((group) => group.id === 'kept')!;
    kept.state = 'available';
    kept.count = { kind: 'exact', value: 1 };
    kept.items = [
      {
        kind: 'task-kept-pull-request',
        key: 'kept-1',
        relations: ['kept-in-task'],
      },
    ];
    vi.mocked(useSessionInventoryQuery).mockReturnValue({
      data: projection,
      isLoading: false,
      error: null,
    } as never);
    await openCard(workItem(), '/repo/station');
    const call = vi.mocked(useSessionInventoryQuery).mock.calls[0]!;
    expect(call[0]).toEqual({
      kind: 'whole-session',
      sessionId: 'thread-1',
    });
    expect(call[1]?.enabled).toBe(true);
    const card = screen.getByTestId('inbox-row-hover-card');
    // Group counts derived from the projection, workspace artifacts first.
    expect(card.textContent).toContain('Outputs');
    expect(card.textContent).toContain('Kept');
    expect(card.textContent).toContain('Feed refresh worker');
    expect(card.textContent).toContain('Kept pull request');
  });

  it('a row with no session id renders no basis section and enables no read', async () => {
    await openCard(workItem({ orchestrationThreadId: undefined }));
    const call = vi.mocked(useSessionInventoryQuery).mock.calls[0]!;
    expect(call[0]).toEqual({ kind: 'whole-session', sessionId: '' });
    expect(call[1]?.enabled).toBe(false);
    expect(
      screen.getByTestId('inbox-row-hover-card').textContent,
    ).not.toContain('Basis');
  });

  it('an unavailable projection renders a named gap', async () => {
    vi.mocked(useSessionInventoryQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('restricted'),
    } as never);
    await openCard(workItem());
    expect(screen.getByTestId('inbox-row-hover-card').textContent).toContain(
      'Basis unavailable',
    );
  });
});

/**
 * Home's work rows are the same row, so their cards carry the same git
 * section — resolved from the session records by the dock's own derivation
 * (`useGitLocationByThreadId`), never a second one.
 */
describe('the git section on Home', () => {
  function homeSession(
    over: Partial<OrchestrationSessionSummary> = {},
  ): OrchestrationSessionSummary {
    return {
      provider: 'codex',
      threadId: 'thread-home',
      status: 'ready',
      controlMode: 'station-owned',
      isLoaded: true,
      isPersisted: true,
      eventCount: 3,
      createdAt: '2026-09-13T11:00:00.000Z',
      updatedAt: '2026-09-13T11:59:00.000Z',
      answerability: { answerable: true },
      displayTitle: 'Wire the release gate',
      projectSlug: 'station',
      cwd: '/repo/station-worktrees/release-gate',
      ...over,
    } satisfies OrchestrationSessionSummary as OrchestrationSessionSummary;
  }

  function HomeRows({ items }: { items: HomeWorkItem[] }) {
    const lanes = useHomeWorkLanes(items);
    return (
      <HomeRecentWorkSection
        lanes={lanes}
        workItems={items}
        workLoading={false}
        workDegraded={false}
        workError={false}
        agents={[]}
        remoteUnavailable={[]}
        remoteAuthenticationRequired={[]}
        onOpen={vi.fn()}
        onViewActivity={vi.fn()}
        onRetry={vi.fn()}
      />
    );
  }

  async function openHomeCard(session: OrchestrationSessionSummary) {
    // The server's session list, as the dock and Home both read it.
    vi.mocked(useOrchestrationSessionsQuery).mockReturnValue({
      data: [session],
    } as never);
    render(
      <QueryClientProvider client={queryClient}>
        <HomeRows items={buildOrchestrationItems([session], [])} />
      </QueryClientProvider>,
    );
    fireEvent.focus(screen.getByTestId('inbox-row'));
    return screen.findByTestId('inbox-row-hover-card');
  }

  it("a Home row's card reads git at its session's folder and names the branch", async () => {
    vi.mocked(useGitStatusQuery).mockReturnValue({
      data: { ...gitRepo(), branch: 'feat/release-gate' },
      isLoading: false,
      error: null,
    } as never);
    const card = await openHomeCard(homeSession());
    expect(vi.mocked(useGitStatusQuery).mock.calls.at(-1)![0]).toEqual({
      projectSlug: 'station',
      workingDir: '/repo/station-worktrees/release-gate',
    });
    expect(card.textContent).toContain('feat/release-gate');
  });

  it('a Home row whose session names no Project reads no git', async () => {
    const card = await openHomeCard(homeSession({ projectSlug: undefined }));
    expect(vi.mocked(useGitStatusQuery).mock.calls.at(-1)![0]).toBeNull();
    expect(card.textContent).not.toContain('Git');
  });
});
