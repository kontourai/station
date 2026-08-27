import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
import {
  type ResolveHomeSurfaceInput,
  resolveHomeSurface,
} from '../app-shell/resolve-home-surface';

/** Baseline input; each test overrides only the fields it cares about. */
function makeInput(
  overrides: Partial<ResolveHomeSurfaceInput> = {},
): ResolveHomeSurfaceInput {
  return {
    connectionStatus: 'connected',
    connectionFailureReason: null,
    projectsLoading: false,
    projectsError: false,
    projects: [],
    lastProject: null,
    lastProjectLayout: null,
    firstProjectSlug: '',
    firstProjectLayoutsLoading: false,
    firstProjectLayoutsError: false,
    firstProjectLayouts: [],
    ...overrides,
  };
}

describe('resolveHomeSurface', () => {
  test('pending while the projects list itself is loading, regardless of other fields', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projectsLoading: true,
          lastProject: 'alpha',
          lastProjectLayout: 'coding',
          firstProjectSlug: 'alpha',
          firstProjectLayouts: [{ slug: 'coding' }],
        }),
      ),
    ).toEqual({ status: 'pending' });

    expect(resolveHomeSurface(makeInput({ projectsLoading: true }))).toEqual({
      status: 'pending',
    });
  });

  test('error when projects fail to load, never empty', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projectsError: true,
          projects: [],
          firstProjectSlug: '',
        }),
      ),
    ).toEqual({ status: 'error', source: 'projects' });
  });

  // station#3711: the state is named for what is derived — the host is not
  // available to this app — and carries the connection layer's typed reason so
  // the renderer can say WHY instead of collapsing an auth rejection or a
  // version mismatch into a false "offline" claim.
  test('projects failure is a host-unavailable consequence until the connection is healthy', () => {
    expect(
      resolveHomeSurface(
        makeInput({ connectionStatus: 'error', projectsError: true }),
      ),
    ).toEqual({ status: 'host-unavailable', reason: null });
    expect(
      resolveHomeSurface(
        makeInput({
          connectionStatus: 'error',
          connectionFailureReason: 'authentication-failed',
          projectsError: true,
        }),
      ),
    ).toEqual({ status: 'host-unavailable', reason: 'authentication-failed' });
    expect(
      resolveHomeSurface(
        makeInput({ connectionStatus: 'connected', projectsError: true }),
      ),
    ).toEqual({ status: 'error', source: 'projects' });
  });

  // The reason rides along only when the connection is the story: a query
  // failure on a CONNECTED host is an independent data error and must not
  // borrow connection copy.
  test('a stale failure reason does not leak into a connected data error', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          connectionStatus: 'connected',
          connectionFailureReason: 'unreachable',
          projectsError: true,
        }),
      ),
    ).toEqual({ status: 'error', source: 'projects' });
  });

  test('projects error wins when projects and first-project layouts both fail', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projectsError: true,
          projects: [{ slug: 'alpha' }],
          firstProjectSlug: 'alpha',
          firstProjectLayoutsError: true,
        }),
      ),
    ).toEqual({ status: 'error', source: 'projects' });
  });

  test('priority 1: resolves to the persisted project+layout when it still exists', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [{ slug: 'alpha' }, { slug: 'beta' }],
          lastProject: 'alpha',
          lastProjectLayout: 'coding',
          firstProjectSlug: 'alpha',
          // Deliberately still loading/empty — priority 1 must not need this
          // data at all once it matches.
          firstProjectLayoutsLoading: true,
          firstProjectLayouts: [],
        }),
      ),
    ).toEqual({
      status: 'resolved',
      target: { type: 'layout', projectSlug: 'alpha', layoutSlug: 'coding' },
    });
  });

  test('priority 1 does not apply when lastProjectLayout is missing (falls through to priority 2)', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [{ slug: 'alpha' }],
          lastProject: 'alpha',
          lastProjectLayout: null,
          firstProjectSlug: 'alpha',
          firstProjectLayouts: [{ slug: 'coding' }],
        }),
      ),
    ).toEqual({
      status: 'resolved',
      target: { type: 'layout', projectSlug: 'alpha', layoutSlug: 'coding' },
    });
  });

  test('priority 2 pending: first project exists but its layouts are still loading (no lastProject set)', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [{ slug: 'alpha' }],
          firstProjectSlug: 'alpha',
          firstProjectLayoutsLoading: true,
        }),
      ),
    ).toEqual({ status: 'pending' });
  });

  test('priority 2 error: first project exists but its layouts fail to load', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [{ slug: 'alpha' }],
          firstProjectSlug: 'alpha',
          firstProjectLayoutsError: true,
        }),
      ),
    ).toEqual({ status: 'error', source: 'first-project-layouts' });
  });

  test('first-project layouts failure is a host-unavailable consequence until the connection is healthy', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          connectionStatus: 'error',
          connectionFailureReason: 'unsupported-capability-version',
          projects: [{ slug: 'alpha' }],
          firstProjectSlug: 'alpha',
          firstProjectLayoutsError: true,
        }),
      ),
    ).toEqual({
      status: 'host-unavailable',
      reason: 'unsupported-capability-version',
    });
  });

  test('priority 2: resolves to the first project`s first layout once layouts load', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [{ slug: 'alpha' }],
          firstProjectSlug: 'alpha',
          firstProjectLayouts: [{ slug: 'coding' }, { slug: 'notes' }],
        }),
      ),
    ).toEqual({
      status: 'resolved',
      target: { type: 'layout', projectSlug: 'alpha', layoutSlug: 'coding' },
    });
  });

  test('priority 2 fallback: resolves to the first project itself when it has zero layouts', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [{ slug: 'alpha' }],
          firstProjectSlug: 'alpha',
          firstProjectLayouts: [],
        }),
      ),
    ).toEqual({
      status: 'resolved',
      target: { type: 'project', slug: 'alpha' },
    });
  });

  test('priority 3: empty once projects have loaded and there are none', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [],
          firstProjectSlug: '',
        }),
      ),
    ).toEqual({ status: 'empty' });
  });

  test('empty is unaffected by a stale lastProject with no other projects present', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [],
          lastProject: 'deleted-project',
          lastProjectLayout: 'coding',
          firstProjectSlug: '',
        }),
      ),
    ).toEqual({ status: 'empty' });
  });

  // --- Stop-short scenarios named explicitly in the plan -------------------

  test('stale/deleted lastProject + pending first-project layouts: pending, never a stale resolve or empty', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [{ slug: 'other-project' }],
          lastProject: 'deleted-project',
          lastProjectLayout: 'coding',
          firstProjectSlug: 'other-project',
          firstProjectLayoutsLoading: true,
          firstProjectLayouts: [],
        }),
      ),
    ).toEqual({ status: 'pending' });
  });

  test('stale/deleted lastProject falls through 1 -> 2 to the first real project`s first layout, never the stale slug', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [{ slug: 'other-project' }],
          lastProject: 'deleted-project',
          lastProjectLayout: 'coding',
          firstProjectSlug: 'other-project',
          firstProjectLayoutsLoading: false,
          firstProjectLayouts: [{ slug: 'main' }],
        }),
      ),
    ).toEqual({
      status: 'resolved',
      target: {
        type: 'layout',
        projectSlug: 'other-project',
        layoutSlug: 'main',
      },
    });
  });

  test('stale/deleted lastProject with no other projects falls through 1 -> 2 -> 3 to empty', () => {
    expect(
      resolveHomeSurface(
        makeInput({
          projects: [],
          lastProject: 'deleted-project',
          lastProjectLayout: 'coding',
          firstProjectSlug: '',
          firstProjectLayoutsLoading: false,
          firstProjectLayouts: [],
        }),
      ),
    ).toEqual({ status: 'empty' });
  });

  test('resolver cache-key coverage: seeded react-query projects/layouts keys provide resolver inputs', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      ['projects'],
      [{ id: 'p1', slug: 'dev', name: 'Dev' }],
    );
    queryClient.setQueryData(
      ['projects', 'dev', 'layouts'],
      [{ id: 'l1', slug: 'code', name: 'Code', type: 'coding' }],
    );

    const projects =
      queryClient.getQueryData<{ slug: string }[]>(['projects']) ?? [];
    const firstProjectSlug = projects[0]?.slug ?? '';
    const firstProjectLayouts =
      queryClient.getQueryData<{ slug: string }[]>([
        'projects',
        firstProjectSlug,
        'layouts',
      ]) ?? [];

    expect(
      resolveHomeSurface(
        makeInput({
          projects,
          // This proves the resolver consumes data shaped from the same
          // react-query keys App.tsx reads. It is not an App.tsx stale-frame
          // regression proof by itself because the pure resolver has no render
          // frame or local currentView state.
          lastProject: 'deleted-project',
          lastProjectLayout: 'deleted-layout',
          firstProjectSlug,
          firstProjectLayouts,
        }),
      ),
    ).toEqual({
      status: 'resolved',
      target: { type: 'layout', projectSlug: 'dev', layoutSlug: 'code' },
    });
  });
});
