/**
 * #3994 agent terminal-run requests: admission bounds across conversations.
 * Each conversation may hold three unanswered requests; the store as a whole
 * holds a bounded number, sweeps expired ones before it admits another, and
 * refuses rather than grows past its bound.
 */
import { describe, expect, it } from 'vitest';
import {
  TERMINAL_RUN_MAX_PENDING,
  TERMINAL_RUN_MAX_PENDING_PER_CONVERSATION,
  TerminalRunRequests,
} from '../terminal-runs.js';

const TTL_MS = 10 * 60_000;

function ask(runs: TerminalRunRequests, conversationId: string) {
  return runs.request({
    conversationId,
    sessionId: `session-${conversationId}`,
    projectId: 'project-a',
    projectSlug: 'alpha',
    command: 'echo hi',
    cwd: '/work',
  });
}

describe('TerminalRunRequests admission', () => {
  it('keeps the per-conversation limit', () => {
    const runs = new TerminalRunRequests(() => 0);
    for (let i = 0; i < TERMINAL_RUN_MAX_PENDING_PER_CONVERSATION; i++)
      expect(ask(runs, 'c').outcome).toBe('requested');
    expect(ask(runs, 'c').outcome).toBe('limit-reached');
    expect(ask(runs, 'other').outcome).toBe('requested');
  });

  it('bounds unanswered requests across conversations and refuses the rest', () => {
    const runs = new TerminalRunRequests(() => 0);
    const outcomes = new Map<string, number>();
    // 600 requests, three per conversation: no conversation reaches its own
    // limit, so only a store-wide bound can refuse them.
    for (let c = 0; c < 200; c++)
      for (let i = 0; i < 3; i++) {
        const { outcome } = ask(runs, `conversation-${c}`);
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
      }
    expect(outcomes.get('requested')).toBe(TERMINAL_RUN_MAX_PENDING);
    expect(outcomes.get('capacity-reached')).toBe(
      600 - TERMINAL_RUN_MAX_PENDING,
    );
    let waiting = 0;
    for (let c = 0; c < 200; c++)
      waiting += runs
        .forConversation(`conversation-${c}`)
        .filter((run) => run.state === 'needs_approval').length;
    expect(waiting).toBe(TERMINAL_RUN_MAX_PENDING);
  });

  it("expires every conversation's stale requests before admitting another", () => {
    let now = 0;
    const runs = new TerminalRunRequests(() => now);
    for (let c = 0; c < TERMINAL_RUN_MAX_PENDING; c++)
      expect(ask(runs, `stale-${c}`).outcome).toBe('requested');
    expect(ask(runs, 'fresh').outcome).toBe('capacity-reached');
    // Nobody reads the stale conversations again; admission must still see
    // that they expired.
    now = TTL_MS + 1;
    expect(ask(runs, 'fresh').outcome).toBe('requested');
    expect(runs.forConversation('stale-0')[0]?.state).toBe('expired');
  });

  it('forgets settled requests to admit a new one and never retains more than its bound', () => {
    let now = 0;
    const runs = new TerminalRunRequests(() => now);
    // Settle 30 conversations' worth of requests: 20 retained each is 600,
    // past the 512-record bound unless settled ones are forgotten.
    for (let c = 0; c < 30; c++)
      for (let i = 0; i < 20; i++) {
        now++;
        const result = ask(runs, `settled-${c}`);
        expect(result.outcome).toBe('requested');
        if (result.outcome === 'requested')
          expect(runs.decline(result.run.id)).toBe(true);
      }
    let retained = 0;
    for (let c = 0; c < 30; c++)
      retained += runs.forConversation(`settled-${c}`).length;
    expect(retained).toBeLessThanOrEqual(512);
    expect(ask(runs, 'new').outcome).toBe('requested');
  });
});
