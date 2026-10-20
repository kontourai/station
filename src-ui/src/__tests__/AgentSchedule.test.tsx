// @vitest-environment jsdom
/**
 * What an agent scheduled in a chat, as the person sees it: the in-chat notes
 * and approval card above the composer, and the "This chat" card's Scheduled
 * section. Rendered as the real components over the real hook; only the
 * network is stubbed, answering the exact envelope the agent-schedule route
 * produces (`ConversationAgentSchedule`).
 */
import type {
  AgentJobProposal,
  AgentWakeUp,
  ConversationAgentSchedule,
} from '@kontourai/station-contracts/agent-schedule';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentScheduleNotes } from '../components/chat-dock/AgentScheduleNotes';
import { SessionScheduledSection } from '../components/chat-dock/SessionScheduledSection';

const API = 'http://station.test';
const CONVERSATION = 'conv-1';
const authority = vi.hoisted(() => ({
  current: {
    apiBase: 'http://station.test',
    authorityKey: 'device-a',
    requiresEnrolledCredential: false,
    isCurrent: (): boolean => true,
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority.current,
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
const scheduler = vi.hoisted(() => ({
  jobs: [] as unknown[],
  run: vi.fn(),
  toggle: vi.fn(),
}));
vi.mock('../hooks/useScheduler', () => ({
  useSchedulerJobs: () => ({
    data: scheduler.jobs,
    isSuccess: true,
    isError: false,
  }),
  useRunJob: () => ({ mutate: scheduler.run, isPending: false }),
  useToggleJob: () => ({ mutate: scheduler.toggle, isPending: false }),
}));

const NOW = Date.parse('2026-10-20T14:00:00.000Z');
const wakeUp: AgentWakeUp = {
  id: 'w1',
  conversationId: CONVERSATION,
  dueAt: '2026-10-20T16:12:00.000Z',
  note: 'check the deploy',
  state: 'pending',
  createdAt: '2026-10-20T14:00:00.000Z',
  updatedAt: '2026-10-20T14:00:00.000Z',
};
const proposal: AgentJobProposal = {
  id: 'p1',
  conversationId: CONVERSATION,
  job: {
    name: 'hourly-digest',
    schedule: { kind: 'every', everyMs: 3_600_000 },
    prompt: 'Summarize the last hour.',
    agent: 'writer',
  },
  rationale: 'You asked for hourly summaries.',
  state: 'open',
  createdAt: '2026-10-20T14:00:00.000Z',
  updatedAt: '2026-10-20T14:00:00.000Z',
};

let schedule: ConversationAgentSchedule;
let calls: Array<{ method: string; url: string; body?: unknown }>;

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC');
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  schedule = { wakeUps: [wakeUp], jobProposals: [proposal], jobs: [] };
  calls = [];
  scheduler.jobs = [];
  setClientCredentialResolver(() => ({
    origin: authority.current.apiBase,
    requestAuthority: authority.current,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, ...(body ? { body } : {}) });
      if (
        method === 'GET' &&
        url === `${API}/api/orchestration/agent-schedule/${CONVERSATION}`
      )
        return Response.json({ success: true, data: schedule });
      if (method === 'POST') {
        // The action took effect: the next read no longer lists it.
        if (url.endsWith('/wake-ups/w1/cancel')) {
          schedule = { ...schedule, wakeUps: [] };
          return Response.json({ success: true, data: { canceled: true } });
        }
        if (url.endsWith('/job-proposals/p1/decline')) {
          schedule = { ...schedule, jobProposals: [] };
          return Response.json({ success: true, data: { declined: true } });
        }
        if (url === `${API}/scheduler/jobs`) {
          schedule = {
            ...schedule,
            jobProposals: [],
            jobs: [{ proposalId: 'p1', name: 'hourly-digest' }],
          };
          return Response.json({ success: true, data: { output: 'created' } });
        }
      }
      return Response.json(
        { success: false, error: 'unmodeled' },
        { status: 404 },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setClientCredentialResolver(undefined);
});

function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

const posts = () => calls.filter((call) => call.method === 'POST');

/** The row's own collapse finishing (React reads `propertyName` natively). */
function finishTransition(node: Element, propertyName: string) {
  const event = new Event('transitionend', { bubbles: true });
  Object.assign(event, { propertyName });
  node.dispatchEvent(event);
}

describe('in-chat notes', () => {
  test('a check-back reads as one quiet line with its local time, and Cancel cancels it on the server', async () => {
    mount(<AgentScheduleNotes conversationId={CONVERSATION} refreshKey="1" />);
    const note = await screen.findByText(/Checking back at/);
    expect(note.textContent).toBe('Checking back at 4:12 PM');
    expect(note.closest('[title]')?.getAttribute('title')).toBe(
      'check the deploy',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel check-back at 4:12 PM' }),
    );
    await waitFor(() =>
      expect(posts()).toEqual([
        {
          method: 'POST',
          url: `${API}/api/orchestration/agent-schedule/${CONVERSATION}/wake-ups/w1/cancel`,
        },
      ]),
    );
    // The row leaves once the server no longer lists it.
    await waitFor(
      () => expect(screen.queryByText(/Checking back at/)).toBeNull(),
      {
        timeout: 2_000,
      },
    );
  });

  test('the approval card shows the name, the schedule, the agent and the prompt', async () => {
    mount(<AgentScheduleNotes conversationId={CONVERSATION} refreshKey="1" />);
    const card = await screen.findByRole('region', {
      name: 'Proposed job hourly-digest',
    });
    expect(card.textContent).toContain('hourly-digest');
    expect(card.textContent).toContain('Every 60 min');
    expect(card.textContent).toContain('writer');
    expect(card.textContent).toContain('Summarize the last hour.');
    expect(card.textContent).toContain('You asked for hourly summaries.');
  });

  test('Approve is the person’s own scheduler create, naming the proposal, with exactly the proposed job', async () => {
    mount(<AgentScheduleNotes conversationId={CONVERSATION} refreshKey="1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(posts()).toEqual([
        {
          method: 'POST',
          url: `${API}/scheduler/jobs`,
          body: { ...proposal.job, proposalId: 'p1' },
        },
      ]),
    );
  });

  test('Decline records it on the server and creates nothing', async () => {
    mount(<AgentScheduleNotes conversationId={CONVERSATION} refreshKey="1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() =>
      expect(posts()).toEqual([
        {
          method: 'POST',
          url: `${API}/api/orchestration/agent-schedule/${CONVERSATION}/job-proposals/p1/decline`,
        },
      ]),
    );
    expect(posts().some((call) => call.url.endsWith('/scheduler/jobs'))).toBe(
      false,
    );
  });

  test('a canceled check-back collapses in place, inert, and unmounts when its fade ends', async () => {
    mount(<AgentScheduleNotes conversationId={CONVERSATION} refreshKey="1" />);
    await screen.findByText(/Checking back at/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel check-back at 4:12 PM' }),
    );
    const row = await waitFor(() => {
      const item = screen
        .getByText(/Checking back at/)
        .closest('.agent-schedule-notes__item');
      expect(item?.getAttribute('data-phase')).toBe('exiting');
      return item!;
    });
    expect(row.hasAttribute('inert')).toBe(true);
    // The height transition ending first does not cut the fade short.
    finishTransition(row, 'grid-template-rows');
    expect(screen.queryByText(/Checking back at/)).not.toBeNull();
    finishTransition(row, 'opacity');
    await waitFor(() =>
      expect(screen.queryByText(/Checking back at/)).toBeNull(),
    );
    // The proposal card it sat beside stays put.
    expect(
      screen.getByRole('region', { name: 'Proposed job hourly-digest' }),
    ).toBeTruthy();
  });

  test('nothing scheduled renders nothing', async () => {
    schedule = { wakeUps: [], jobProposals: [], jobs: [] };
    const view = mount(
      <AgentScheduleNotes conversationId={CONVERSATION} refreshKey="1" />,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(view.container.innerHTML).toBe('');
  });
});

describe('the "This chat" card’s Scheduled section', () => {
  const wrap = (action: () => void) => action();

  test('lists the check-back, the proposal and an approved job, each with its own actions', async () => {
    schedule = {
      wakeUps: [wakeUp],
      jobProposals: [proposal],
      jobs: [{ proposalId: 'p0', name: 'nightly' }],
      usageLimitResume: {
        threadId: 'session-1',
        dueAt: '2026-10-20T15:00:00.000Z',
        autoResume: true,
      },
    };
    scheduler.jobs = [
      {
        name: 'nightly',
        provider: 'builtin',
        prompt: 'p',
        enabled: false,
        schedule: { kind: 'every', everyMs: 3_600_000 },
      },
    ];
    mount(
      <SessionScheduledSection conversationId={CONVERSATION} wrap={wrap} />,
    );
    const section = await screen.findByRole('region', { name: 'Scheduled' });
    expect(section.textContent).toContain('check the deploy');
    expect(section.textContent).toContain('Once at 4:12 PM');
    expect(section.textContent).toContain('Resume after usage limit');
    expect(section.textContent).toContain('At 3:00 PM');
    expect(section.textContent).toContain('Needs your approval');
    expect(section.textContent).toContain('Every 60 min · paused');

    fireEvent.click(screen.getByRole('button', { name: 'Run nightly now' }));
    expect(scheduler.run).toHaveBeenCalledWith('nightly');
    fireEvent.click(screen.getByRole('switch', { name: 'nightly on' }));
    expect(scheduler.toggle).toHaveBeenCalledWith({
      target: 'nightly',
      enabled: true,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit nightly' }));
    expect(navigate).toHaveBeenCalledWith('/schedule', { job: 'nightly' });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(navigate).toHaveBeenCalledWith('/schedule');
  });

  test('the usage-limit resume’s Cancel is the per-stop Don’t resume', async () => {
    schedule = {
      wakeUps: [],
      jobProposals: [],
      jobs: [],
      usageLimitResume: {
        threadId: 'session-1',
        dueAt: '2026-10-20T15:00:00.000Z',
        autoResume: true,
      },
    };
    mount(
      <SessionScheduledSection conversationId={CONVERSATION} wrap={wrap} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(posts()[0]?.url).toBe(
        `${API}/api/orchestration/sessions/session-1/usage-limit/hold`,
      ),
    );
  });

  test('a canceled row collapses in place before it unmounts', async () => {
    schedule = { wakeUps: [wakeUp], jobProposals: [], jobs: [] };
    mount(
      <SessionScheduledSection conversationId={CONVERSATION} wrap={wrap} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const row = await waitFor(() => {
      const item = screen
        .getByText('check the deploy')
        .closest('.session-scheduled__item');
      expect(item?.getAttribute('data-phase')).toBe('exiting');
      return item!;
    });
    expect(row.hasAttribute('inert')).toBe(true);
    finishTransition(row, 'opacity');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Scheduled' })).toBeNull(),
    );
  });

  test('is hidden when nothing is scheduled', async () => {
    schedule = { wakeUps: [], jobProposals: [], jobs: [] };
    const view = mount(
      <SessionScheduledSection conversationId={CONVERSATION} wrap={wrap} />,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(view.container.innerHTML).toBe('');
  });
});
