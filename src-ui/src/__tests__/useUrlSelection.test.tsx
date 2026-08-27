// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  NavigationProvider,
  navigationStore,
} from '../contexts/NavigationContext';
import { useUrlSelection } from '../hooks/useUrlSelection';

function wrapper({ children }: { children: ReactNode }) {
  return <NavigationProvider>{children}</NavigationProvider>;
}

describe('useUrlSelection', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    navigationStore.navigate('/');
  });

  test('selects an agent slug from its canonical post-redirect path', () => {
    navigationStore.navigate('/agents/planner');

    const { result } = renderHook(() => useUrlSelection('/agents'), {
      wrapper,
    });

    expect(result.current.selectedId).toBe('planner');
  });

  test('canonicalizes a legacy agent path at store ingestion (Back/Forward and initial load)', () => {
    // The real round-2 failure path: the browser lands on a legacy URL and the
    // store — the pathname authority useUrlSelection consumes — parses it via
    // its own popstate listener, which registers before App's rewrite runs.
    window.history.replaceState(
      {},
      '',
      '/agents/planner/tools?source=bookmark',
    );
    window.dispatchEvent(new PopStateEvent('popstate'));

    const { result } = renderHook(() => useUrlSelection('/agents'), {
      wrapper,
    });

    // Selection sees the canonical slug, not 'planner/tools' …
    expect(result.current.selectedId).toBe('planner');
    // … because ingestion rewrote the browser URL itself, keeping the query.
    expect(window.location.pathname).toBe('/agents/planner');
    expect(window.location.search).toBe('?source=bookmark');
  });
});
