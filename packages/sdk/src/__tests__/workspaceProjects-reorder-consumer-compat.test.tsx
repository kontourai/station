/**
 * @vitest-environment jsdom
 *
 * Public TypeScript compatibility for `useReorderProjectsMutation` (#481).
 *
 * Root proved the regression with a representative legacy consumer: hook-level
 * and per-call `onSuccess` callbacks typed `(_data: unknown, order: string[])`
 * compiled against the parent query worktree with 0 diagnostics but produced
 * 2 TS2322 errors once the variables widened to
 * `string[] | ReorderProjectsInput`. Widening the options alone can never
 * accept those callbacks (contravariance), so the hook exposes sound
 * overloads instead: legacy callbacks select a handle narrowed to bare
 * arrays, scoped callbacks select an object handle, and the no-options
 * handle keeps both shapes with per-call callbacks tied to their own call's
 * variables.
 *
 * Every typed callback below is a compile-time fixture enforced by
 * `typecheck:sdk`. The two `rejected` thunks are never invoked — the
 * expression inside each must NOT compile without its `@ts-expect-error`
 * pin, so a regression that stops rejecting fails the typecheck lane.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { reorderProjectsMock } = vi.hoisted(() => ({
  reorderProjectsMock: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

vi.mock('../client/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../client/projects')>()),
  reorderProjects: (...args: unknown[]) => reorderProjectsMock(...args),
}));

import type {
  ReorderProjectsInput,
  ReorderProjectsVariables,
} from '../query-domains/workspaceProjects';
import { useReorderProjectsMutation } from '../query-domains/workspaceProjects';

const scope = { apiBase: 'http://station.test', authorityKey: 'home-a:gen-1' };

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useReorderProjectsMutation consumer compatibility (#481)', () => {
  test('legacy bare-array callbacks compile at hook and per-call level', async () => {
    reorderProjectsMock.mockResolvedValueOnce([]);
    const seen: string[][] = [];
    const client = freshClient();
    const { result } = renderHook(
      () =>
        useReorderProjectsMutation({
          onSuccess: (_data: unknown, order: string[]) => {
            seen.push(order);
          },
          onError: (error: Error, order: string[]) => {
            void error;
            void order;
          },
        }),
      { wrapper: wrapperFor(client) },
    );

    act(() => {
      result.current.mutate(['a', 'b'], {
        onSuccess: (_data: unknown, order: string[]) => {
          seen.push(order);
        },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Hook-level and per-call callbacks both observe the bare array.
    expect(seen).toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ]);
    // The legacy call keeps the ambient path.
    expect(reorderProjectsMock).toHaveBeenCalledWith('http://example.test', [
      'a',
      'b',
    ]);
    reorderProjectsMock.mockResolvedValueOnce([]);
    await expect(result.current.mutateAsync(['a'])).resolves.toEqual([]);
  });

  test('scoped object callbacks keep the captured authority', async () => {
    reorderProjectsMock.mockResolvedValueOnce([]);
    const seen: ReorderProjectsInput[] = [];
    const client = freshClient();
    const { result } = renderHook(
      () =>
        useReorderProjectsMutation({
          onSuccess: (_data: unknown, input: ReorderProjectsInput) => {
            seen.push(input);
          },
        }),
      { wrapper: wrapperFor(client) },
    );

    act(() => {
      result.current.mutate(
        { order: ['a'], requestScope: scope, requireRequestScope: true },
        {
          onSuccess: (_data: unknown, input: ReorderProjectsInput) => {
            seen.push(input);
          },
        },
      );
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(reorderProjectsMock).toHaveBeenCalledWith(scope.apiBase, ['a'], {
      requestScope: scope,
    });
    expect(
      seen.every(
        (input) => input.requestScope?.authorityKey === scope.authorityKey,
      ),
    ).toBe(true);
  });

  test('no-options handle accepts both shapes with tied per-call callbacks', async () => {
    reorderProjectsMock.mockResolvedValue([]);
    const client = freshClient();
    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current.mutate(['a'], {
        onSuccess: (_data: unknown, order: string[]) => {
          expect(order).toEqual(['a']);
        },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => {
      result.current.mutate(
        { order: ['b'], requestScope: scope },
        {
          onError: (error: Error, input: ReorderProjectsInput) => {
            void error;
            void input;
          },
        },
      );
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // A union-typed per-call callback also stays available.
    act(() => {
      result.current.mutate(['c'], {
        onSuccess: (_data: unknown, variables: ReorderProjectsVariables) => {
          expect(variables).toEqual(['c']);
        },
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  test('narrowed handles expose their declared variables shape', () => {
    const { result: legacy } = renderHook(
      () =>
        useReorderProjectsMutation({
          onSuccess: (_data: unknown, order: string[]) => {
            void order;
          },
        }),
      { wrapper: wrapperFor(freshClient()) },
    );
    expectTypeOf(legacy.current.mutate).parameter(0).toEqualTypeOf<string[]>();
    expectTypeOf(legacy.current.mutateAsync)
      .parameter(0)
      .toEqualTypeOf<string[]>();

    const { result: scoped } = renderHook(
      () =>
        useReorderProjectsMutation({
          onSuccess: (_data: unknown, input: ReorderProjectsInput) => {
            void input;
          },
        }),
      { wrapper: wrapperFor(freshClient()) },
    );
    expectTypeOf(scoped.current.mutate)
      .parameter(0)
      .toEqualTypeOf<ReorderProjectsInput>();
  });

  test('legacy-bound handle rejects scoped variables (compile-time pin)', () => {
    const { result } = renderHook(
      () =>
        useReorderProjectsMutation({
          onSuccess: (_data: unknown, order: string[]) => {
            void order;
          },
        }),
      { wrapper: wrapperFor(freshClient()) },
    );
    // Never invoked: without the pin this expression must not compile.
    const rejected = () => {
      // @ts-expect-error - scoped variables cannot reach a legacy callback
      result.current.mutate({ order: ['a'], requestScope: scope });
    };
    expect(rejected).toBeTypeOf('function');
  });

  test('per-call callbacks must match their own call (compile-time pin)', () => {
    const { result } = renderHook(() => useReorderProjectsMutation(), {
      wrapper: wrapperFor(freshClient()),
    });
    // Never invoked: without the pin this expression must not compile.
    const rejected = () => {
      // @ts-expect-error - per-call callbacks must match their call's variables
      result.current.mutate(['a'], {
        onSuccess: (_data: unknown, input: ReorderProjectsInput) => {
          void input;
        },
      });
    };
    expect(rejected).toBeTypeOf('function');
  });
});
