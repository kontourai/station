/** @vitest-environment jsdom */

/**
 * #4266: a subagent card's place in its turn is a character offset into the
 * turn's text, counted over every text delta. A settled turn folds the
 * narration between its tool calls into the batch, so that narration must
 * still count, or the card lands inside the outcome text and splits it.
 */
import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';
import { foldTurnWork, type ToolCallLike } from '../tool-call-runs';
import {
  type TranscriptChild,
  TranscriptChildrenContext,
  TranscriptTurnContext,
  useTranscriptChildBlocks,
} from '../transcript-child-work';

const INTENT = 'I will run the commands, then ask a subagent to list the files.';
const NARRATION = 'The shell is stalling, so I will use the system Python.';
const OUTCOME =
  'Completed the commands.\n\nThe subagent found one file: `README.md`.';

const parts: ToolCallLike[] = [
  { type: 'text', content: INTENT },
  { type: 'tool-invocation', toolCallId: 'cmd-1', toolName: 'exec' },
  { type: 'text', content: NARRATION },
  { type: 'tool-invocation', toolCallId: 'cmd-2', toolName: 'exec' },
  { type: 'tool-invocation', toolCallId: 'spawn-1', toolName: 'spawn_agent' },
  { type: 'text', content: OUTCOME },
];

const child: TranscriptChild = {
  item: {
    childId: 'child-1',
    reporterThreadId: 'thread-1',
    status: 'completed',
  } as unknown as ChildWorkItem,
  toolAnchor: false,
  spawn: {
    turnId: 'turn-1',
    eventIndex: 7,
    standalone: false,
    toolAnchor: false,
    // Spawned after the second command: every text delta before it.
    textOffset: INTENT.length + NARRATION.length,
    turnTextOffset: INTENT.length + NARRATION.length,
    afterToolCallId: 'cmd-2',
  },
};

test('a folded turn’s card sits after its batch, and its outcome text stays whole', () => {
  const blocks = foldTurnWork(parts);
  // The premise: the narration was folded into the batch.
  expect(
    blocks.some(
      (block) =>
        block.type === 'tool-call-run' &&
        block.interludes?.some(({ part }) => part.content === NARRATION),
    ),
  ).toBe(true);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TranscriptChildrenContext.Provider value={new Map([['c', child]])}>
      <TranscriptTurnContext.Provider
        value={{ threadId: 'thread-1', turnId: 'turn-1', firstRow: true }}
      >
        {children}
      </TranscriptTurnContext.Provider>
    </TranscriptChildrenContext.Provider>
  );
  const { result } = renderHook(() => useTranscriptChildBlocks(blocks), {
    wrapper,
  });
  const shape = result.current.map((block) =>
    block.type === 'subagent'
      ? 'card'
      : block.type === 'tool-call-run'
        ? 'batch'
        : block.type === 'content-part'
          ? `text:${block.part.content}`
          : block.type,
  );
  expect(shape).toEqual([`text:${INTENT}`, 'batch', 'card', `text:${OUTCOME}`]);
});
