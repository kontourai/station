/** @vitest-environment jsdom */
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import {
  activatedLearningProjection,
  evidence,
  proposal,
  scope,
} from '../../../../../src-server/__test-utils__/learning-review-fixture.js';
import { createProjectLearningReviewRoutes } from '../../../../../src-server/routes/projects/learning-review-routes.js';
import {
  type LearningLifecycleOwnerPort,
  LearningReviewService,
} from '../../../../../src-server/services/learning-review/learning-review-service.js';
import { MessageRating } from '../../../components/chat/message-bubble/MessageRating';
import { TaskLearningPanel } from '../../task-workspace/TaskLearningPanel';
import { LearningReviewPanel } from '../LearningReviewPanel';

const data = vi.hoisted(() => ({
  authority: {
    apiBase: 'http://source.test',
    authorityKey: 'operator',
    isCurrent: () => true,
  },
  ratings: [] as unknown[],
  lessons: {
    version: 'fixture',
    taskId: 'task-one',
    offered: true,
    projectSlug: 'demo',
    stores: [{ rootId: 'store', displayName: 'Project store' }],
    candidates: [
      {
        knowledgeRecordId: 'raw-candidate',
        record: {
          kind: 'decision',
          key: 'evidence',
          version: 3,
          text: 'Standing decision',
          state: 'active',
          importance: 'standing',
        },
        review: { state: 'open' },
      },
    ],
  },
}));
vi.mock('@kontourai/station-sdk', () => ({
  useTaskLearningQuery: () => ({ data: data.lessons, isLoading: false }),
  usePromoteTaskLearningMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDismissTaskLearningMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useFeedbackRatingsQuery: () => ({ data: data.ratings }),
  useSaveFeedbackRatingMutation: () => ({ mutateAsync: vi.fn() }),
  useDeleteFeedbackRatingMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set(['learning-lifecycle-review']),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => data.authority,
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useScopedProjectQuery: () => ({ data: { id: 'project-id' } }),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  data.ratings.length = 0;
  vi.unstubAllGlobals();
});
function fixture(active = false) {
  const snapshot = active ? activatedLearningProjection() : proposal;
  let allowed = true;
  const apply = vi.fn(
    async (
      intent: import('@kontourai/flow-agents/knowledge-learning-contract').KnowledgeLearningIntent,
    ) => ({
      ...proposal.receipts[0]!,
      id: 'new-receipt',
      learningId: intent.learningId,
      intentId: intent.intentId,
      revision: intent.expectedRevision + 1,
      action: intent.action,
    }),
  );
  const owner: LearningLifecycleOwnerPort = {
    version: 'knowledge.learning/v1',
    authority: 'knowledge-kit',
    get: async () => structuredClone(snapshot),
    list: async () => ({
      records: [structuredClone(snapshot)],
      coverage: 'complete',
    }),
    apply,
  };
  const resolve = vi.fn(async () => ({
    scope,
    supporting: [evidence],
    counter: [],
    conflicts: [],
    targets: proposal.record.proposal.targets,
  }));
  const service = new LearningReviewService(owner, resolve, async () => ({
    title: 'Canonical source title',
    text: 'Canonical source body',
  }));
  const app = new Hono().route(
    '/api/projects',
    createProjectLearningReviewRoutes({
      enabled: () => true,
      authorize: async () =>
        allowed ? { scope, service, isCurrent: () => allowed } : undefined,
    }),
  );
  setClientCredentialResolver(() => ({
    origin: data.authority.apiBase,
    requestAuthority: data.authority,
  }));
  const requests = vi.fn(async (url: string | Request, init?: RequestInit) =>
    app.request(String(url), init),
  );
  vi.stubGlobal('fetch', requests);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return {
    client,
    apply,
    resolve,
    requests,
    revoke() {
      allowed = false;
    },
    restoreAccess() {
      allowed = true;
    },
  };
}

test('the existing Task lesson entry prepares and pins the actual record before its owner proposal, without manual identifiers', async () => {
  const context = fixture();
  render(
    <QueryClientProvider client={context.client}>
      <TaskLearningPanel
        taskId="task-one"
        projectId="project-id"
        projectSlug="demo"
        taskCreatedAt="2026-10-30T09:00:00.000Z"
        authority={data.authority}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review as learning' }),
  );
  expect(
    await screen.findByRole('dialog', { name: 'Review as learning' }),
  ).toBeTruthy();
  expect(screen.queryByLabelText('Task ID')).toBeNull();
  expect(
    (screen.getByLabelText('Proposed instructions') as HTMLTextAreaElement)
      .value,
  ).toBe('Canonical source body');
  fireEvent.change(screen.getByLabelText('Expected effect'), {
    target: { value: 'Retain review evidence' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Propose to owner' }));
  await waitFor(() =>
    expect(context.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'propose',
        proposal: expect.objectContaining({
          body: 'Canonical source body',
          supporting: [evidence],
        }),
      }),
    ),
  );
  expect(context.resolve).toHaveBeenCalledWith(
    {
      kind: 'task-standing',
      taskId: 'task-one',
      taskCreatedAt: '2026-10-30T09:00:00.000Z',
      recordKind: 'decision',
      key: 'evidence',
      version: 3,
    },
    scope,
  );
});

test('a stored verified rating prepares only on click, and revoked refresh cannot reopen cached source content', async () => {
  const context = fixture();
  data.ratings.push({
    id: 'saved-rating',
    conversationId: 'conversation',
    messageIndex: 4,
    rating: 'thumbs_up',
    target: {
      conversationId: 'conversation',
      sessionId: 'session',
      turnId: 'turn',
      contentDigest: 'd'.repeat(64),
    },
  });
  render(
    <QueryClientProvider client={context.client}>
      <MessageRating
        conversationId="conversation"
        messageIndex={4}
        messagePreview="Response"
        agentSlug="agent"
        sessionId="session"
        turnId="turn"
        projectSlug="demo"
      />
    </QueryClientProvider>,
  );
  const review = await screen.findByRole('button', {
    name: 'Review as learning',
  });
  expect(context.requests).not.toHaveBeenCalled();
  expect(context.resolve).not.toHaveBeenCalled();
  fireEvent.click(review);
  expect(
    await screen.findByRole('dialog', { name: 'Review as learning' }),
  ).toBeTruthy();
  expect(
    context.requests.mock.calls.filter(([url]) =>
      String(url).endsWith('/source'),
    ),
  ).toHaveLength(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Close learning proposal' }),
  );
  context.revoke();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review as learning' }),
  );
  const retry = await screen.findByRole('button', { name: 'Retry source' });
  expect(
    screen.queryByRole('dialog', { name: 'Review as learning' }),
  ).toBeNull();
  expect(context.apply).not.toHaveBeenCalled();
  expect(context.resolve).toHaveBeenCalledWith(
    {
      kind: 'rated-feedback',
      conversationId: 'conversation',
      turnId: 'turn',
      ratingId: 'saved-rating',
    },
    scope,
  );
  context.restoreAccess();
  fireEvent.click(retry);
  expect(
    await screen.findByRole('dialog', { name: 'Review as learning' }),
  ).toBeTruthy();
});

test('a later canonical Task record can be selected as an effect source through the same record entry', async () => {
  const context = fixture(true);
  render(
    <QueryClientProvider client={context.client}>
      <TaskLearningPanel
        taskId="task-one"
        projectId="project-id"
        projectSlug="demo"
        taskCreatedAt="2026-10-30T09:00:00.000Z"
        authority={data.authority}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review as learning' }),
  );
  await screen.findByRole('dialog', { name: 'Review as learning' });
  fireEvent.change(screen.getByLabelText('Learning action'), {
    target: { value: 'effect' },
  });
  fireEvent.change(await screen.findByLabelText('Active learning'), {
    target: { value: 'learning-one' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Record observed effect' }),
  );
  await waitFor(() =>
    expect(context.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'observe-effect',
        assessment: 'unresolved',
        evidence,
        expectedRevision: 4,
      }),
    ),
  );
});

test.each(['proposal', 'effect'] as const)(
  'an observed source refusal removes protected %s fields and prepared cache despite unchanged host authority',
  async (mode) => {
    const context = fixture(mode === 'effect');
    render(
      <QueryClientProvider client={context.client}>
        <TaskLearningPanel
          taskId="task-one"
          projectId="project-id"
          projectSlug="demo"
          taskCreatedAt="2026-10-30T09:00:00.000Z"
          authority={data.authority}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Review as learning' }),
    );
    await screen.findByRole('dialog', { name: 'Review as learning' });
    if (mode === 'effect') {
      fireEvent.change(screen.getByLabelText('Learning action'), {
        target: { value: 'effect' },
      });
      fireEvent.change(await screen.findByLabelText('Active learning'), {
        target: { value: 'learning-one' },
      });
      expect(screen.getByText('Canonical source body')).toBeTruthy();
    } else {
      expect(screen.getByDisplayValue('Canonical source body')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Expected effect'), {
        target: { value: 'Preserve source evidence' },
      });
    }
    context.revoke();
    fireEvent.click(
      screen.getByRole('button', {
        name: mode === 'effect' ? 'Record observed effect' : 'Propose to owner',
      }),
    );
    await screen.findByText('Source access changed');
    expect(data.authority.isCurrent()).toBe(true);
    expect(screen.queryByText('Canonical source body')).toBeNull();
    expect(screen.queryByDisplayValue('Canonical source body')).toBeNull();
    expect(screen.queryByDisplayValue('Canonical source title')).toBeNull();
    expect(context.apply).not.toHaveBeenCalled();
    await waitFor(() => {
      for (const query of context.client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey[0] === 'learning-review'))
        expect(JSON.stringify(query.state.data)).not.toContain(
          'Canonical source body',
        );
    });
  },
);

test('an observed decision refusal clears protected owner rows until an authoritative read restores access', async () => {
  const context = fixture();
  render(
    <QueryClientProvider client={context.client}>
      <LearningReviewPanel
        slug="demo"
        projectId="project-id"
        authority={data.authority}
      />
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByLabelText('Learning'), {
    target: { value: 'learning-one' },
  });
  await screen.findByText('Proposed guidance');
  fireEvent.change(screen.getByLabelText('Action'), {
    target: { value: 'activate' },
  });
  context.revoke();
  fireEvent.click(screen.getByRole('button', { name: 'Submit to owner' }));
  await screen.findByText('Learning access changed');
  expect(screen.queryByText('Proposed guidance')).toBeNull();
  expect(screen.queryByLabelText('Learning')).toBeNull();
  expect(context.apply).not.toHaveBeenCalled();
  context.restoreAccess();
  fireEvent.click(screen.getByRole('button', { name: 'Check access' }));
  fireEvent.change(await screen.findByLabelText('Learning'), {
    target: { value: 'learning-one' },
  });
  expect(await screen.findByText('Proposed guidance')).toBeTruthy();
});
