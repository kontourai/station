/**
 * @vitest-environment jsdom
 *
 * A subagent whose engine process died under it reads as Interrupted, with a
 * settled mark, never as "No result" with the dashed ring an absence of an
 * outcome gets; a batch counts it as "N interrupted".
 */

import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { SubagentCardsForCalls } from '../components/chat/SubagentTranscriptCard';
import { TranscriptChildrenContext } from '../components/chat/transcript-child-work';

const THREAD = 'codex-session-1';
const TOOL_CALL = 'call_spawn_1';

function child(
  childId: string,
  status: ChildWorkItem['status'],
): ChildWorkItem {
  return {
    producer: 'engine-subagent',
    reporterThreadId: THREAD,
    childId,
    status,
    parent: { toolCallId: TOOL_CALL, turnId: 'turn-1' },
    title: `Review ${childId}`,
    startedAt: '2026-10-14T14:25:00.000Z',
    endedAt: '2026-10-14T14:26:00.000Z',
  };
}

const toolPart = {
  type: 'tool-invocation',
  toolCallId: TOOL_CALL,
  toolName: 'spawnAgent',
  state: 'result',
  args: {},
  result: '',
};

function renderChildren(items: ChildWorkItem[]) {
  return render(
    <TranscriptChildrenContext.Provider
      value={
        new Map(
          items.map((item) => [
            item.childId,
            { item, toolAnchor: true, provider: 'codex' },
          ]),
        )
      }
    >
      <SubagentCardsForCalls calls={[{ part: toolPart, index: 0 }]} />
    </TranscriptChildrenContext.Provider>,
  );
}

afterEach(cleanup);

describe('an interrupted subagent', () => {
  test('reads Interrupted with a settled mark, not the pending dashed ring', () => {
    renderChildren([child('a', 'interrupted')]);
    const card = screen.getByTestId('subagent-card');
    expect(card.getAttribute('data-status')).toBe('interrupted');
    expect(within(card).getByText('Interrupted')).toBeTruthy();
    expect(within(card).queryByText('No result')).toBeNull();
    const status = card.querySelector('.subagent-card__status');
    expect(status?.querySelector('.subagent-card__hollow')).toBeNull();
    expect(status?.querySelector('.subagent-card__spinner')).toBeNull();
    expect(status?.querySelector('svg')).not.toBeNull();
  });

  test('an unresolved child keeps "No result" and its dashed ring', () => {
    renderChildren([child('a', 'unresolved')]);
    const card = screen.getByTestId('subagent-card');
    expect(within(card).getByText('No result')).toBeTruthy();
    expect(card.querySelector('.subagent-card__hollow')).not.toBeNull();
  });

  test('a running Codex child offers its transcript before it settles', () => {
    renderChildren([
      {
        ...child('a', 'running'),
        endedAt: undefined,
        transcript: {
          kind: 'codex-thread',
          threadId: '01a15c8b-0000-7000-8000-000000000003',
        },
      },
    ]);
    fireEvent.click(
      within(screen.getByTestId('subagent-card')).getByRole('button', {
        expanded: false,
      }),
    );
    expect(
      screen.getByRole('button', { name: 'View transcript' }),
    ).toBeTruthy();
  });

  test('a batch counts interrupted children by name', () => {
    renderChildren([
      child('a', 'interrupted'),
      child('b', 'interrupted'),
      child('c', 'interrupted'),
      child('d', 'interrupted'),
      child('e', 'completed'),
    ]);
    expect(
      screen.getByRole('button', { name: /5 subagents/ }).textContent,
    ).toContain('4 interrupted · 1 completed');
  });
});
