/** @vitest-environment jsdom */

/**
 * The dock panel's `memo()` wrap compares the accent and icon maps by
 * reference. `useProjects` folds a pending read to a fresh `[]` on every
 * render, so a map rebuilt per render would re-render every inbox row on
 * every dock render. These probes re-render while the list is a fresh array
 * each time and require the same map object back.
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { useProjectAccents } from '../useProjectAccents';
import { useProjectIcons } from '../useProjectIcons';

/** Called on every `useProjects()` read, so each render gets a new array. */
let readProjects: () => ProjectMetadata[] = () => [];

vi.mock('../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: readProjects(),
    isLoading: false,
    isConfirmedLoaded: true,
  }),
}));

function project(slug: string, icon?: string): ProjectMetadata {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    layoutCount: 0,
    hasKnowledge: false,
    ...(icon ? { icon } : {}),
  } as ProjectMetadata;
}

beforeEach(() => {
  readProjects = () => [];
});

describe('useProjectAccents keeps one map while the slug set is unchanged', () => {
  test('a pending list (a fresh [] each render) returns the same map', () => {
    const { result, rerender } = renderHook(() => useProjectAccents());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  test('a fresh array of the same slugs, even reordered, returns the same map; a new slug does not', () => {
    readProjects = () => [project('alpha'), project('beta')];
    const { result, rerender } = renderHook(() => useProjectAccents());
    const first = result.current;
    expect(first.size).toBe(2);
    readProjects = () => [project('beta'), project('alpha')];
    rerender();
    expect(result.current).toBe(first);
    // The probe can tell maps apart: a changed set is a new allocation.
    readProjects = () => [project('alpha'), project('beta'), project('gamma')];
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.size).toBe(3);
  });
});

describe('useProjectIcons keeps one map while the list is pending', () => {
  test('a pending list (a fresh [] each render) returns the same empty map', () => {
    const { result, rerender } = renderHook(() => useProjectIcons());
    const first = result.current;
    expect(first.size).toBe(0);
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  test('a list with no drawable icon is the same shared empty map too', () => {
    // A fresh array each render, with a legacy link icon the rule refuses.
    readProjects = () => [project('alpha', 'https://example.com/logo.png')];
    const { result, rerender } = renderHook(() => useProjectIcons());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.size).toBe(0);
  });

  test('a stable list keeps its map, and the map carries the drawable icon', () => {
    const list = [project('alpha', '🧭'), project('beta')];
    readProjects = () => list;
    const { result, rerender } = renderHook(() => useProjectIcons());
    const first = result.current;
    expect([...first]).toEqual([['alpha', '🧭']]);
    rerender();
    expect(result.current).toBe(first);
  });
});
