/**
 * @vitest-environment jsdom
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// station#4525 review HIGH-1: `useProjects()`'s `isConfirmedLoaded` is the
// ONE place this derivation lives — every consumer (useDockShellChrome's
// deletion-cleanup effect, and any future one) reads it rather than
// re-deriving `isLoading`/`isSuccess`/`isError` algebra per call site. This
// file is what actually proves the derivation formula itself is correct;
// every other test in the suite mocks `useProjects()` wholesale and so
// cannot catch a regression INSIDE this function.
let projectsQueryState: {
  data: unknown;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  isPlaceholderData?: boolean;
};

vi.mock('@kontourai/station-sdk', () => ({
  useProjectsQuery: () => projectsQueryState,
  useProjectQuery: () => ({ data: undefined, isLoading: false }),
}));

describe('useProjects().isConfirmedLoaded (station#4525 review HIGH-1)', () => {
  test('the pending shape (query not yet settled) is never confirmed loaded', async () => {
    projectsQueryState = {
      data: undefined,
      isLoading: true,
      isSuccess: false,
      isError: false,
    };
    const { useProjects } = await import('../contexts/ProjectsContext');
    const { result } = renderHook(() => useProjects());
    expect(result.current.projects).toEqual([]);
    expect(result.current.isConfirmedLoaded).toBe(false);
  });

  // The exact HIGH-1 discriminating case: `isLoading: false` (settled) but
  // via an ERROR, not a success — `data` is folded to `[]`, identical to a
  // genuine empty/confirmed list. A guard reading only `!isLoading` cannot
  // tell these apart; `isConfirmedLoaded` must.
  test('the error shape (settled, but errored) is never confirmed loaded, even though projects reads empty', async () => {
    projectsQueryState = {
      data: undefined,
      isLoading: false,
      isSuccess: false,
      isError: true,
    };
    const { useProjects } = await import('../contexts/ProjectsContext');
    const { result } = renderHook(() => useProjects());
    expect(result.current.projects).toEqual([]);
    expect(
      result.current.isConfirmedLoaded,
      'an errored query must never read as confirmed',
    ).toBe(false);
  });

  // Delta review LOW-B: placeholderData forces status to "success" while the
  // real fetch is still pending — placeholder contents must never read as a
  // confirmed load. Latent today (no caller opts into keepPreviousData on the
  // projects query); this pins the derivation against a future opt-in.
  test('the placeholder shape (success status, placeholder contents) is never confirmed loaded', async () => {
    projectsQueryState = {
      data: [],
      isLoading: false,
      isSuccess: true,
      isError: false,
      isPlaceholderData: true,
    };
    const { useProjects } = await import('../contexts/ProjectsContext');
    const { result } = renderHook(() => useProjects());
    expect(
      result.current.isConfirmedLoaded,
      'placeholder data must never read as confirmed',
    ).toBe(false);
  });

  test('a successful load with real data (including a genuinely empty list) IS confirmed loaded', async () => {
    projectsQueryState = {
      data: [],
      isLoading: false,
      isSuccess: true,
      isError: false,
    };
    const { useProjects } = await import('../contexts/ProjectsContext');
    const { result } = renderHook(() => useProjects());
    expect(result.current.projects).toEqual([]);
    expect(result.current.isConfirmedLoaded).toBe(true);
  });

  test('a successful load with projects passes them through and confirms loaded', async () => {
    const projects = [
      {
        id: 'p1',
        slug: 'alpha',
        name: 'Alpha',
        hasWorkingDirectory: false,
        layoutCount: 0,
        hasKnowledge: false,
      },
    ];
    projectsQueryState = {
      data: projects,
      isLoading: false,
      isSuccess: true,
      isError: false,
    };
    const { useProjects } = await import('../contexts/ProjectsContext');
    const { result } = renderHook(() => useProjects());
    expect(result.current.projects).toEqual(projects);
    expect(result.current.isConfirmedLoaded).toBe(true);
  });
});
