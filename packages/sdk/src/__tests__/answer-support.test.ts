import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reactQueryMocks = vi.hoisted(() => ({
  cache: [] as Array<(string | number)[]>,
  cancelQueries: vi.fn(),
  invalidateQueries: vi.fn(),
  removeQueries: vi.fn(),
  useMutation: vi.fn((options) => options),
  useQuery: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  hashKey: vi.fn(() => 'answer-support-test-query'),
  useMutation: reactQueryMocks.useMutation,
  useQuery: reactQueryMocks.useQuery,
  useQueryClient: vi.fn(() => ({
    cancelQueries: reactQueryMocks.cancelQueries,
    getQueryDefaults: vi.fn(() => ({})),
    invalidateQueries: reactQueryMocks.invalidateQueries,
    removeQueries: reactQueryMocks.removeQueries,
  })),
}));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => effect(),
}));

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import {
  useAnswerSupportBundlesQuery,
  useAnswerSupportCardsQuery,
  useAnswerSupportClaimsQuery,
  useCreateAnswerSupportMutation,
  useRemoveAnswerSupportMutation,
  useReplaceAnswerSupportMutation,
} from '../answer-support.js';
import { AnswerSupportRequestError } from '../client/answer-support.js';

describe('answer support SDK query boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reactQueryMocks.cache.length = 0;
    reactQueryMocks.removeQueries.mockImplementation(({ queryKey }) => {
      reactQueryMocks.cache = reactQueryMocks.cache.filter(
        (candidate) =>
          !queryKey.every((part: unknown, index: number) =>
            Object.is(candidate[index], part),
          ),
      );
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('withholds and evicts cached selections after reauthorization fails', () => {
    reactQueryMocks.cache.push(
      ['task-turn-references', 'task-a'],
      ['answer-support', 'task-a', 'reference-a', 'bundles'],
      [
        'answer-support',
        'task-a',
        'reference-a',
        'bundles',
        'sb1.old',
        'claims',
      ],
    );
    reactQueryMocks.useQuery.mockReturnValue({
      data: [{ id: 'sb1.old' }],
      error: new Error('Answer support unavailable'),
      fetchStatus: 'idle',
      isFetchedAfterMount: true,
      isFetching: false,
      isLoading: false,
      status: 'error',
    });

    const result = useAnswerSupportBundlesQuery('task-a', 'reference-a');

    expect(result.data).toBeUndefined();
    expect(result.isLoading).toBe(false);
    expect(reactQueryMocks.cache).toEqual([]);
    expect(reactQueryMocks.removeQueries).toHaveBeenCalledWith({
      exact: true,
      queryKey: ['task-turn-references', 'task-a'],
    });
    expect(reactQueryMocks.removeQueries).toHaveBeenCalledWith({
      queryKey: ['answer-support', 'task-a'],
    });
  });

  it.each([
    ['cards', () => useAnswerSupportCardsQuery('task-a')],
    ['bundles', () => useAnswerSupportBundlesQuery('task-a', 'reference-a')],
    [
      'claims',
      () => useAnswerSupportClaimsQuery('task-a', 'reference-a', 'sb1.a'),
    ],
  ])(
    'fails closed across sibling protected caches after %s authority failure',
    (_kind, invoke) => {
      reactQueryMocks.cache.push(
        ['task-turn-references', 'task-a'],
        ['answer-support', 'task-a', 'reference-a', 'bundles'],
        [
          'answer-support',
          'task-a',
          'reference-a',
          'bundles',
          'sb1.a',
          'claims',
        ],
        [
          'answer-support',
          'task-a',
          'reference-a',
          'bundles',
          'sb1.b',
          'claims',
        ],
      );
      reactQueryMocks.useQuery.mockReturnValue({
        data: [{ id: 'protected-id' }],
        error: new Error('Answer support unavailable'),
        isFetchedAfterMount: true,
        isFetching: false,
        isLoading: false,
        status: 'error',
      });

      const result = invoke();

      expect(result.data).toBeUndefined();
      expect(reactQueryMocks.cache).toEqual([]);
      expect(reactQueryMocks.removeQueries).toHaveBeenCalledWith({
        exact: true,
        queryKey: ['task-turn-references', 'task-a'],
      });
      expect(reactQueryMocks.removeQueries).toHaveBeenCalledWith({
        queryKey: ['answer-support', 'task-a'],
      });
    },
  );

  it.each([
    ['cards', () => useAnswerSupportCardsQuery('task-a')],
    ['bundles', () => useAnswerSupportBundlesQuery('task-a', 'reference-a')],
    [
      'claims',
      () => useAnswerSupportClaimsQuery('task-a', 'reference-a', 'sb1.a'),
    ],
  ])(
    'synchronously revokes sibling cache entries when %s transport loses authority',
    async (_kind, invoke) => {
      reactQueryMocks.cache.push(
        ['task-turn-references', 'task-a'],
        ['answer-support', 'task-a', 'reference-a', 'bundles'],
        [
          'answer-support',
          'task-a',
          'reference-a',
          'bundles',
          'sb1.a',
          'claims',
        ],
      );
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              success: false,
              error: 'Answer support unavailable',
            }),
            { status: 404 },
          ),
        ),
      );
      reactQueryMocks.useQuery.mockReturnValue({
        data: [{ id: 'protected-id' }],
        isFetchedAfterMount: true,
        isFetching: false,
        isLoading: false,
        status: 'success',
      });

      invoke();
      const options = reactQueryMocks.useQuery.mock.calls[
        reactQueryMocks.useQuery.mock.calls.length - 1
      ]?.[0] as {
        queryFn: (input: { signal: AbortSignal }) => Promise<unknown>;
      };
      await expect(
        options.queryFn({ signal: new AbortController().signal }),
      ).rejects.toThrow('Answer support unavailable');

      expect(reactQueryMocks.cache).toEqual([]);
    },
  );

  it('invalidates cards and task-wide selections after attach', async () => {
    const mutation = useCreateAnswerSupportMutation() as {
      onSuccess?: (
        data: unknown,
        variables: { taskId: string; referenceId: string },
      ) => void | Promise<void>;
    };

    await mutation.onSuccess?.(
      {},
      { taskId: 'task-a', referenceId: 'reference-a' },
    );

    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(1, {
      queryKey: ['task-turn-references', 'task-a'],
    });
    expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(2, {
      queryKey: ['answer-support', 'task-a'],
    });
  });

  it('revokes protected sibling caches when a mutation loses answer authority', () => {
    reactQueryMocks.cache.push(
      ['task-turn-references', 'task-a'],
      ['answer-support', 'task-a', 'reference-a', 'bundles'],
      ['answer-support', 'task-a', 'reference-a', 'bundles', 'sb1.a', 'claims'],
    );
    const mutation = useCreateAnswerSupportMutation() as {
      onError?: (
        error: Error,
        variables: { taskId: string; referenceId: string },
      ) => void;
    };

    mutation.onError?.(
      new AnswerSupportRequestError('Answer support unavailable', 503),
      { taskId: 'task-a', referenceId: 'reference-a' },
    );

    expect(reactQueryMocks.cache).toEqual([]);
  });

  it.each([
    ['attach', useCreateAnswerSupportMutation],
    ['replace', useReplaceAnswerSupportMutation],
    ['remove', useRemoveAnswerSupportMutation],
  ])(
    'refreshes every Task support selector after a %s compare-and-swap conflict',
    (_action, useMutationHook) => {
      const mutation = useMutationHook() as {
        onError?: (
          error: Error,
          variables: { taskId: string; referenceId: string },
        ) => void;
      };

      mutation.onError?.(
        new AnswerSupportRequestError('Answer support conflicts', 409),
        { taskId: 'task-a', referenceId: 'reference-a' },
      );

      expect(reactQueryMocks.removeQueries).not.toHaveBeenCalled();
      expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(1, {
        queryKey: ['task-turn-references', 'task-a'],
      });
      expect(reactQueryMocks.invalidateQueries).toHaveBeenNthCalledWith(2, {
        queryKey: ['answer-support', 'task-a'],
      });
    },
  );
});
