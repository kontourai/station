/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { navigate, launch, statusById, candidateById, observationById } =
  vi.hoisted(() => ({
    navigate: vi.fn(),
    launch: vi.fn(),
    statusById: new Map<string, unknown>(),
    candidateById: new Map<string, unknown>(),
    observationById: new Map<string, unknown>(),
  }));

const query = (data: unknown) => ({
  data,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useStarterWorkQuery: (id: string) => query(statusById.get(id)),
  useStarterInspectionCandidateQuery: (id: string) =>
    query(candidateById.get(id)),
  useStarterWorkObservationQuery: (id: string) =>
    query(observationById.get(id)),
  useLaunchStarterInspectionMutation: () => ({
    mutateAsync: launch,
    isPending: false,
    isError: false,
  }),
}));

import { StarterInspectionCards } from '../StarterInspectionCards';

describe('StarterInspectionCards', () => {
  beforeEach(() => {
    navigate.mockReset();
    launch.mockReset();
    statusById.clear();
    candidateById.clear();
    observationById.clear();
    statusById.set('inspect-approval', { state: 'unbound' });
    statusById.set('inspect-receipt', { state: 'unbound' });
    candidateById.set('inspect-approval', {
      state: 'current',
      reference: { kind: 'approval', id: 'notification-1' },
    });
    candidateById.set('inspect-receipt', { state: 'missing' });
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(async () => new Uint8Array(32).fill(7).buffer),
      },
    });
  });

  test('launches one exact approval with a stable identity and owner href', async () => {
    launch.mockResolvedValue({
      state: 'opened',
      href: '/notifications?approval=notification-1',
    });
    render(<StarterInspectionCards />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect approval' }));
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    expect(launch).toHaveBeenCalledWith({
      starterId: 'inspect-approval',
      operationId: `inspect:inspect-approval:${'07'.repeat(32)}`,
      targetRef: { kind: 'approval', id: 'notification-1' },
    });
    expect(navigate).toHaveBeenCalledWith('/notifications', {
      approval: 'notification-1',
    });
  });

  test('reopens only the exact bound Project and receipt tuple', () => {
    statusById.set('inspect-receipt', {
      state: 'bound',
      binding: {
        targetRef: {
          kind: 'receipt',
          owner: 'independent-review',
          id: 'same-id',
          projectSlug: 'bravo',
        },
      },
    });
    observationById.set('inspect-receipt', {
      starterId: 'inspect-receipt',
      targetRef: {
        kind: 'receipt',
        owner: 'independent-review',
        id: 'same-id',
        projectSlug: 'bravo',
      },
      href: '/review-queue?receipt=same-id&project=bravo',
      completion: { state: 'receipt-present' },
    });
    render(<StarterInspectionCards />);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen receipt' }));
    expect(navigate).toHaveBeenCalledWith('/review-queue', {
      receipt: 'same-id',
      project: 'bravo',
    });
    expect(launch).not.toHaveBeenCalled();
  });

  test('does not substitute another owner when the candidate is missing', () => {
    candidateById.set('inspect-approval', { state: 'missing' });
    render(<StarterInspectionCards />);
    expect(
      screen.queryByRole('button', { name: 'Inspect approval' }),
    ).toBeNull();
    expect(
      screen.getAllByText('An exact owner-backed item is not available yet.'),
    ).toHaveLength(2);
  });
});
