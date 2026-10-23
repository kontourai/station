/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NavigationProvider } from '../../contexts/NavigationContext';
import { navigationStore } from '../../contexts/navigation-store';
import { ProjectNavigation } from './ProjectNavigation';

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
afterEach(cleanup);

function mount(search = '') {
  navigationStore.navigate('/navigation-test-reset');
  navigationStore.navigate(`/projects/demo${search}`);
  return render(
    <NavigationProvider>
      <ProjectNavigation slug="demo" />
    </NavigationProvider>,
  );
}

describe('Project destination navigation', () => {
  test('opens Overview by default and restores destination on browser Back and Forward', async () => {
    mount();
    expect(
      screen
        .getByRole('link', { name: 'Overview' })
        .getAttribute('aria-current'),
    ).toBe('page');
    fireEvent.click(screen.getByRole('link', { name: 'Files & connections' }));
    expect(new URLSearchParams(window.location.search).get('section')).toBe(
      'sources',
    );
    expect(
      screen
        .getByRole('link', { name: 'Files & connections' })
        .getAttribute('aria-current'),
    ).toBe('page');
    await act(async () => {
      window.history.back();
      await vi.waitFor(() =>
        expect(
          new URLSearchParams(window.location.search).get('section'),
        ).toBeNull(),
      );
    });
    expect(
      screen
        .getByRole('link', { name: 'Overview' })
        .getAttribute('aria-current'),
    ).toBe('page');
    await act(async () => {
      window.history.forward();
      await vi.waitFor(() =>
        expect(new URLSearchParams(window.location.search).get('section')).toBe(
          'sources',
        ),
      );
    });
    expect(
      screen
        .getByRole('link', { name: 'Files & connections' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  test('honors direct destination and existing Starter Work links on mount', () => {
    const first = mount('?section=room');
    expect(
      screen
        .getByRole('link', { name: '# Project room' })
        .getAttribute('aria-current'),
    ).toBe('page');
    first.unmount();
    mount('?starter=start-task');
    expect(
      screen.getByRole('link', { name: 'Tasks' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  test('destination and Settings links consult the existing dirty-state guard', () => {
    mount('?section=sources');
    const decisions: Array<() => void> = [];
    const unregister = navigationStore.registerNavigationGuard(
      Symbol('source-draft'),
      (proceed) => decisions.push(proceed),
    );
    try {
      fireEvent.click(screen.getByRole('link', { name: 'Tasks' }));
      expect(decisions).toHaveLength(1);
      expect(new URLSearchParams(window.location.search).get('section')).toBe(
        'sources',
      );
      act(() => decisions[0]?.());
      expect(
        screen
          .getByRole('link', { name: 'Tasks' })
          .getAttribute('aria-current'),
      ).toBe('page');
      fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
      expect(decisions).toHaveLength(2);
      expect(window.location.pathname).toBe('/projects/demo');
      act(() => decisions[1]?.());
      expect(window.location.pathname).toBe('/projects/demo/edit');
    } finally {
      unregister();
    }
  });
});

test('member navigation exposes the shared room and work without operator destinations', () => {
  render(
    <NavigationProvider>
      <ProjectNavigation slug="team" member />
    </NavigationProvider>,
  );
  expect(
    screen.getByRole('link', { name: '# Project room' }).getAttribute('href'),
  ).toBe('/projects/team?section=room');
  expect(screen.getByRole('link', { name: 'Tasks' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  expect(
    screen.queryByRole('link', { name: 'Files & connections' }),
  ).toBeNull();
});

test('expanding a room preserves its editor while leaving for Tasks asks the dirty guard', () => {
  mount();
  const decisions: Array<() => void> = [];
  const unregister = navigationStore.registerNavigationGuard(
    Symbol('room-draft'),
    (proceed) => decisions.push(proceed),
  );
  try {
    fireEvent.click(screen.getByRole('link', { name: '# Project room' }));
    expect(new URLSearchParams(window.location.search).get('section')).toBe(
      'room',
    );
    expect(decisions).toHaveLength(0);
    fireEvent.click(screen.getByRole('link', { name: 'Tasks' }));
    expect(decisions).toHaveLength(1);
    expect(new URLSearchParams(window.location.search).get('section')).toBe(
      'room',
    );
    act(() => decisions[0]?.());
    expect(new URLSearchParams(window.location.search).get('section')).toBe(
      'tasks',
    );
  } finally {
    unregister();
  }
});
