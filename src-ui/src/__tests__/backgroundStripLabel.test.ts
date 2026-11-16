/**
 * @vitest-environment jsdom
 */
import { describe, expect, test } from 'vitest';
import {
  backgroundStripLabel,
  type ChatBackgroundWorkItem,
} from '../components/chat/BackgroundTaskActivity';
import type { BackgroundTaskEntry } from '../contexts/background-tasks-store';

function item(
  id: string,
  kind: ChatBackgroundWorkItem['kind'],
  title = id,
): ChatBackgroundWorkItem {
  const entry: BackgroundTaskEntry = {
    id,
    kind: kind === 'tool' ? 'tool' : 'agent',
    source: kind === 'tool' ? 'tool-event' : 'provider-task',
    chatThreadId: 'chat',
    title,
    state: 'running',
  };
  return { entry, kind };
}

const agents = Array.from({ length: 9 }, (_, i) => item(`a-${i}`, 'agent'));
const tools = Array.from({ length: 3 }, (_, i) => item(`t-${i}`, 'tool'));
const shown =
  (ids: Iterable<string>) =>
  (entry: BackgroundTaskEntry): boolean =>
    new Set(ids).has(entry.id);

describe('the background strip line', () => {
  test('work the transcript shows is counted "above"; the rest is what the strip lists', () => {
    expect(
      backgroundStripLabel({
        work: [...agents, ...tools],
        shownAbove: shown(agents.map(({ entry }) => entry.id)),
        serverCount: 9,
      }),
    ).toBe('9 agents above · 3 tools running');
  });

  test('all of it shown above', () => {
    expect(
      backgroundStripLabel({
        work: [...agents, ...tools],
        shownAbove: () => true,
        serverCount: 9,
      }),
    ).toBe('9 agents and 3 tools running above');
  });

  test('none of it shown above', () => {
    expect(
      backgroundStripLabel({
        work: [...agents, ...tools],
        shownAbove: () => false,
        serverCount: 9,
      }),
    ).toBe('9 agents and 3 tools running');
  });

  test('one task is named, by its kind', () => {
    expect(
      backgroundStripLabel({
        work: [item('m-1', 'monitor', 'Watch the build')],
        shownAbove: () => false,
        serverCount: 1,
      }),
    ).toBe('Monitor watching — Watch the build');
  });

  test('with no child named here, only Station’s count is known', () => {
    expect(
      backgroundStripLabel({
        work: tools,
        shownAbove: () => true,
        serverCount: 2,
      }),
    ).toBe('2 background tasks running');
  });
});
