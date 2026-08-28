/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  closeSessionInventoryOccurrence,
  readSessionInventoryOccurrence,
  registerSessionInventoryHost,
} from '../../chat-dock/sessionInventoryOccurrence';

const mocks = vi.hoisted(() => ({
  useProjectQuery: vi.fn(),
  openBasis: vi.fn(),
  authority: {
    apiBase: 'http://station.test',
    authorityKey: 'authority-a',
    isCurrent: () => true,
  },
}));

vi.mock('@kontourai/station-sdk', () => ({
  useProjectQuery: mocks.useProjectQuery,
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => mocks.authority,
}));
vi.mock('../../../workspace-panes/BasisPaneLauncher', () => ({
  useBasisPaneLauncher: () => ({ openBasis: mocks.openBasis, fallback: null }),
}));
vi.mock('@kontourai/station-basis-pane/answer-basis-affordance', () => ({
  AnswerBasisAffordance: ({
    onOpen,
  }: {
    onOpen(trigger: HTMLButtonElement): void;
  }) => (
    <button type="button" onClick={(event) => onOpen(event.currentTarget)}>
      Basis
    </button>
  ),
}));
const { ConnectedAnswerBasisAffordance } = await import(
  '../ConnectedAnswerBasisAffordance'
);

describe('ConnectedAnswerBasisAffordance', () => {
  let unregisterHost: (() => void) | undefined;

  beforeEach(() => {
    closeSessionInventoryOccurrence();
    mocks.useProjectQuery.mockReset();
    mocks.openBasis.mockReset();
    unregisterHost?.();
    unregisterHost = registerSessionInventoryHost('chat-host', {
      authorityKey: mocks.authority.authorityKey,
      chatStoreId: 'session-a',
      executionId: 'session-a',
    });
  });

  test('resolves the route slug to the canonical Project id before opening a Pane', async () => {
    mocks.useProjectQuery.mockReturnValue({
      data: { id: 'project-canonical-id', slug: 'project-route-slug' },
    });
    render(
      <ConnectedAnswerBasisAffordance
        projectSlug="project-route-slug"
        sessionId="session-a"
        turnId="turn-a"
      />,
    );
    expect(mocks.useProjectQuery).toHaveBeenLastCalledWith(
      'project-route-slug',
      expect.objectContaining({ enabled: false }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Basis' }));
    await waitFor(() =>
      expect(mocks.useProjectQuery).toHaveBeenLastCalledWith(
        'project-route-slug',
        expect.objectContaining({ enabled: true }),
      ),
    );
    expect(readSessionInventoryOccurrence()).toMatchObject({
      projectId: 'project-canonical-id',
      requestedScope: {
        kind: 'current-answer',
        sessionId: 'session-a',
        turnId: 'turn-a',
      },
    });
    expect(readSessionInventoryOccurrence()?.projectId).not.toBe(
      'project-route-slug',
    );
  });

  test('settles into the responsive fallback when the canonical Project id is unavailable', async () => {
    // An answer can outlive the dock host that rendered it. That path must
    // retain the exact answer scope in a local fallback, rather than opening
    // an arbitrary host or requiring another click.
    unregisterHost?.();
    unregisterHost = undefined;
    mocks.useProjectQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
    });
    render(
      <ConnectedAnswerBasisAffordance
        projectSlug="project-route-slug"
        sessionId="session-a"
        turnId="turn-a"
      />,
    );
    expect(mocks.useProjectQuery).toHaveBeenLastCalledWith(
      'project-route-slug',
      expect.objectContaining({ enabled: false }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Basis' }));
    await waitFor(() =>
      expect(mocks.useProjectQuery).toHaveBeenLastCalledWith(
        'project-route-slug',
        expect.objectContaining({ enabled: true }),
      ),
    );
    expect(readSessionInventoryOccurrence()).toBeUndefined();
    expect(mocks.openBasis).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        kind: 'session-inventory',
        initialScope: expect.objectContaining({ turnId: 'turn-a' }),
      }),
      expect.any(HTMLButtonElement),
    );
  });
});
