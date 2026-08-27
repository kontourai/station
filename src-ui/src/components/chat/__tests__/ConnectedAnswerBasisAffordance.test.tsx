/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openBasis: vi.fn(),
  useProjectQuery: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useProjectQuery: mocks.useProjectQuery,
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
vi.mock('../../../workspace-panes/BasisPaneLauncher', () => ({
  useBasisPaneLauncher: () => ({
    openBasis: mocks.openBasis,
    fallback: null,
  }),
}));

const { ConnectedAnswerBasisAffordance } = await import(
  '../ConnectedAnswerBasisAffordance'
);

describe('ConnectedAnswerBasisAffordance', () => {
  beforeEach(() => {
    mocks.openBasis.mockReset();
    mocks.useProjectQuery.mockReset();
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
    await waitFor(() =>
      expect(mocks.useProjectQuery).toHaveBeenLastCalledWith(
        'project-route-slug',
        expect.objectContaining({ enabled: true }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Basis' }));
    const [instance] = mocks.openBasis.mock.lastCall ?? [];
    expect(instance?.boundContext).toMatchObject({
      projectId: 'project-canonical-id',
      sessionId: 'session-a',
      turnId: 'turn-a',
    });
    expect(instance?.boundContext.projectId).not.toBe('project-route-slug');
  });

  test('uses the responsive fallback when the canonical Project id is unavailable', () => {
    mocks.useProjectQuery.mockReturnValue({ data: undefined });
    render(
      <ConnectedAnswerBasisAffordance
        projectSlug="project-route-slug"
        sessionId="session-a"
        turnId="turn-a"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Basis' }));
    expect(mocks.openBasis.mock.lastCall?.[0]).toBeNull();
  });
});
