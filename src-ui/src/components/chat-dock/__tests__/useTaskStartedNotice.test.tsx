// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { ToastProvider, toastStore } from '../../../contexts/ToastContext';
import { useTaskStartedNotice } from '../useTaskStartedNotice';

const showSurface = vi.hoisted(() => vi.fn());
vi.mock('../../../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));

afterEach(() => {
  act(() => toastStore.clear());
  showSurface.mockReset();
});

test('a remote start names its Station and opens its task in Activity', () => {
  const beforeNavigate = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ToastProvider>{children}</ToastProvider>
  );
  const { result } = renderHook(() => useTaskStartedNotice(beforeNavigate), {
    wrapper,
  });
  act(() => result.current({ sessionId: 'session:remote' }, 'brian-media'));

  const toast = toastStore
    .getSnapshot()
    .find((entry) => entry.message === 'Task started on brian-media.');
  expect(toast).toBeDefined();
  const open = toast?.actions?.find((action) => action.label === 'Open task');
  expect(open).toBeDefined();
  expect(showSurface).not.toHaveBeenCalled();
  act(() => open!.onClick());
  expect(beforeNavigate).toHaveBeenCalledTimes(1);
  expect(showSurface).toHaveBeenCalledWith('activity', {
    session: 'session:remote',
  });
});
