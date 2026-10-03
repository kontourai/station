/** @vitest-environment jsdom */

import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  useAnswerSupportBundlesQuery,
  useTrustBundlesQuery,
  useTrustReportQuery,
} from '@kontourai/station-sdk';
import {
  CancelledError,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useServerEvents } from '../hooks/useServerEvents';
import { stationQueryDefaults } from '../lib/queryDefaults';

const host = vi.hoisted(() => ({
  apiBase: 'http://station.test',
  current: true,
  base: undefined as Promise<string> | undefined,
  streams: [] as Array<{
    onMessage: (message: { event: string; data: string }) => void;
  }>,
}));

vi.mock('../../../packages/sdk/src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/sdk/src/api')>()),
  _getApiBase: () => host.base ?? Promise.resolve(host.apiBase),
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  fetchSSE: (
    _url: string,
    options: { onMessage: (message: { event: string; data: string }) => void },
  ) => {
    host.streams.push(options);
    return { close: vi.fn() };
  },
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: host.apiBase }),
  useHostRequestAuthorityScope: () => ({
    apiBase: host.apiBase,
    authorityKey: 'authority-a',
    isCurrent: () => host.current,
  }),
}));

type ReaderKind = 'bundles' | 'report' | 'task';
let revision = 'initial';
let requests: string[];

function Reader({ kind, enabled }: { kind: ReaderKind; enabled: boolean }) {
  const bundles = useTrustBundlesQuery('demo', {
    enabled: enabled && kind === 'bundles',
  });
  const report = useTrustReportQuery('demo', 'veritas', {
    enabled: enabled && kind === 'report',
  });
  const task = useAnswerSupportBundlesQuery('task-a', 'ref-a', {
    enabled: enabled && kind === 'task',
  });
  const data =
    kind === 'bundles'
      ? bundles.data
      : kind === 'report'
        ? report.data
        : task.data;
  return (
    <output aria-label="Evidence reader">
      {enabled ? JSON.stringify(data) : 'disabled'}
    </output>
  );
}

function Scene({
  kind,
  shown,
  enabled = true,
}: {
  kind: ReaderKind;
  shown: boolean;
  enabled?: boolean;
}) {
  useServerEvents();
  return shown ? <Reader kind={kind} enabled={enabled} /> : null;
}

function mount(kind: ReaderKind, shown = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { ...stationQueryDefaults(), retry: false } },
  });
  const tree = (visible: boolean, enabled = true) => (
    <QueryClientProvider client={client}>
      <Scene kind={kind} shown={visible} enabled={enabled} />
    </QueryClientProvider>
  );
  const view = render(tree(shown));
  return {
    client,
    ...view,
    setReader: (visible: boolean, enabled = true) =>
      view.rerender(tree(visible, enabled)),
  };
}

async function configChanged() {
  await act(async () => {
    host.streams[0]!.onMessage({
      event: SERVER_EVENTS.CONFIG_CHANGED,
      data: '{}',
    });
  });
}

describe('config-driven evidence readers', () => {
  beforeEach(() => {
    host.current = true;
    host.apiBase = 'http://station.test';
    host.base = undefined;
    host.streams.length = 0;
    revision = 'initial';
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        init?.signal?.throwIfAborted();
        const url = String(input);
        requests.push(url);
        const path = new URL(url).pathname;
        let data: unknown;
        if (path === '/api/projects/demo/trust-bundles')
          data = [{ id: revision }];
        else if (path === '/api/projects/demo/trust-bundles/veritas')
          data = { id: 'veritas', report: { source: revision } };
        else if (
          path === '/api/tasks/task-a/turn-references/ref-a/support/bundles'
        )
          data = [{ id: revision }];
        else throw new Error(`Unexpected evidence request: ${path}`);
        return new Response(JSON.stringify({ success: true, data }));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  test.each(['bundles', 'report'] as const)(
    '%s re-reads invalidated data on return, and disabled observers stay disabled',
    async (kind) => {
      const view = mount(kind);
      await waitFor(() =>
        expect(screen.getByLabelText('Evidence reader').textContent).toContain(
          'initial',
        ),
      );
      const foreign = new QueryClient();
      foreign.setQueryData(['trust-bundles', 'demo'], [{ id: 'foreign' }]);
      view.setReader(false);
      revision = 'updated';
      await configChanged();
      view.setReader(true);
      await waitFor(() =>
        expect(screen.getByLabelText('Evidence reader').textContent).toContain(
          'updated',
        ),
      );
      expect(requests).toHaveLength(2);
      expect(
        foreign.getQueryState(['trust-bundles', 'demo'])?.isInvalidated,
      ).toBe(false);

      view.setReader(false);
      revision = 'latest';
      await configChanged();
      view.setReader(true, false);
      expect(screen.getByLabelText('Evidence reader').textContent).toBe(
        'disabled',
      );
      expect(requests).toHaveLength(2);
      view.setReader(true);
      await waitFor(() =>
        expect(screen.getByLabelText('Evidence reader').textContent).toContain(
          'latest',
        ),
      );
      expect(requests).toHaveLength(3);
    },
  );

  test('mounted Task answer support refreshes, and a retired stream cannot invalidate it again', async () => {
    const view = mount('task');
    await waitFor(() =>
      expect(screen.getByLabelText('Evidence reader').textContent).toContain(
        'initial',
      ),
    );
    revision = 'updated';
    await configChanged();
    await waitFor(() =>
      expect(screen.getByLabelText('Evidence reader').textContent).toContain(
        'updated',
      ),
    );
    expect(requests).toHaveLength(2);
    expect(
      view.client.getQueryState([
        'answer-support',
        'task-a',
        'ref-a',
        'bundles',
      ])?.isInvalidated,
    ).toBe(false);
    host.current = false;
    revision = 'foreign';
    await configChanged();
    expect(
      view.client.getQueryState([
        'answer-support',
        'task-a',
        'ref-a',
        'bundles',
      ])?.isInvalidated,
    ).toBe(false);
    expect(requests).toHaveLength(2);
  });

  test('a cancelled Trust read cannot dispatch after its API base resolves to another Station', async () => {
    let resolveBase = (_base: string) => {};
    host.base = new Promise<string>((resolve) => {
      resolveBase = resolve;
    });
    const view = mount('bundles');
    const key = ['trust-bundles', 'demo'];
    await waitFor(() =>
      expect(view.client.getQueryState(key)?.fetchStatus).toBe('fetching'),
    );
    const waiting = view.client
      .getQueryCache()
      .find({ queryKey: key, exact: true })!.promise!;
    const cancelled = expect(waiting).rejects.toBeInstanceOf(CancelledError);
    await act(async () => {
      await view.client.cancelQueries({ queryKey: key, exact: true });
    });
    await cancelled;
    await act(async () => {
      resolveBase('http://other-station.test');
    });
    expect(requests).toHaveLength(0);
    expect(view.client.getQueryState(key)?.fetchStatus).toBe('idle');
    expect(view.client.getQueryData(key)).toBeUndefined();
  });
});
