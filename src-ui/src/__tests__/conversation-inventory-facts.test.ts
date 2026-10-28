import type { ConversationListItem } from '@kontourai/station-contracts/orchestration';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, it } from 'vitest';
import { withConversationInventory } from '../views/home/conversation-inventory-facts';
import {
  buildOrchestrationItems,
  type HomeWorkItem,
} from '../views/home/home-view-model';

function item(over: Partial<HomeWorkItem> & { id: string }): HomeWorkItem {
  return {
    kind: 'orchestration',
    kindLabel: 'Session',
    title: 'Row',
    projectLabel: 'p',
    agentLabel: 'a',
    modelLabel: 'm',
    updatedAt: Date.parse('2026-10-28T12:00:00.000Z'),
    lifecycleLabel: 'Completed',
    ...over,
  };
}

function conversation(
  over: Partial<ConversationListItem> & { id: string },
): ConversationListItem {
  return {
    source: 'runtime',
    agentSlug: 'station' as ConversationListItem['agentSlug'],
    title: 'Row',
    createdAt: '2026-10-28T09:00:00.000Z',
    updatedAt: '2026-10-28T12:00:00.000Z',
    messageCount: 2,
    mutable: false,
    answerability: { answerable: true },
    ...over,
  };
}

describe('withConversationInventory (#4266)', () => {
  it('layers the last view, the recorded finish time and the engines that ran', () => {
    const [mapped] = withConversationInventory(
      [item({ id: 'c1' })],
      new Map([
        [
          'c1',
          conversation({
            id: 'c1',
            acknowledgedAt: '2026-10-28T10:00:00.000Z',
            lifecycleChangedAt: '2026-10-28T11:00:00.000Z',
            executionProviders: ['claude', 'codex', 'not a clean id!'],
          }),
        ],
      ]),
    );
    expect(mapped).toMatchObject({
      conversationUpdatedAt: '2026-10-28T12:00:00.000Z',
      acknowledgedAt: Date.parse('2026-10-28T10:00:00.000Z'),
      terminalAt: Date.parse('2026-10-28T11:00:00.000Z'),
      executionProviders: ['claude', 'codex'],
    });
  });

  it('never stamps a finish time on live work, and leaves rows the inventory does not list untouched', () => {
    const running = item({ id: 'c1', lifecycleLabel: 'Running' });
    const unlisted = item({ id: 'other' });
    const [mappedRunning, mappedUnlisted] = withConversationInventory(
      [running, unlisted],
      new Map([
        [
          'c1',
          conversation({
            id: 'c1',
            lifecycleChangedAt: '2026-10-28T11:00:00.000Z',
          }),
        ],
      ]),
    );
    expect(mappedRunning.terminalAt).toBeUndefined();
    expect(mappedRunning.executionProviders).toBeUndefined();
    expect(mappedUnlisted).toBe(unlisted);
  });
});

describe('session rows carry the recorded finish time', () => {
  const session = (
    over: Partial<OrchestrationSessionSummary>,
  ): OrchestrationSessionSummary =>
    ({
      provider: 'codex',
      threadId: 'thread-1',
      status: 'ready',
      controlMode: 'station-owned',
      answerability: { answerable: true },
      isLoaded: false,
      isPersisted: true,
      eventCount: 3,
      pid: null,
      exitCode: null,
      hasRunningSubprocess: false,
      cols: 80,
      rows: 24,
      createdAt: '2026-10-25T09:00:00.000Z',
      updatedAt: '2026-10-28T12:00:00.000Z',
      ...over,
    }) as OrchestrationSessionSummary;

  it('takes terminalAt from lifecycleChangedAt for finished work only', () => {
    const [finished] = buildOrchestrationItems(
      [
        session({
          lifecycleState: 'completed',
          lifecycleChangedAt: '2026-10-25T10:00:00.000Z',
        }),
      ],
      [],
    );
    expect(finished.lifecycleLabel).toBe('Completed');
    expect(finished.terminalAt).toBe(Date.parse('2026-10-25T10:00:00.000Z'));

    const [running] = buildOrchestrationItems(
      [
        session({
          lifecycleState: 'running',
          hasActiveTurn: true,
          lifecycleChangedAt: '2026-10-25T10:00:00.000Z',
        }),
      ],
      [],
    );
    expect(running.terminalAt).toBeUndefined();
  });
});
