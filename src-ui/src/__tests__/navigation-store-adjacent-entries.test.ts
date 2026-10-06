/**
 * @vitest-environment jsdom
 */
import { describe, expect, test, vi } from 'vitest';
import { navigationStore } from '../contexts/navigation-store';

/**
 * The store remembers where each entry it has seen points, so an in-app
 * Back/Forward control (the Coding stack's) can tell whether the adjacent
 * entry is its own. The browser exposes only the CURRENT entry's URL; these
 * pin the store's answer against real history traversal.
 */
describe('navigationStore.adjacentLocation', () => {
  test('names the entry behind a push, and the entry ahead after Back', async () => {
    navigationStore.navigate('/projects/demo/layouts/coding');
    const chatIndex = navigationStore.getHistoryIndex();
    navigationStore.navigate('/projects/demo/layouts/coding', {
      pane: 'diff',
      paneScope: 'scope',
    });

    expect(navigationStore.getHistoryIndex()).toBe(chatIndex + 1);
    expect(navigationStore.adjacentLocation(-1)).toEqual({
      pathname: '/projects/demo/layouts/coding',
      search: '',
    });
    expect(navigationStore.adjacentLocation(1)).toBeNull();

    window.history.back();
    await vi.waitFor(() =>
      expect(navigationStore.getHistoryIndex()).toBe(chatIndex),
    );
    expect(navigationStore.adjacentLocation(1)).toEqual({
      pathname: '/projects/demo/layouts/coding',
      search: '?pane=diff&paneScope=scope',
    });
  });

  test('a push discards the forward entry it replaced', async () => {
    navigationStore.navigate('/a');
    navigationStore.navigate('/b');
    window.history.back();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/a'));
    expect(navigationStore.adjacentLocation(1)?.pathname).toBe('/b');

    navigationStore.navigate('/c');
    expect(navigationStore.adjacentLocation(1)).toBeNull();
    expect(navigationStore.adjacentLocation(-1)?.pathname).toBe('/a');
  });

  test('a param replacement rewrites the current entry, not a new one', () => {
    navigationStore.navigate('/projects/demo/layouts/coding');
    const index = navigationStore.getHistoryIndex();
    // A sibling move — the inbox choosing another conversation.
    navigationStore.setActiveChat('conversation-b');
    expect(navigationStore.getHistoryIndex()).toBe(index);
    navigationStore.navigate('/elsewhere');
    expect(navigationStore.adjacentLocation(-1)).toEqual({
      pathname: '/projects/demo/layouts/coding',
      search: '?chat=conversation-b',
    });
  });

  test('stays bounded however long the session', () => {
    const start = navigationStore.getHistoryIndex();
    for (let step = 0; step < 200; step += 1)
      navigationStore.navigate(`/step-${step}`);
    // The neighbour is still known; an entry 150 pushes back is not.
    expect(navigationStore.adjacentLocation(-1)?.pathname).toBe('/step-198');
    const entries = (
      navigationStore as unknown as { entryLocations: Map<number, unknown> }
    ).entryLocations;
    expect(entries.size).toBeLessThanOrEqual(64);
    expect(entries.has(start + 10)).toBe(false);
  });
});
