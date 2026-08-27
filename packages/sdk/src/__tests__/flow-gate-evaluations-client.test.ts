// @vitest-environment jsdom

import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  FlowGateEvaluationRequestError,
  getProjectFlowGateEvaluation,
  getTaskFlowGateEvaluations,
} from '../client/flow-gate-evaluations';
import { setClientCredentialResolver } from '../client/http';
import {
  flowGateEvaluationQueries,
  useAttachTaskFlowGateEvaluationMutation,
  useProjectFlowGateEvaluationQuery,
  useTaskFlowGateEvaluationsQuery,
} from '../flow-gate-evaluations';
import { taskBasisQueries } from '../task-basis';

const scope = { apiBase: 'http://station.test', authorityKey: 'authority-a' };
const nextScope = {
  apiBase: 'http://station.test',
  authorityKey: 'authority-b',
};
beforeEach(() => {
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: { ...scope, isCurrent: () => true },
  }));
});
afterEach(() => {
  onlineManager.setOnline(true);
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
const evaluation = {
  ref: {
    runId: 'run-a',
    gateId: 'gate-a',
    evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  },
  evaluatedAt: '2026-08-26T00:00:00.000Z',
  originalVerdict: 'block',
  kind: 'initial',
  trigger: 'ordinary',
  currentStanding: 'current',
  currentRun: { status: 'active', currentStep: null },
  selectedEvidence: [],
  validityAsOf: '2026-08-26T00:00:00.000Z',
  validityScope: 'retained-immutable-bundle',
  externalRevocation: 'not-observed',
};
test('accepts only a closed owner Flow projection and opaque availability sentinel', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            { referenceId: 'link-a', kept: true, evaluation },
            { state: 'unavailable' },
          ],
        }),
      ),
    ),
  );
  await expect(
    getTaskFlowGateEvaluations('http://station.test', 'task-a'),
  ).resolves.toEqual([
    { referenceId: 'link-a', kept: true, evaluation },
    { state: 'unavailable' },
  ]);
});
test('rejects tuple substitution and extra owner data without exposing it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              referenceId: 'link-a',
              kept: true,
              evaluation: { ...evaluation, privatePath: '/secret' },
            },
          ],
        }),
      ),
    ),
  );
  await expect(
    getTaskFlowGateEvaluations('http://station.test', 'task-a'),
  ).rejects.toBeInstanceOf(FlowGateEvaluationRequestError);
});

test('reads one project Flow receipt only through the exact public tuple', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(response({ success: true, data: evaluation }));
  vi.stubGlobal('fetch', fetch);
  await expect(
    getProjectFlowGateEvaluation(
      'http://station.test',
      'project-a',
      evaluation.ref,
    ),
  ).resolves.toEqual(evaluation);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining(
      '/api/projects/project-a/flow/runs/run-a/gates/gate-a/evaluations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
    expect.anything(),
  );
});

test('refuses a project receipt whose returned tuple differs from the captured request', async () => {
  const requested = { ...evaluation.ref };
  let release!: (value: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const pending = getProjectFlowGateEvaluation(
    'http://station.test',
    'project-a',
    requested,
  );
  requested.runId = 'mutated-run';
  requested.gateId = 'mutated-gate';
  requested.evaluationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release(
    response({
      success: true,
      data: {
        ...evaluation,
        ref: {
          runId: 'wrong-run',
          gateId: 'wrong-gate',
          evaluationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      },
    }),
  );
  await expect(pending).rejects.toBeInstanceOf(FlowGateEvaluationRequestError);
  expect(fetch.mock.calls[0]?.[0]).toContain('/runs/run-a/gates/gate-a/');
});

test.each([
  ['runId', 'run-b'],
  ['gateId', 'gate-b'],
  ['evaluationId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
] as const)(
  'refuses a project receipt with a substituted %s',
  async (field, value) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response({
          success: true,
          data: { ...evaluation, ref: { ...evaluation.ref, [field]: value } },
        }),
      ),
    );
    await expect(
      getProjectFlowGateEvaluation(
        'http://station.test',
        'project-a',
        evaluation.ref,
      ),
    ).rejects.toBeInstanceOf(FlowGateEvaluationRequestError);
  },
);

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function available(id = 'link-a') {
  return { success: true, data: [{ referenceId: id, kept: true, evaluation }] };
}
function attached() {
  return { success: true, data: { id: 'link-a' } };
}
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

test('mounted Flow receipt observers tombstone a 403 without retaining prior data or loading forever', async () => {
  const { client, wrapper } = harness();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response(available()))
    .mockResolvedValueOnce(response({ success: false }, 403));
  vi.stubGlobal('fetch', fetch);
  const observer = renderHook(
    () => useTaskFlowGateEvaluationsQuery('task-a', { requestScope: scope }),
    { wrapper },
  );
  await waitFor(() => expect(observer.result.current.data).toHaveLength(1));
  client.setQueryData(taskBasisQueries.task('task-a', undefined, scope), {
    private: 'basis-canary',
  });
  await act(async () => {
    await observer.result.current.refetch();
  });
  await waitFor(() => {
    expect(observer.result.current.data).toBeUndefined();
    expect(observer.result.current.error).toBeInstanceOf(
      FlowGateEvaluationRequestError,
    );
    expect(observer.result.current.isLoading).toBe(false);
  });
  expect(
    client.getQueryData(
      flowGateEvaluationQueries.retained('task-a', scope).queryKey,
    ),
  ).toBeInstanceOf(FlowGateEvaluationRequestError);
  expect(
    client.getQueryData(taskBasisQueries.task('task-a', undefined, scope)),
  ).toBeNull();
  observer.unmount();
  client.clear();
});

test('a refused project inspection exposes no previous receipt', async () => {
  const { client, wrapper } = harness();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(response({ success: false }, 403)),
  );
  const observer = renderHook(
    () =>
      useProjectFlowGateEvaluationQuery('project-a', evaluation.ref, {
        requestScope: scope,
      }),
    { wrapper },
  );
  await waitFor(() => {
    expect(observer.result.current.error).toBeInstanceOf(
      FlowGateEvaluationRequestError,
    );
    expect(observer.result.current.data).toBeUndefined();
    expect(observer.result.current.isLoading).toBe(false);
  });
  expect(
    client.getQueryData(
      flowGateEvaluationQueries.inspect('project-a', evaluation.ref, scope)
        .queryKey,
    ),
  ).toBeInstanceOf(FlowGateEvaluationRequestError);
  observer.unmount();
  client.clear();
});

test('a populated project inspection replaces its cached receipt with a refusal tombstone', async () => {
  const { client, wrapper } = harness();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response({ success: true, data: evaluation }))
    .mockResolvedValueOnce(response({ success: false }, 403));
  vi.stubGlobal('fetch', fetch);
  const observer = renderHook(
    () =>
      useProjectFlowGateEvaluationQuery('project-a', evaluation.ref, {
        requestScope: scope,
      }),
    { wrapper },
  );
  await waitFor(() => expect(observer.result.current.data).toEqual(evaluation));
  await act(async () => {
    await observer.result.current.refetch();
  });
  await waitFor(() => {
    expect(observer.result.current.data).toBeUndefined();
    expect(observer.result.current.error).toBeInstanceOf(
      FlowGateEvaluationRequestError,
    );
    expect(observer.result.current.isLoading).toBe(false);
  });
  expect(
    client.getQueryData(
      flowGateEvaluationQueries.inspect('project-a', evaluation.ref, scope)
        .queryKey,
    ),
  ).toBeInstanceOf(FlowGateEvaluationRequestError);
  observer.unmount();
  client.clear();
});

test('a refused attach fences mounted retained and Basis reads for only its captured authority', async () => {
  const { client, wrapper } = harness();
  let releaseRetained!: (value: Response) => void;
  let releaseBasis!: (value: unknown) => void;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith('/references'))
      return Promise.resolve(response({ success: false }, 403));
    if (url.endsWith('/gate-evaluation-references'))
      return new Promise((resolve) => {
        releaseRetained = resolve;
      });
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  const basisKey = taskBasisQueries.task('task-a', undefined, scope);
  const basisRead = client
    .fetchQuery({
      queryKey: basisKey,
      queryFn: () =>
        new Promise((resolve) => {
          releaseBasis = resolve;
        }),
    })
    .catch(() => undefined);
  client.setQueryData(
    flowGateEvaluationQueries.retained('task-a', nextScope).queryKey,
    ['other-authority'],
  );
  client.setQueryData(taskBasisQueries.task('task-a', undefined, nextScope), {
    authority: 'other',
  });
  const mounted = renderHook(
    () => ({
      read: useTaskFlowGateEvaluationsQuery('task-a', { requestScope: scope }),
      attach: useAttachTaskFlowGateEvaluationMutation({ requestScope: scope }),
    }),
    { wrapper },
  );
  await waitFor(() => expect(releaseRetained).toBeTypeOf('function'));
  await waitFor(() => expect(releaseBasis).toBeTypeOf('function'));

  await expect(
    mounted.result.current.attach.mutateAsync({
      taskId: 'task-a',
      ref: evaluation.ref,
    }),
  ).rejects.toBeInstanceOf(FlowGateEvaluationRequestError);

  await waitFor(() => {
    expect(mounted.result.current.read.status).toBe('error');
    expect(mounted.result.current.read.data).toBeUndefined();
    expect(mounted.result.current.read.isLoading).toBe(false);
    expect(mounted.result.current.read.isFetching).toBe(false);
  });
  await act(async () => {
    releaseRetained(response(available()));
    releaseBasis({ private: 'basis-canary' });
  });
  await basisRead;
  await waitFor(() =>
    expect(mounted.result.current.read.isFetching).toBe(false),
  );
  expect(mounted.result.current.read.status).toBe('error');
  expect(mounted.result.current.read.data).toBeUndefined();
  expect(client.getQueryData(basisKey)).toBeNull();
  expect(
    client.getQueryData(
      flowGateEvaluationQueries.retained('task-a', nextScope).queryKey,
    ),
  ).toEqual(['other-authority']);
  expect(
    client.getQueryData(taskBasisQueries.task('task-a', undefined, nextScope)),
  ).toEqual({ authority: 'other' });
  mounted.unmount();
  client.clear();
});

test.each(['mutate', 'mutateAsync'] as const)(
  '%s captures the Flow tuple, task, and authority before a rerender',
  async (method) => {
    const { client, wrapper } = harness();
    let release!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const mutation = renderHook(
      ({ requestScope }) =>
        useAttachTaskFlowGateEvaluationMutation({ requestScope }),
      { wrapper, initialProps: { requestScope: scope } },
    );
    const variables = {
      taskId: 'task-a',
      ref: { ...evaluation.ref },
      sourceSurface: 'nativeBasis',
    };
    onlineManager.setOnline(false);
    const pending =
      method === 'mutateAsync'
        ? mutation.result.current.mutateAsync(variables)
        : new Promise<void>((resolve, reject) =>
            mutation.result.current.mutate(variables, {
              onSuccess: () => resolve(),
              onError: reject,
            }),
          );
    await waitFor(() => expect(mutation.result.current.isPaused).toBe(true));
    mutation.rerender({ requestScope: nextScope });
    variables.taskId = 'task-mutated';
    variables.ref.gateId = 'gate-mutated';
    onlineManager.setOnline(true);
    await waitFor(() => expect(release).toBeTypeOf('function'));
    release(response(attached()));
    await pending;
    expect(fetch.mock.calls[0]?.[0]).toContain('/api/tasks/task-a/references');
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.ref).toEqual(evaluation.ref);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: flowGateEvaluationQueries.retained('task-a', scope).queryKey,
      exact: true,
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: flowGateEvaluationQueries.retained('task-a', nextScope)
        .queryKey,
      exact: true,
    });
    mutation.unmount();
    client.clear();
  },
);
