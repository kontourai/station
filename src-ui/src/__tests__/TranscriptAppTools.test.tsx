/** @vitest-environment jsdom */
import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { type ReactNode, useEffect, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ToolCallDisplay } from '../components/chat/ToolCallDisplay';
import { TranscriptAppTools } from '../components/chat/TranscriptAppTools';

const call = {
  type: 'tool-invocation' as const,
  toolCallId: 'chart',
  toolName: 'demo/chart',
  state: 'completed' as const,
  result: { content: [{ type: 'text', text: 'Chart ready' }] },
};

function Connections({ children }: { children: ReactNode }) {
  const [store] = useState(
    () =>
      new ConnectionStore({
        storage: { get: () => null, set: () => {}, remove: () => {} },
      }),
  );
  return (
    <ConnectionsProvider store={store} defaultUrl="http://station.test">
      {children}
    </ConnectionsProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('optional transcript app discovery', () => {
  test.each(['none', 'query-only', 'connection-only'] as const)(
    '%s context keeps ordinary rows and performs no app lookup',
    async (mode) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const row = <ToolCallDisplay toolCall={call} />;
      render(
        mode === 'query-only' ? (
          <QueryClientProvider client={new QueryClient()}>
            {row}
          </QueryClientProvider>
        ) : mode === 'connection-only' ? (
          <Connections>{row}</Connections>
        ) : (
          row
        ),
      );
      expect(document.querySelector('.tool-call')).toBeTruthy();
      fireEvent.click(document.querySelector('button.tool-call__line')!);
      expect(screen.getByText(/Chart ready/)).toBeTruthy();
      await Promise.resolve();
      expect(fetch).not.toHaveBeenCalled();
      expect(document.querySelector('iframe')).toBeNull();
    },
  );

  test('connected discovery changes eligibility without remounting the row', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ success: true, data: ['chart'] }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    let mounts = 0;
    function Row({ app }: { app: boolean }) {
      const [expanded, setExpanded] = useState(false);
      useEffect(() => {
        mounts += 1;
      }, []);
      return (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
        >{`${app ? 'App' : 'Ordinary'} ${expanded ? 'expanded' : 'collapsed'}`}</button>
      );
    }
    const client = new QueryClient();
    const tree = (completed: boolean) => (
      <Connections>
        <QueryClientProvider client={client}>
          <TranscriptAppTools
            calls={[{ ...call, result: completed ? call.result : undefined }]}
          >
            {(tools) => <Row app={tools.has('demo/chart')} />}
          </TranscriptAppTools>
        </QueryClientProvider>
      </Connections>
    );
    const view = render(tree(false));
    fireEvent.click(screen.getByText('Ordinary collapsed'));
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(tree(true));
    await screen.findByText('App expanded');
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://station.test/integrations/demo/ui-tools',
    );
    view.rerender(tree(false));
    await waitFor(() =>
      expect(screen.getByText('Ordinary expanded')).toBeTruthy(),
    );
    expect(mounts).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
