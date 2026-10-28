/**
 * @vitest-environment jsdom
 *
 * A resolved approval must leave the inbox's "Needs you" group.
 *
 * Observed on a phone: a Codex conversation continued into a successor
 * session, the successor asked for approval, the person approved it, and the
 * server recorded `request.resolved` (`sessionState: 'running'`). The inbox
 * still listed the conversation under "Needs you" with "Needs approval"
 * afterwards. The log after the answer holds only tool, token and content
 * frames until a later `child-work.updated`: no `session.state-changed`, no
 * turn boundary. The inbox's rows come from the session read-model, which the
 * stream re-reads only on listed facts, and the request events were not
 * among them.
 *
 * This drives the real stream (`ensureOrchestrationEventStream` over the
 * real `fetchSSE`, with only the per-event chat-store handlers stubbed) into
 * a real QueryClient whose read-model observer answers with the server's
 * current projection, then groups that answer exactly as the inbox does
 * (`buildHomeWorkItems` -> `groupMobileActivity`).
 *
 * FIXTURE PROVENANCE: the event frames copy the field shape of the recorded
 * `request.opened`/`request.resolved` rows (method, requestType, payload
 * kind, sessionState/previousState/transitionReason/transitionSource,
 * status, acknowledgement); ids, timestamps and text are made up. The
 * summaries are hand-transcribed, not a byte capture: they carry the fields
 * the lifecycle fold and the inbox merge read for a root session that exited
 * and its successor (`conversationId` names the root), and omit optional
 * projections the server may add (`conversationActivity`, `openRequestIds`,
 * `currentSessionId`, `draft`). No chat is open: this pins the read-model
 * refresh, not the chat store's own request bookkeeping.
 */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handleOrchestrationEvent, settleSemanticDeliveryBuffer } = vi.hoisted(
  () => ({
    handleOrchestrationEvent: vi.fn(),
    settleSemanticDeliveryBuffer: vi.fn(),
  }),
);

vi.mock('../hooks/orchestration/eventHandlers', () => ({
  handleOrchestrationEvent,
  settleSemanticDeliveryBuffer,
}));

import { groupMobileActivity } from '../components/chat-dock/mobile-activity-groups';
import {
  ensureOrchestrationEventStream,
  resetSessionReadModelRefreshForTests,
} from '../hooks/orchestration/ensureOrchestrationEventStream';
import { buildHomeWorkItems } from '../views/home/home-view-model';

const CONVERSATION = 'codex:1790000000001';
const SUCCESSOR = `${CONVERSATION}:session:00000000-0000-4000-8000-000000000001`;
const REQUEST = '00000000-0000-4000-8000-0000000000aa';

const ROOT_EXITED: OrchestrationSessionSummary = {
  provider: 'codex',
  threadId: CONVERSATION,
  status: 'closed',
  controlMode: 'station-owned',
  answerability: { answerable: true },
  createdAt: '2026-10-28T04:09:50.312Z',
  updatedAt: '2026-10-28T15:45:55.114Z',
  isLoaded: false,
  isPersisted: true,
  eventCount: 1178,
  lifecycleState: 'completed',
  pendingReview: false,
  assignedAgentSlug: agentId('codex'),
  projectSlug: 'example-project',
  conversationId: CONVERSATION,
  lastEventAt: '2026-10-28T15:45:55.114Z',
  lastEventMethod: 'session.exited',
  hasActiveTurn: false,
};

/** The successor while its turn runs, before and after the approval. */
const SUCCESSOR_RUNNING: OrchestrationSessionSummary = {
  ...ROOT_EXITED,
  threadId: SUCCESSOR,
  status: 'ready',
  createdAt: '2026-10-28T15:48:03.979Z',
  updatedAt: '2026-10-28T15:48:05.976Z',
  isLoaded: true,
  eventCount: 6,
  lifecycleState: 'running',
  lastEventAt: '2026-10-28T15:48:05.976Z',
  lastEventMethod: 'session.state-changed',
  hasActiveTurn: true,
};

const SUCCESSOR_AWAITING: OrchestrationSessionSummary = {
  ...SUCCESSOR_RUNNING,
  updatedAt: '2026-10-28T15:48:13.074Z',
  eventCount: 12,
  lifecycleState: 'review_pending',
  previousLifecycleState: 'running',
  transitionReason: 'review_requested',
  pendingReview: true,
  lastEventAt: '2026-10-28T15:48:13.074Z',
  lastEventMethod: 'request.opened',
};

const SUCCESSOR_RESUMED: OrchestrationSessionSummary = {
  ...SUCCESSOR_RUNNING,
  updatedAt: '2026-10-28T15:49:38.426Z',
  eventCount: 13,
  lifecycleState: 'running',
  previousLifecycleState: 'review_pending',
  transitionReason: 'request_resolved',
  pendingReview: false,
  lastEventAt: '2026-10-28T15:49:38.426Z',
  lastEventMethod: 'request.resolved',
};

function frame(sequence: number, event: Record<string, unknown>): string {
  return `id: ${sequence}\nevent: orchestration:event\ndata: ${JSON.stringify({ event })}\n\n`;
}

const REQUEST_OPENED = frame(12, {
  eventId: '00000000-0000-4000-8000-000000000012',
  provider: 'codex',
  threadId: SUCCESSOR,
  createdAt: '2026-10-28T15:48:13.074Z',
  requestId: REQUEST,
  method: 'request.opened',
  requestType: 'approval',
  title: '/bin/bash -lc "git status -sb"',
  payload: { kind: 'command', command: '/bin/bash -lc "git status -sb"' },
  sessionState: 'review_pending',
  previousState: 'running',
  transitionReason: 'review_requested',
  transitionSource: 'runtime',
});

const REQUEST_RESOLVED = frame(13, {
  eventId: '00000000-0000-4000-8000-000000000013',
  provider: 'codex',
  threadId: SUCCESSOR,
  createdAt: '2026-10-28T15:49:38.426Z',
  requestId: REQUEST,
  method: 'request.resolved',
  status: 'approved',
  acknowledgement: 'engine',
  sessionState: 'running',
  previousState: 'review_pending',
  transitionReason: 'request_resolved',
  transitionSource: 'user_action',
});

/** What follows the answer in the recorded log: a tool frame, no boundary. */
const TOOL_PROGRESS = frame(16, {
  eventId: '00000000-0000-4000-8000-000000000016',
  provider: 'codex',
  threadId: SUCCESSOR,
  createdAt: '2026-10-28T15:49:38.857Z',
  method: 'tool.progress',
});

function pushableSseResponse(): {
  response: Response;
  push: (frame: string) => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
  return {
    response,
    push: (value) => controller?.enqueue(new TextEncoder().encode(value)),
  };
}

/** The inbox's groups for the read-model the observer currently holds. */
function inboxGroupIds(sessions: OrchestrationSessionSummary[] | undefined) {
  const items = buildHomeWorkItems({
    chats: {},
    sessions: sessions ?? [],
    agents: [],
  });
  const groups = groupMobileActivity(items, Date.now(), {});
  return Object.fromEntries(
    groups
      .filter((group) => group.items.length > 0)
      .map((group) => [group.id, group.items.map((item) => item.id)]),
  );
}

describe('a resolved approval leaves the inbox Needs-you group', () => {
  beforeEach(() => {
    handleOrchestrationEvent.mockReset();
    resetSessionReadModelRefreshForTests();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.parse('2026-10-28T15:48:10.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('re-reads the session read-model on request.opened and request.resolved of a successor session', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The server's projection at each moment; the read-model observer reads
    // it the way the inbox's sessions query does, and a live stream holds
    // it forever (`staleTime: Infinity`) unless the stream asks again.
    let server: OrchestrationSessionSummary[] = [
      ROOT_EXITED,
      SUCCESSOR_RUNNING,
    ];
    const observer = new QueryObserver(client, {
      queryKey: ['orchestration-sessions'],
      queryFn: async () => server,
      staleTime: Number.POSITIVE_INFINITY,
    });
    const stop = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const shown = () => inboxGroupIds(observer.getCurrentResult().data);
    expect(shown()).toMatchObject({ running: [CONVERSATION] });

    const stream = pushableSseResponse();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(stream.response));
    ensureOrchestrationEventStream(
      'https://inbox-resolved-approval.example.test',
      client,
    );

    // The successor asks. The server now folds it to review_pending.
    server = [ROOT_EXITED, SUCCESSOR_AWAITING];
    stream.push(REQUEST_OPENED);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(handleOrchestrationEvent).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual({ needsYou: [CONVERSATION] });

    // The person approves. The server folds the session back to running and
    // the turn resumes with tool frames only.
    server = [ROOT_EXITED, SUCCESSOR_RESUMED];
    stream.push(REQUEST_RESOLVED);
    stream.push(TOOL_PROGRESS);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(handleOrchestrationEvent).toHaveBeenCalledTimes(3);
    expect(shown()).toEqual({ running: [CONVERSATION] });

    stop();
  });
});
