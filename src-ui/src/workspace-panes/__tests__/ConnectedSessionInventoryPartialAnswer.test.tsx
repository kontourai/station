/** @vitest-environment jsdom */

import { createStationAnswerBinding } from '@kontourai/station-contracts/task-basis';
import {
  composeBasisProjection,
  SURFACE_BASIS_VERSION,
} from '@kontourai/surface/basis';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { commitSessionInventorySelection } from '../sessionInventorySelection';

// #3853: a current-answer projection whose Surface answer is not available
// still reaches the full inventory. This file keeps the real contract parser,
// the real Surface Basis view model and the real standing summary; only the
// transport hooks are replaced, and the inventory hook behaves as the SDK
// does (a parser rejection becomes a query error).
const hooks = vi.hoisted(() => ({
  inventory: vi.fn(),
  authority: { apiBase: 'http://station.test', authorityKey: 'epoch-a' },
}));

vi.mock('@kontourai/station-sdk/session-inventory', () => ({
  useSessionInventoryQuery: (...args: unknown[]) => hooks.inventory(...args),
  useSessionInventoryGroupPage: () => ({ data: undefined }),
}));
vi.mock('@kontourai/station-sdk/session-outputs', () => ({
  useSessionOutputInspection: () => ({ data: undefined, isLoading: false }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useTasksQuery: () => ({ data: [], isLoading: false, error: null }),
}));
vi.mock('@kontourai/station-sdk/session-output-actions', () => ({
  useKeepSessionOutputMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => hooks.authority,
}));

const { parseSessionInventoryProjection, SESSION_INVENTORY_V2_GROUP_IDS } =
  await import('@kontourai/station-contracts/session-inventory');
const { ConnectedSessionInventory } = await import(
  '../ConnectedSessionInventory'
);

const AT = '2026-10-20T00:00:00.000Z';
const scope = {
  kind: 'current-answer' as const,
  sessionId: 'session',
  turnId: 'turn-a',
};

function unavailableAnswerProjection() {
  const items: Record<string, unknown[]> = {
    inputs: [
      {
        kind: 'thread-authored-input',
        key: 'input:event-input',
        owner: { owner: 'thread.answer-basis', id: 'v1' },
        relations: ['contributed-to'],
        sessionId: 'session',
        eventId: 'event-input',
        turnId: 'turn-a',
        inputKind: 'message',
        attachmentDescriptors: [],
      },
    ],
    execution: [
      {
        kind: 'thread-tool-result',
        key: 'tool:event-tool',
        owner: { owner: 'station.session', id: 'v1' },
        relations: ['observed-during', 'produced-by'],
        sessionId: 'session',
        eventId: 'event-tool',
        turnId: 'turn-a',
        toolCallId: 'call-a',
        name: 'read_file',
        terminalStatus: 'succeeded',
      },
    ],
  };
  return {
    version: 'station.session-inventory/v2',
    scope,
    basis: composeBasisProjection({
      version: SURFACE_BASIS_VERSION,
      answer: {
        owner: { authority: '@kontourai/thread' },
        state: 'unavailable',
        observedAt: AT,
      },
      assessment: {
        owner: { authority: '@kontourai/surface' },
        state: 'not-captured',
        observedAt: AT,
      },
      contributions: [],
    }),
    basisBinding: createStationAnswerBinding({
      sessionId: 'session',
      turnId: 'turn-a',
      messageId: 'message-a',
    }),
    groups: SESSION_INVENTORY_V2_GROUP_IDS.map((id) =>
      id === 'sources'
        ? {
            id,
            owner: { owner: '@kontourai/fieldwork', id: 'reviewed-source/v1' },
            state: 'unavailable',
            items: [],
            gaps: [{ kind: 'unavailable' }],
          }
        : {
            id,
            owner: { owner: 'station.inventory', id: 'v2' },
            state: items[id] ? 'available' : 'empty',
            count: { kind: 'exact', value: items[id]?.length ?? 0 },
            items: items[id] ?? [],
            gaps: [],
          },
    ),
  };
}

describe('ConnectedSessionInventory with a non-available current answer', () => {
  test('shows the resolved groups beside the answer state', () => {
    const parsed = parseSessionInventoryProjection(
      unavailableAnswerProjection(),
    );
    hooks.inventory.mockReturnValue({
      data: parsed ?? undefined,
      isLoading: false,
      error: parsed ? null : new Error('invalid Session inventory'),
    });
    commitSessionInventorySelection(
      { ...hooks.authority, sessionId: 'session' },
      { scope, groupId: 'inputs' },
    );
    render(
      <ConnectedSessionInventory
        sessionId="session"
        currentProjectId="project"
        initialScope={scope}
      />,
    );

    expect(screen.queryByText('Session inventory is unavailable.')).toBeNull();
    // The answer's own state, from the real Surface Basis view model.
    expect(screen.getByRole('status').textContent).toBe(
      'Temporarily unavailable — The answer observation is unavailable.',
    );
    expect(screen.getByText('Answer observation is unavailable.')).toBeTruthy();
    // The other groups survive, and support stays distinct from lineage.
    fireEvent.click(screen.getByRole('button', { name: 'Inputs 1' }));
    expect(screen.getByText(/Contributed to this answer/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Execution 1' }));
    expect(screen.getByText(/Context from this Session/)).toBeTruthy();
    expect(screen.queryByText(/Contributed to this answer/)).toBeNull();
  });
});
