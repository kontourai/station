/**
 * #3163: the child transcript route, end to end: the persisted child-work
 * facts a REAL Claude capture produced (replayed through the adapter's own
 * mapper), a fresh transcript module holding no adapter state (a restarted
 * server), and the SDK's transcript reader over a transcript on disk.
 */
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  installClaudeSubagentTranscript,
  TRANSCRIPT_AGENT_ID,
} from '../../../providers/__tests__/claude-subagent-transcript-fixture.js';
import { replayClaudeTaskCapture } from '../../../providers/__tests__/claude-task-captures.js';
import { createChildWorkTranscriptModule } from '../../../services/orchestration/child-work-transcript.js';
import type { OrchestrationService } from '../../../services/orchestration/orchestration-service';
import { createOrchestrationRoutes } from '../orchestration';

const THREAD = 'thread-claude';

/** What the event store holds for the session: its child-work facts, then its exit. */
function persistedHistory(): CanonicalRuntimeEvent[] {
  const { events } = replayClaudeTaskCapture('nested-agent', {
    threadId: THREAD,
  });
  return [
    ...events.filter((event) => event.method === 'child-work.updated'),
    {
      eventId: 'exit',
      provider: 'claude',
      threadId: THREAD,
      createdAt: '2026-09-23T02:00:00.000Z',
      method: 'session.exited',
    } as CanonicalRuntimeEvent,
  ];
}

function fixture(history: CanonicalRuntimeEvent[] = persistedHistory()) {
  let current = true;
  let readable = true;
  const listChildWorkHistory = vi.fn(() => history);
  const childWorkTranscripts = createChildWorkTranscriptModule({
    listChildWorkHistory,
    canReadSession: () => readable,
  });
  const service = {
    canUserReadSession: () => readable,
    childWorkTranscripts,
  } as unknown as OrchestrationService;
  const app = createOrchestrationRoutes(service, {
    eventBus: { subscribe: () => () => {} },
    logger: { debug: vi.fn() },
    getUserId: () => 'fixture-user',
    isRequestPrincipalCurrent: () => current,
  });
  return {
    listChildWorkHistory,
    request: (childId = TRANSCRIPT_AGENT_ID, query = '') =>
      app.request(
        `/sessions/${THREAD}/child-work/${encodeURIComponent(childId)}/transcript${query}`,
      ),
    revokeCaller: () => {
      current = false;
    },
    revokeSession: () => {
      readable = false;
    },
  };
}

async function unavailable(response: Response, status = 404) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({
    success: false,
    error: 'Child transcript unavailable',
  });
}

const makeTempDir = trackTempDirs();
let restore: (() => void) | undefined;
beforeEach(() => {
  ({ restore } = installClaudeSubagentTranscript(makeTempDir));
});
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('#3163 GET /sessions/:threadId/child-work/:childId/transcript', () => {
  test('after a restart, the persisted facts alone open the subagent transcript', async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = (await response.json()) as {
      success: true;
      data: { entries: Array<{ kind: string; text?: string }> };
    };
    expect(body.data.entries.map((entry) => entry.kind)).toEqual([
      'text',
      'tool-call',
      'tool-result',
      'text',
    ]);
    expect(body.data.entries.at(-1)?.text).toBe('INNER DONE');
    expect(f.listChildWorkHistory).toHaveBeenCalledWith(THREAD);
  });

  test('pages are bounded by the query', async () => {
    const f = fixture();
    const response = await f.request(TRANSCRIPT_AGENT_ID, '?limit=2');
    const body = (await response.json()) as {
      data: { nextOffset?: number };
    };
    expect(body.data.nextOffset).toBe(2);
    expect((await f.request(TRANSCRIPT_AGENT_ID, '?limit=51')).status).toBe(
      400,
    );
  });

  test('a path in the request is never read: the route has no input for one', async () => {
    const f = fixture();
    const steered = await f.request(
      TRANSCRIPT_AGENT_ID,
      '?path=/etc/passwd&file=/etc/passwd',
    );
    const plain = await f.request();
    expect(steered.status).toBe(200);
    expect(await steered.json()).toEqual(await plain.json());
  });

  test('a child the session never reported a transcript for is not found', async () => {
    await unavailable(await fixture().request('not-a-child'));
  });

  test('a ref injected by another reporter is not this session’s', async () => {
    const forged = persistedHistory().map((event) =>
      event.method === 'child-work.updated'
        ? { ...event, threadId: 'other' }
        : event,
    );
    await unavailable(await fixture(forged).request());
  });

  test('an unreadable session or a stale caller reads nothing', async () => {
    const session = fixture();
    session.revokeSession();
    await unavailable(await session.request());
    expect(session.listChildWorkHistory).not.toHaveBeenCalled();
    const caller = fixture();
    caller.revokeCaller();
    await unavailable(await caller.request());
    expect(caller.listChildWorkHistory).not.toHaveBeenCalled();
  });

  test('an app-home session’s transcript is read from the profile it ran under, not the server’s config home', async () => {
    // The session ran under its own profile; the server's global config home
    // (beforeEach) holds no transcript for this agent.
    restore?.();
    ({ restore } = installClaudeSubagentTranscript(makeTempDir, {
      withAgent: false,
    }));
    const profile = installClaudeSubagentTranscript(makeTempDir, {
      asProfile: true,
    });
    const { events } = replayClaudeTaskCapture('nested-agent', {
      threadId: THREAD,
      claudeConfigHome: profile.configDir,
    });
    const history = events.filter(
      (event) => event.method === 'child-work.updated',
    );
    const response = await fixture(history).request();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { entries: Array<{ text?: string }> };
    };
    expect(body.data.entries.at(-1)?.text).toBe('INNER DONE');
    // Without the session's own config home, the same read finds nothing.
    await unavailable(await fixture(persistedHistory()).request(), 503);
  });

  test('a transcript the engine no longer has is unavailable (503)', async () => {
    restore?.();
    ({ restore } = installClaudeSubagentTranscript(makeTempDir, {
      withAgent: false,
    }));
    await unavailable(await fixture().request(), 503);
  });
});
