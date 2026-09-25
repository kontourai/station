/**
 * #2459: the Agents pane's child-work selectors. Every rule here is a rule
 * against inventing: provenance comes from facts on hand, a nesting edge only
 * from a reported one, a time only from a reported (or spawning tool card's)
 * one, and a control only from a wired matrix cell.
 */

import {
  type ChildWorkItem,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import { describe, expect, test, vi } from 'vitest';

// Two engines no shipped matrix has yet, so the wired rule can be exercised:
// one wired for a direct per-task stop, one whose stop only the model can
// invoke.
vi.mock(
  '@kontourai/station-contracts/engine-capability-matrix',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-contracts/engine-capability-matrix')
      >();
    const base = actual.ENGINE_CAPABILITY_MATRICES.codex;
    const wired = (invocation: 'client-request' | 'model-tool') => ({
      ...base,
      subagentControl: {
        state: 'wired' as const,
        stop: {
          state: 'available' as const,
          invocation,
          scope: 'per-task' as const,
          evidence: 'test',
        },
        resume: { state: 'unsupported' as const, reason: 'test' },
      },
    });
    return {
      ...actual,
      ENGINE_CAPABILITY_MATRICES: {
        ...actual.ENGINE_CAPABILITY_MATRICES,
        'wired-engine': wired('client-request'),
        'model-tool-engine': wired('model-tool'),
      },
    };
  },
);

import {
  type ChildWorkSelectorInput,
  type ChildWorkSessionSource,
  controlsFor,
  emptyStateFor,
  GLOBAL_FINISHED_LIMIT,
  provenanceFor,
  selectChatChildWork,
  selectGlobalChildWork,
  subagentNoticeFor,
  uniqueChatKey,
} from '../childWorkSelectors';

function delegate(
  threadId: string,
  overrides: Partial<ChildWorkItem> = {},
  session: Partial<ChildWorkSessionSource> = {},
): ChildWorkSessionSource {
  return {
    threadId,
    provider: 'claude',
    ...session,
    childWork: {
      asChild: {
        producer: 'station-delegate',
        reporterThreadId: threadId,
        childId: threadId,
        status: 'running',
        result: { handle: { kind: 'session', threadId } },
        controls: { stop: 'delegate-interrupt' },
        ...overrides,
      },
    },
  };
}

function engineItem(
  reporter: string,
  childId: string,
  overrides: Partial<ChildWorkItem> = {},
): ChildWorkItem {
  return {
    producer: 'engine-subagent',
    reporterThreadId: reporter,
    childId,
    status: 'running',
    ...overrides,
  };
}

function input(
  sessions: ChildWorkSessionSource[],
  engine: ChildWorkItem[] = [],
  extra: Partial<ChildWorkSelectorInput> = {},
): ChildWorkSelectorInput {
  const registry = createEmptyChildWorkRegistry();
  for (const item of engine)
    registry.items[
      JSON.stringify([item.producer, item.reporterThreadId, item.childId])
    ] = item;
  return {
    sessions,
    engine: registry,
    chatKeyFor: () => undefined,
    ...extra,
  };
}

describe('provenance', () => {
  test('a delegate whose parent is a known session names that conversation', () => {
    const facts = input([
      { threadId: 'parent-1', displayTitle: 'Fix the build' },
      delegate('d-1', { parent: { taskId: 'parent-1' } }),
    ]);
    expect(provenanceFor(facts.sessions[1].childWork!.asChild!, facts)).toEqual(
      {
        kind: 'conversation',
        threadId: 'parent-1',
        title: 'Fix the build',
      },
    );
  });

  test('a parent task Station has no session for is named as a task, not a conversation', () => {
    const facts = input([delegate('d-1', { parent: { taskId: 'task-77' } })]);
    expect(provenanceFor(facts.sessions[0].childWork!.asChild!, facts)).toEqual(
      { kind: 'task', taskId: 'task-77' },
    );
  });

  test('a root delegate started from the CLI says so; one with no reported origin has no parent', () => {
    const cli = input([
      delegate(
        'd-cli',
        {},
        { turnOrigin: { latest: { reported: { surface: 'cli' } } } },
      ),
    ]);
    expect(provenanceFor(cli.sessions[0].childWork!.asChild!, cli)).toEqual({
      kind: 'cli',
    });
    const bare = input([delegate('d-bare')]);
    expect(provenanceFor(bare.sessions[0].childWork!.asChild!, bare)).toEqual({
      kind: 'none',
    });
  });

  test('an engine subagent comes from its reporter, titled from the open chat when no row names it', () => {
    const facts = input([], [], {
      chatKeyFor: (id) => (id === 'exec-1' ? 'chat-1' : undefined),
      chatFacts: () => ({ title: 'Morning triage' }),
    });
    expect(provenanceFor(engineItem('exec-1', 'c-1'), facts)).toEqual({
      kind: 'conversation',
      threadId: 'exec-1',
      title: 'Morning triage',
    });
  });
});

describe('controls', () => {
  test('a running delegate offers its Station interrupt; a settled one offers nothing', () => {
    const item = delegate('d-1').childWork!.asChild!;
    expect(controlsFor(item, 'claude')).toBe('delegate-interrupt');
    expect(controlsFor({ ...item, status: 'completed' }, 'claude')).toBe(
      undefined,
    );
  });

  test('an engine subagent gets Stop only from a wired client-request per-task cell AND its own seam', () => {
    const withSeam = engineItem('r', 'c', {
      controls: { stop: 'provider-task-stop' },
    });
    expect(controlsFor(withSeam, 'wired-engine')).toBe('provider-task-stop');
    // #2457: Claude's cell is wired (stop-task capture), so its seam renders.
    expect(controlsFor(withSeam, 'claude')).toBe('provider-task-stop');
    // A model-tool stop is never a direct button.
    expect(controlsFor(withSeam, 'model-tool-engine')).toBe(undefined);
    // An unknown engine wires nothing.
    expect(controlsFor(withSeam, undefined)).toBe(undefined);
    expect(controlsFor(withSeam, 'nonesuch')).toBe(undefined);
    // A wired engine but a child with no stop seam of its own.
    expect(controlsFor(engineItem('r', 'c'), 'wired-engine')).toBe(undefined);
  });

  test('#2486: a row says its engine stop ends the parent turn, from the matrix, never a copy true for every engine', () => {
    // Real matrix cells, not the synthetic wired-engine/model-tool-engine
    // mocks above: codex is genuinely wired with `endsParentTurn: true`
    // since #2486; claude's cell is still `none`.
    const view = selectGlobalChildWork(
      input(
        [{ threadId: 'exec-codex', provider: 'codex' }],
        [
          engineItem('exec-codex', 'c-codex', {
            controls: { stop: 'provider-task-stop' },
          }),
        ],
      ),
    );
    expect(view.running[0].stop).toBe('provider-task-stop');
    expect(view.running[0].stopEndsParentTurn).toBe(true);

    // The synthetic `wired-engine` mock never sets `endsParentTurn`, so a
    // wired-but-task-scoped stop must not carry the flag.
    const scopedView = selectGlobalChildWork(
      input(
        [{ threadId: 'exec-scoped', provider: 'wired-engine' }],
        [
          engineItem('exec-scoped', 'c-scoped', {
            controls: { stop: 'provider-task-stop' },
          }),
        ],
      ),
    );
    expect(scopedView.running[0].stop).toBe('provider-task-stop');
    expect(scopedView.running[0].stopEndsParentTurn).toBeUndefined();
  });
});

describe('nesting and time', () => {
  test('a delegate’s own subagents nest under it, indented by reported depth only', () => {
    const view = selectGlobalChildWork(
      input(
        [delegate('d-1', { startedAt: '2026-09-24T00:00:00.000Z' })],
        [
          engineItem('d-1', 'top', { depth: 1 }),
          engineItem('d-1', 'inner', { depth: 2 }),
          engineItem('d-1', 'unknown-depth'),
          engineItem('elsewhere', 'loose', { depth: 3 }),
        ],
      ),
    );
    const levels = Object.fromEntries(
      view.running.map((row) => [row.item.childId, row.level]),
    );
    expect(levels).toEqual({
      'd-1': 0,
      top: 1,
      inner: 2,
      // Absent depth is not "top level" and not a guess: no extra indent.
      'unknown-depth': 1,
      // A reporter that is no delegate here has no parent row to nest under.
      loose: 2,
    });
    // The delegate is followed by its nest.
    expect(view.running[0].item.childId).toBe('d-1');
  });

  test('a delegate of a delegate nests under it', () => {
    const view = selectGlobalChildWork(
      input([delegate('d-1'), delegate('d-2', { parent: { taskId: 'd-1' } })]),
    );
    expect(view.running.map((row) => [row.item.childId, row.level])).toEqual([
      ['d-1', 0],
      ['d-2', 1],
    ]);
  });

  test('elapsed has a start only when one was reported or the spawning tool card carries one', () => {
    const view = selectGlobalChildWork(
      input(
        [],
        [
          engineItem('r', 'reported', {
            startedAt: '2026-09-24T00:00:05.000Z',
          }),
          engineItem('r', 'from-tool', { parent: { toolCallId: 'toolu-1' } }),
          engineItem('r', 'nothing'),
        ],
        { toolCallStartedAt: (id) => (id === 'toolu-1' ? 1234 : undefined) },
      ),
    );
    const starts = Object.fromEntries(
      view.running.map((row) => [row.item.childId, row.startedAtMs]),
    );
    expect(starts).toEqual({
      reported: Date.parse('2026-09-24T00:00:05.000Z'),
      'from-tool': 1234,
      nothing: undefined,
    });
  });
});

describe('scopes and bounds', () => {
  test('the global finished list is bounded and says how many it left out', () => {
    const sessions = Array.from({ length: GLOBAL_FINISHED_LIMIT + 7 }, (_, i) =>
      delegate(`d-${i}`, {
        status: 'completed',
        endedAt: new Date(Date.UTC(2026, 8, 24, 0, 0, i)).toISOString(),
      }),
    );
    const view = selectGlobalChildWork(input(sessions));
    expect(view.finished).toHaveLength(GLOBAL_FINISHED_LIMIT);
    expect(view.finishedOmitted).toBe(7);
    // Newest first; the oldest are the ones left out.
    expect(view.finished[0].item.childId).toBe(
      `d-${GLOBAL_FINISHED_LIMIT + 6}`,
    );
  });

  test('a chat shows the subagents its sessions and its delegates report — never the delegates themselves (those are store cards)', () => {
    const facts = input(
      [
        delegate('d-mine', { parent: { taskId: 'exec-1' } }),
        delegate('d-theirs', { parent: { taskId: 'exec-9' } }),
      ],
      [
        engineItem('exec-1', 'own-sub'),
        engineItem('d-mine', 'delegate-sub'),
        engineItem('d-theirs', 'their-delegate-sub'),
        engineItem('exec-9', 'other-sub'),
      ],
      {
        chatKeyFor: (id) =>
          id === 'exec-1' ? 'chat-1' : id === 'exec-9' ? 'chat-9' : undefined,
        // The bind edge the background-tasks store recorded.
        delegateParentOf: (id) =>
          id === 'd-mine' ? 'exec-1' : id === 'd-theirs' ? 'exec-9' : undefined,
      },
    );
    const ids = selectChatChildWork(facts, 'chat-1').running.map(
      (row) => row.item.childId,
    );
    expect(ids.sort()).toEqual(['delegate-sub', 'own-sub']);
  });
});

describe('what the chat says about subagents it cannot show', () => {
  test('a server refusal is shown in the server’s words, even when the matrix would say "does not report"', () => {
    const notice = subagentNoticeFor({
      provider: 'acp',
      observed: [
        {
          kind: 'not-reported',
          reason:
            'The engine reports subagents, but Station does not map them yet.',
        },
      ],
    });
    expect(notice).toEqual({
      label: 'Subagents are not shown for this engine',
      description:
        'The engine reports subagents, but Station does not map them yet.',
    });
  });

  test('a reporter the server says reports children is never called silent', () => {
    expect(
      subagentNoticeFor({
        provider: 'acp',
        observed: [{ kind: 'reported' }, { kind: 'not-reported', reason: 'x' }],
      }),
    ).toBe(undefined);
  });

  test('with no server word, the matrix speaks; an engine it declares is not silent', () => {
    expect(subagentNoticeFor({ provider: 'acp', observed: [] })?.label).toBe(
      'This engine does not report subagents',
    );
    expect(subagentNoticeFor({ provider: 'claude', observed: [] })).toBe(
      undefined,
    );
  });

  test('the notice is the chat empty state; without one the empty says none are running', () => {
    const notice = { label: 'Subagents are not shown for this engine' };
    expect(
      emptyStateFor({ scope: 'chat', hasChat: true, subagentNotice: notice }),
    ).toBe(notice);
    expect(emptyStateFor({ scope: 'chat', hasChat: true }).label).toBe(
      'No subagents running',
    );
  });
});

describe('which open chat a session thread names', () => {
  test('a unique match resolves; an ambiguous one declines instead of taking the first', () => {
    const chats = {
      'chat-a': { currentSessionId: 'exec-a', conversationId: 'conv-shared' },
      'chat-b': { currentSessionId: 'exec-b', conversationId: 'conv-shared' },
      'chat-c': { conversationId: 'conv-c' },
    };
    expect(uniqueChatKey(chats, 'chat-a')).toBe('chat-a');
    expect(uniqueChatKey(chats, 'exec-b')).toBe('chat-b');
    expect(uniqueChatKey(chats, 'conv-c')).toBe('chat-c');
    expect(uniqueChatKey(chats, 'conv-shared')).toBe(undefined);
    expect(uniqueChatKey(chats, 'nobody')).toBe(undefined);
  });
});
