/** @vitest-environment jsdom */

import { render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mountedDecisionSurfaces } from '../../../lib/custom-appearance/decision-surfaces';
import { NotificationContainer } from '../NotificationContainer';

// Same mocking shape as `NotificationContainer.test.tsx`.
let notifications: Array<Record<string, unknown>> = [];
vi.mock('../../../contexts/ToastContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../contexts/ToastContext')>()),
  useNotificationHistory: () => notifications,
  useToast: () => ({ dismissToast: vi.fn(), dismissAllToasts: vi.fn() }),
}));
vi.mock('../../../contexts/ActiveChatsContext', () => ({
  useActiveChatIds: () => [],
}));
vi.mock('../../../contexts/NavigationContext', () => {
  const navigation = () => ({
    setProject: vi.fn(),
    setLayout: vi.fn(),
    navigate: vi.fn(),
  });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});

const toast = (patch: Record<string, unknown>) => ({
  id: 'n1',
  message: 'Something happened',
  type: 'info',
  timestamp: Date.now(),
  dismissed: false,
  ...patch,
});

afterEach(() => {
  notifications = [];
});

describe('NotificationContainer decision surface', () => {
  test('any notification carrying actions holds custom CSS off, whatever its type', () => {
    notifications = [
      toast({
        actions: [{ label: 'Allow', variant: 'primary', onClick: () => {} }],
      }),
    ];
    const view = render(<NotificationContainer />);
    expect(mountedDecisionSurfaces()).toContain('approval-toast');
    view.unmount();
    expect(mountedDecisionSurfaces()).not.toContain('approval-toast');
  });

  test('a plain notice without actions does not', () => {
    notifications = [toast({})];
    const view = render(<NotificationContainer />);
    expect(mountedDecisionSurfaces()).not.toContain('approval-toast');
    view.unmount();
  });
});
