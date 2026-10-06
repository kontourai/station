/** @vitest-environment jsdom */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { type ComponentProps, useMemo } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LazyBoundaryProps } from '../components/LazyBoundary';
import type { CustomizeDialog } from '../components/project-sidebar/CustomizeDialog';

const chunk = vi.hoisted(() => ({ failures: 1, attempts: 0 }));

// Inject only the first import failure; recovery uses the real boundary and chooser.
vi.mock('../components/LazyBoundary', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../components/LazyBoundary')>();
  return {
    ...actual,
    LazyBoundary: (
      props: LazyBoundaryProps<ComponentProps<typeof CustomizeDialog>>,
    ) => {
      const load = useMemo(
        () => () => {
          chunk.attempts += 1;
          if (chunk.failures > 0) {
            chunk.failures -= 1;
            return Promise.reject(new Error('Customize chunk unavailable'));
          }
          return props.load();
        },
        [props.load],
      );
      return <actual.LazyBoundary {...props} load={load} />;
    },
  };
});

vi.mock('@kontourai/station-sdk', () => ({
  useOrchestrationSessionsQuery: () => ({ data: [], isError: false }),
}));
vi.mock('@kontourai/station-sdk/live-activity', () => ({
  useLiveActivityQuery: () => ({
    data: null,
    isError: false,
    isPending: false,
  }),
}));
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set(),
}));
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => vi.fn(),
}));

import { ProjectSidebarFooter } from '../components/project-sidebar/ProjectSidebarFooter';

beforeEach(() => {
  chunk.failures = 1;
  chunk.attempts = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});
afterEach(() => vi.restoreAllMocks());

test('a rejected Customize chunk has dialog recovery on a collapsed rail, closes, and retries into the chooser', async () => {
  const navigate = vi.fn();
  const { container } = render(
    <nav aria-label="Primary navigation" className="sidebar sidebar--collapsed">
      <ProjectSidebarFooter
        activePath="/settings"
        isMobile={false}
        navigate={navigate}
      />
    </nav>,
  );
  const trigger = screen.getByRole('button', { name: 'Customize' });
  trigger.focus();
  const beforeFailureHistoryLength = window.history.length;
  fireEvent.click(trigger);
  const recovery = await screen.findByRole('dialog', { name: 'Customize' });
  expect(container.contains(recovery)).toBe(false);
  expect(within(recovery).getByRole('alert').textContent).toContain(
    'Could not load Customize',
  );
  expect(within(recovery).getByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(window.history.length).toBe(beforeFailureHistoryLength);
  expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();

  fireEvent.click(
    within(recovery).getByRole('button', { name: 'Close Customize' }),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.queryByRole('dialog', { name: 'Customize' })).toBeNull();

  chunk.failures = 1;
  fireEvent.click(trigger);
  const secondRecovery = await screen.findByRole('dialog', {
    name: 'Customize',
  });
  fireEvent.click(
    within(secondRecovery).getByRole('button', { name: 'Retry' }),
  );
  await screen.findByRole('link', { name: 'Agents' });
  expect(chunk.attempts).toBe(3);
  const chooser = screen.getByRole('dialog', { name: 'Customize' });
  await waitFor(() =>
    expect(chooser.contains(document.activeElement)).toBe(true),
  );
  expect(window.history.length).toBe(beforeFailureHistoryLength + 1);
  fireEvent.click(
    within(chooser).getByRole('button', { name: 'Close Customize' }),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole('link', { name: 'Agents' }));
  expect(navigate).toHaveBeenCalledWith('/agents');
  expect(screen.queryByRole('dialog', { name: 'Customize' })).toBeNull();
});
