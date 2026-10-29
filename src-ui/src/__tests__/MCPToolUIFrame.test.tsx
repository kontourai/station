import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { TranscriptAppTools } from '../components/chat/TranscriptAppTools';
import { conversationPartToContentParts } from '../hooks/orchestration/conversationTranscriptParts';
/**
 * @vitest-environment jsdom
 */

import type {
  MCPAppDisplayModeDecision,
  MCPAppPanePresentationIdentity,
} from '@kontourai/station-contracts/mcp-app-display-mode';
import {
  toWorkspacePaneDescriptorId,
  toWorkspacePaneInstanceId,
  toWorkspacePaneStateKey,
} from '@kontourai/station-contracts/workspace-pane';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useEffect, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MessageContent } from '../components/chat/message-bubble/MessageContent';
import { StreamingMessageView } from '../components/chat/StreamingMessage';
import {
  foldTurnWork,
  splitToolCallRuns,
} from '../components/chat/tool-call-runs';
import { ThemeToggle } from '../components/header/ThemeToggle';
import { isDistinctFrameOrigin } from '../components/mcp-ui/frameOrigin';
import {
  MCPToolUIFrame,
  type MCPToolUIFrameProps,
  mcpUiHostAppearance,
  mcpUiHostGeometry,
  sessionInventoryV2OpenLinkCapability,
} from '../components/mcp-ui/MCPToolUIFrame';
import { deviceSettingsStore } from '../lib/device-settings-store';
import { render } from './renderWithQueryClient';

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useKeyboardShortcut: () => {},
  useShortcutDisplay: () => 'Cmd+H',
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
  useHostRequestAuthorityScope: () => mockRequestAuthority,
}));

let mockNativeShell = false;
let mockRequestAuthority: { isCurrent: () => boolean } | undefined;
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: mockNativeShell }),
}));

let mockConfig: { mcpUiHost?: boolean; mcpUiFrameOrigin?: string } | null =
  null;
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => mockConfig,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  mockConfig = null;
  mockNativeShell = false;
  mockRequestAuthority = undefined;
  deviceSettingsStore.set('theme', 'dark');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-color-theme');
  document.querySelector('[data-mcp-host-theme-test]')?.remove();
  delete (window as Window & { __STATION_CSP_NONCE__?: string })
    .__STATION_CSP_NONCE__;
  for (const name of [
    '--safe-top',
    '--safe-right',
    '--safe-bottom',
    '--safe-left',
    '--bg-primary',
    '--bg-secondary',
    '--bg-tertiary',
    '--text-primary',
    '--text-secondary',
    '--text-tertiary',
    '--border-primary',
    '--border-secondary',
    '--accent-primary',
    '--k-font-ui',
    '--k-font-mono',
  ])
    document.documentElement.style.removeProperty(name);
});

describe('MCPToolUIFrame', () => {
  test('renders a definition-only MCP result inline through the hardened resource route after remount without replaying the tool', async () => {
    mockConfig = { mcpUiHost: true };
    const recorded = {
      content: [{ type: 'text', text: 'Recorded chart' }],
      structuredContent: { count: 7 },
    };
    const base = {
      provider: 'codex' as const,
      threadId: 'apps',
      turnId: 'turn',
      createdAt: '2026-10-17T12:00:00.000Z',
    };
    const messages = projectRuntimeEventsToMessages([
      { ...base, eventId: 'start', method: 'turn.started', prompt: 'Chart' },
      {
        ...base,
        eventId: 'call',
        method: 'tool.started',
        itemId: 'chart-call',
        toolCallId: 'chart-call',
        toolName: 'demo/chart',
        arguments: { range: 'week' },
      },
      {
        ...base,
        eventId: 'result',
        method: 'tool.completed',
        itemId: 'chart-call',
        toolCallId: 'chart-call',
        toolName: 'demo/chart',
        status: 'success',
        output: recorded,
      },
    ]);
    const contentParts = messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) =>
        message.parts.flatMap(conversationPartToContentParts),
      );
    const requests: string[] = [];
    const previewHeaders: (string | null)[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/ui/chart') || url.endsWith('/resource'))
        previewHeaders.push(
          new Headers(init?.headers).get('x-station-mcp-transcript'),
        );
      requests.push(url);
      if (url.endsWith('/ui-tools'))
        return Promise.resolve(response(['chart']));
      if (url.endsWith('/resource'))
        return Promise.resolve(
          response({
            uri: 'ui://demo/chart',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>Chart</main>',
          }),
        );
      if (url.endsWith('/ui/chart'))
        return Promise.resolve(
          response({
            status: 'success',
            ref: 'demo/chart',
            resourceUri: 'ui://demo/chart',
          }),
        );
      throw new Error(`Unexpected request: ${url}`);
    });
    const mount = () =>
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MessageContent
            contentParts={JSON.parse(JSON.stringify(contentParts))}
            textContent=""
            chatFontSize={14}
            showReasoning={false}
            showToolDetails={false}
            isStreamingMessage={false}
            foldWork
          />
        </QueryClientProvider>,
      );
    for (let pass = 0; pass < 2; pass++) {
      const mounted = mount();
      const iframe = await screen.findByTitle<HTMLIFrameElement>(
        'MCP tool UI: demo/chart',
      );
      expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
      expect(iframe.srcdoc).toContain('Content-Security-Policy');
      expect(screen.getByRole('status').textContent).toContain(
        'Interactions are unavailable',
      );
      const target = iframe.contentWindow!;
      const sent = vi.spyOn(target, 'postMessage');
      const send = (data: unknown) =>
        window.dispatchEvent(
          new MessageEvent('message', { data, source: target }),
        );
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'ui/initialize',
        params: {
          appInfo: { name: 'Chart', version: '1' },
          appCapabilities: {},
          protocolVersion: '2026-01-26',
        },
      });
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      await waitFor(() =>
        expect(sent).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'ui/notifications/tool-result',
            params: recorded,
          }),
          '*',
        ),
      );
      send({
        jsonrpc: '2.0',
        method: 'ui/notifications/size-changed',
        params: { height: 208 },
      });
      await waitFor(() => expect(iframe.style.height).toBe('208px'));
      for (const [index, method, params] of [
        [2, 'tools/call', { name: 'mutate', arguments: {} }],
        [3, 'resources/read', { uri: 'file:///secret' }],
        [
          4,
          'ui/message',
          { role: 'user', content: [{ type: 'text', text: 'unapproved' }] },
        ],
        [5, 'ui/open-link', { url: 'https://example.com' }],
      ] as const) {
        send({ jsonrpc: '2.0', id: index, method, params });
        await waitFor(() =>
          expect(sent).toHaveBeenCalledWith(
            expect.objectContaining({
              id: index,
              error: expect.any(Object),
            }),
            '*',
          ),
        );
      }
      mounted.unmount();
    }
    expect(requests.filter((url) => url.endsWith('/resource'))).toHaveLength(2);
    expect(previewHeaders).toEqual([
      'preview',
      'preview',
      'preview',
      'preview',
    ]);
    expect(
      requests.every(
        (url) =>
          url.endsWith('/ui-tools') ||
          url.endsWith('/ui/chart') ||
          url.endsWith('/resource'),
      ),
    ).toBe(true);
  });

  test('keeps one mounted subtree and its state while an ordinary MCP call completes and resumes', async () => {
    fetchMock.mockResolvedValue(response([]));
    let mounts = 0;
    function StatefulRow() {
      useEffect(() => {
        mounts += 1;
      }, []);
      const [expanded, setExpanded] = useState(false);
      return (
        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Expanded row' : 'Collapsed row'}
        </button>
      );
    }
    const client = new QueryClient();
    const tree = (result?: unknown) => (
      <QueryClientProvider client={client}>
        <TranscriptAppTools
          calls={[{ toolCallId: 'ordinary', toolName: 'demo/read', result }]}
        >
          {() => <StatefulRow />}
        </TranscriptAppTools>
      </QueryClientProvider>
    );
    const view = render(tree());
    fireEvent.click(screen.getByText('Collapsed row'));
    view.rerender(tree({ content: [] }));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    view.rerender(tree());
    expect(screen.getByText('Expanded row')).toBeTruthy();
    expect(mounts).toBe(1);
  });

  test('keeps completed app calls in the streaming transcript outside the batch sheet', async () => {
    fetchMock.mockResolvedValue(response(['chart']));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StreamingMessageView
          sessionId="stream"
          agentIcon={null}
          agentIconStyle={{}}
          fontSize={14}
          contentParts={[
            {
              type: 'tool-invocation',
              toolCallId: 'app-call',
              toolName: 'demo/chart',
              result: {
                content: [],
                _meta: { ui: { resourceUri: 'ui://demo/chart' } },
              },
            },
          ]}
          streamingText=""
          hasContent
          contentRevision={1}
          elapsedMs={0}
          renderToolCall={(part) => (
            <span key={part.toolCallId}>Visible {part.toolName}</span>
          )}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Visible demo/chart')).toBeTruthy();
  });

  test('keeps app candidates visible outside desktop batches and folded mobile work', () => {
    const parts = [
      {
        type: 'tool-invocation',
        toolCallId: 'a',
        toolName: 'read_file',
        result: 'a',
      },
      { type: 'text', content: 'Checking' },
      {
        type: 'tool-invocation',
        toolCallId: 'b',
        toolName: 'demo/chart',
        result: {
          content: [],
          _meta: { ui: { resourceUri: 'ui://demo/chart' } },
        },
      },
      {
        type: 'tool-invocation',
        toolCallId: 'c',
        toolName: 'read_file',
        result: 'c',
      },
      { type: 'text', content: 'Done' },
    ];
    for (const split of [splitToolCallRuns, foldTurnWork]) {
      expect(split(parts, new Set(['demo/chart']))).toContainEqual({
        type: 'content-part',
        index: 2,
        part: parts[2],
      });
    }
  });

  test.each([false, true])(
    'ordinary MCP calls stay plain rows on native=%s without resolving an unknown engine server',
    async (native) => {
      mockNativeShell = native;
      fetchMock.mockResolvedValue(response([]));
      await act(async () => {
        renderTranscriptCalls([
          {
            type: 'tool-invocation',
            toolCallId: 'ordinary',
            toolName: 'engine-only/read',
            state: 'result',
            result: { content: [{ type: 'text', text: 'Ordinary result' }] },
          },
        ]);
      });
      expect(screen.getByText('Used engine-only/read')).toBeTruthy();
      expect(
        screen.queryByText(
          /MCP UI unsupported|MCP server unavailable|MCP UI failed to load/,
        ),
      ).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain('/engine-only/ui-tools');
    },
  );

  test('an unresolved recorded App on native leaves only its tool row', () => {
    mockNativeShell = true;
    renderFrame({
      ref: 'demo/chart',
      transcriptResult: {
        result: {
          content: [],
          _meta: { ui: { resourceUri: 'ui://demo/chart' } },
        },
      },
    });
    expect(document.querySelector('.mcp-tool-ui-frame')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    'missing_server',
    'missing_tool',
    'missing_resource',
    'disconnected',
    'error',
  ])(
    'a recorded app with unsuccessful resolution %s adds no transcript card',
    async (status) => {
      fetchMock.mockImplementation(() =>
        status === 'error'
          ? Promise.reject(new Error('resolver offline'))
          : Promise.resolve(response({ status, ref: 'demo/chart' })),
      );
      const frame = renderFrame({
        ref: 'demo/chart',
        transcriptResult: {
          result: {
            content: [],
            _meta: { ui: { resourceUri: 'ui://demo/chart' } },
          },
        },
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await waitFor(() => expect(frame.queryClient.isFetching()).toBe(0));
      await waitFor(() =>
        expect(document.querySelector('.mcp-tool-ui-frame')).toBeNull(),
      );
    },
  );

  test('shows render revocation for a catalog-confirmed transcript App without reading its resource', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        response(
          url.endsWith('/ui-tools')
            ? ['chart']
            : { status: 'render_revoked', ref: 'demo/chart' },
        ),
      ),
    );
    renderTranscriptCalls([
      {
        type: 'tool-invocation',
        toolCallId: 'revoked',
        toolName: 'demo/chart',
        result: { content: [] },
      },
    ]);
    expect(
      await screen.findByText('Rendering disabled for this server'),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/resource')),
    ).toBe(false);
  });

  test('result UI metadata alone cannot mount an ordinary catalog tool', async () => {
    fetchMock.mockResolvedValue(response([]));
    const view = renderTranscriptCalls([
      {
        type: 'tool-invocation',
        toolCallId: 'spoofed',
        toolName: 'demo/read',
        result: {
          content: [],
          _meta: { ui: { resourceUri: 'ui://spoofed/app' } },
        },
      },
    ]);
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
    expect(document.querySelector('iframe')).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3141/integrations/demo/ui-tools',
    ]);
  });

  test.each([false, true])(
    'ordinary MCP calls remain collapsed with foldWork=%s',
    async (foldWork) => {
      fetchMock.mockResolvedValue(response([]));
      renderTranscriptCalls(
        Array.from({ length: 5 }, (_, index) => ({
          type: 'tool-invocation',
          toolCallId: `ordinary-${index}`,
          toolName: 'demo/read',
          state: 'result',
          result: { content: [{ type: 'text', text: 'Ordinary result' }] },
        })),
        foldWork,
      );
      expect(await screen.findByRole('button', { name: /5/ })).toBeTruthy();
      expect(screen.queryByText('Used demo/read')).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain('/demo/ui-tools');
    },
  );

  test('does not split ambiguous provider MCP names into a different server', async () => {
    fetchMock.mockResolvedValue(
      response({ status: 'missing_server', ref: 'my/srv__chart' }),
    );
    await act(async () => {
      renderTranscriptCalls([
        {
          type: 'tool-invocation',
          toolCallId: 'ambiguous',
          toolName: 'mcp__my__srv__chart',
          result: {
            content: [],
            _meta: { ui: { resourceUri: 'ui://demo/chart' } },
          },
        },
      ]);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('.mcp-tool-ui-frame')).toBeNull();
  });

  test('uses explicit provider server identity instead of splitting its MCP name', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        response(
          url.endsWith('/ui-tools')
            ? ['chart']
            : url.endsWith('/resource')
              ? { uri: 'ui://demo/chart', text: '<main>Chart</main>' }
              : {
                  status: 'success',
                  ref: 'my__srv/chart',
                  resourceUri: 'ui://demo/chart',
                },
        ),
      ),
    );
    renderTranscriptCalls([
      {
        type: 'tool-invocation',
        toolCallId: 'explicit',
        toolName: 'mcp__my__srv__chart',
        server: 'my__srv',
        originalName: 'chart',
        result: {
          content: [],
          _meta: { ui: { resourceUri: 'ui://demo/chart' } },
        },
      },
    ]);
    expect(await screen.findByTitle('MCP tool UI: my__srv/chart')).toBeTruthy();
    expect(
      fetchMock.mock.calls.every(
        ([url]) =>
          String(url).includes('/my__srv/ui/chart') ||
          String(url).endsWith('/my__srv/ui-tools'),
      ),
    ).toBe(true);
  });

  test.each([
    { ref: 'demo/chart', resourceUri: 'ui://demo/chart', initialArguments: {} },
    {
      ref: 'station-control/get_session_inventory',
      resourceUri: 'ui://station/basis/session-inventory/v2',
      initialArguments: {
        version: 'station.session-inventory-mcp/v2',
        operation: 'open',
        scope: { kind: 'whole-session', sessionId: 'session' },
      },
    },
  ])(
    'transcript $ref grants no forwarding capabilities and refuses tools under a non-read-only pane policy',
    async ({ ref, resourceUri, initialArguments }) => {
      mockRequestAuthority = { isCurrent: () => true };
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          response(
            url.endsWith('/resource')
              ? { uri: resourceUri, text: '<main>Chart</main>' }
              : {
                  status: 'success',
                  ref,
                  resourceUri,
                },
          ),
        ),
      );
      renderFrame({
        ref,
        approvalPolicy: 'require',
        initialArguments,
        transcriptResult: {
          result: {
            content: [],
            _meta: { ui: { resourceUri } },
          },
        },
      });
      const iframe = await screen.findByTitle<HTMLIFrameElement>(
        `MCP tool UI: ${ref}`,
      );
      const target = iframe.contentWindow!;
      const sent = vi.spyOn(target, 'postMessage');
      const send = (data: unknown) =>
        window.dispatchEvent(
          new MessageEvent('message', { data, source: target }),
        );
      send({
        jsonrpc: '2.0',
        id: 101,
        method: 'ui/initialize',
        params: {
          appInfo: { name: 'Chart', version: '1' },
          appCapabilities: {},
          protocolVersion: '2026-01-26',
        },
      });
      await waitFor(() =>
        expect(sent).toHaveBeenCalledWith(
          expect.objectContaining({ id: 101, result: expect.any(Object) }),
          '*',
        ),
      );
      const initialized = sent.mock.calls.find(
        ([value]) => value.id === 101,
      )?.[0];
      expect(initialized.result.hostCapabilities).not.toHaveProperty(
        'serverTools',
      );
      expect(initialized.result.hostCapabilities).not.toHaveProperty(
        'serverResources',
      );
      expect(initialized.result.hostCapabilities).not.toHaveProperty(
        'openLinks',
      );
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      send({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: { name: 'mutate', arguments: {} },
      });
      await waitFor(() =>
        expect(sent).toHaveBeenCalledWith(
          expect.objectContaining({
            id: 102,
            error: expect.objectContaining({
              message:
                'App interactions are unavailable in transcript previews.',
            }),
          }),
          '*',
        ),
      );
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/ui/call')),
      ).toBe(false);
    },
  );

  test('reports fixed host dimensions and safe-area boundaries without granting layout authority', () => {
    document.documentElement.style.setProperty('--safe-top', '12px');
    document.documentElement.style.setProperty('--safe-bottom', '8px');
    expect(
      mcpUiHostGeometry({
        getBoundingClientRect: () => ({ width: 640, height: 480 }) as DOMRect,
      }),
    ).toMatchObject({
      containerDimensions: { width: 640, height: 480 },
      safeAreaInsets: { top: 12, right: 0, bottom: 8, left: 0 },
      platform: 'web',
    });
  });
  test('maps only resolved Station design tokens onto the official host-style whitelist', () => {
    document.documentElement.style.setProperty('--bg-primary', 'rgb(1, 2, 3)');
    document.documentElement.style.setProperty(
      '--text-primary',
      'rgb(4, 5, 6)',
    );
    expect(mcpUiHostAppearance('dark')).toMatchObject({
      theme: 'dark',
      styles: {
        variables: {
          '--color-background-primary': 'rgb(1, 2, 3)',
          '--color-text-primary': 'rgb(4, 5, 6)',
        },
      },
    });
  });
  test('derives Station v2 open-link authority only from a matching current result', () => {
    const groups = [
      'inputs',
      'sources',
      'work-items',
      'execution',
      'decisions',
      'outputs',
      'verification-delivery',
      'live-now',
      'kept',
      'attention',
      'resources',
    ].map((id) => ({
      id,
      owner: {
        owner:
          id === 'work-items'
            ? 'station.session-work-items'
            : 'station.inventory',
        id: 'v1',
      },
      state: id === 'work-items' ? 'available' : 'empty',
      count: { kind: 'exact', value: id === 'work-items' ? 1 : 0 },
      gaps: [],
      items:
        id === 'work-items'
          ? [
              {
                kind: 'station-session-work-item',
                key: 'work-item:association-235',
                owner: { owner: 'station.session-work-items', id: 'v1' },
                relations: ['observed-during', 'produced-by'],
                sessionId: 'session',
                conversationId: 'conversation',
                eventId: 'event',
                turnId: 'turn',
                toolCallId: 'call',
                provider: { id: 'github', host: 'github.com' },
                workItemRef: 'github:kontourai/station#235',
                repository: { owner: 'kontourai', name: 'station' },
                nativeId: '1234567890',
                associationIds: ['association-235'],
                observedAt: '2026-08-28T12:00:00.000Z',
              },
            ]
          : [],
    }));
    const result = {
      _meta: {
        'station.session-inventory-app/v2': {
          occurrenceId: 'occurrence_'.padEnd(32, 'a'),
          continuations: [],
        },
      },
      structuredContent: {
        version: 'station.session-inventory-mcp/v2',
        kind: 'projection',
        projection: {
          version: 'station.session-inventory/v2',
          scope: { kind: 'whole-session', sessionId: 'session' },
          groups,
        },
      },
    };
    const input = {
      version: 'station.session-inventory-mcp/v2',
      operation: 'open',
      scope: { kind: 'whole-session', sessionId: 'session' },
    };
    const capability = sessionInventoryV2OpenLinkCapability(result, input);
    expect(capability?.urls).toEqual(
      new Set(['https://github.com/kontourai/station/issues/235']),
    );
    expect(
      sessionInventoryV2OpenLinkCapability(result, {
        ...input,
        scope: { kind: 'whole-session', sessionId: 'other' },
      }),
    ).toBeNull();
  });
  test('mediates only current v2 work-item links through the production AppBridge handler', async () => {
    mockConfig = { mcpUiHost: true };
    let current = true;
    mockRequestAuthority = { isCurrent: () => current };
    const openExternalLink = vi.fn().mockResolvedValue(true);
    const scope = { kind: 'whole-session', sessionId: 'session-v2' };
    const occurrence = 'occurrence_v2'.padEnd(32, 'a');
    const url235 = 'https://github.com/kontourai/station/issues/235';
    const url236 = 'https://github.com/kontourai/station/issues/236';
    const projection = (
      number: 235 | 236,
      kind: 'projection' | 'group-page',
    ) => {
      const row = {
        kind: 'station-session-work-item',
        key: `work-item:association-${number}`,
        owner: { owner: 'station.session-work-items', id: 'v1' },
        relations: ['observed-during', 'produced-by'],
        sessionId: scope.sessionId,
        conversationId: 'conversation-v2',
        eventId: `event-${number}`,
        turnId: 'turn-v2',
        toolCallId: `call-${number}`,
        provider: { id: 'github', host: 'github.com' },
        workItemRef: `github:kontourai/station#${number}`,
        repository: { owner: 'kontourai', name: 'station' },
        nativeId: String(number),
        associationIds: [`association-${number}`],
        observedAt: '2026-08-28T12:00:00.000Z',
      };
      const group = {
        id: 'work-items',
        owner: row.owner,
        state: 'available',
        count: { kind: 'exact', value: 1 },
        items: [row],
        gaps: [],
      };
      return kind === 'projection'
        ? {
            version: 'station.session-inventory-mcp/v2',
            kind,
            projection: {
              version: 'station.session-inventory/v2',
              scope,
              groups: [
                'inputs',
                'sources',
                'work-items',
                'execution',
                'decisions',
                'outputs',
                'verification-delivery',
                'live-now',
                'kept',
                'attention',
                'resources',
              ].map((id) =>
                id === 'work-items'
                  ? group
                  : {
                      id,
                      owner: { owner: 'station.inventory', id: 'v1' },
                      state: 'empty',
                      count: { kind: 'exact', value: 0 },
                      items: [],
                      gaps: [],
                    },
              ),
            },
          }
        : {
            version: 'station.session-inventory-mcp/v2',
            kind,
            page: { version: 'station.session-inventory/v2', scope, group },
          };
    };
    const result = (
      number: 235 | 236,
      kind: 'projection' | 'group-page',
      occurrenceId = occurrence,
    ) => ({
      content: [],
      structuredContent: projection(number, kind),
      _meta: {
        'station.session-inventory-app/v2': { occurrenceId, continuations: [] },
      },
    });
    let pageResult: unknown = result(236, 'group-page');
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/resource'))
        return Promise.resolve(
          response({
            uri: 'ui://station/basis/session-inventory/v2',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>v2</main>',
          }),
        );
      if (url.endsWith('/initial-result'))
        return Promise.resolve(response(result(235, 'projection')));
      if (url.endsWith('/ui/call'))
        return Promise.resolve(response(pageResult));
      return Promise.resolve(
        response({
          status: 'success',
          ref: 'station-control/get_session_inventory',
          serverId: 'station-control',
          toolName: 'get_session_inventory',
          resourceUri: 'ui://station/basis/session-inventory/v2',
        }),
      );
    });
    const frame = renderFrame({
      ref: 'station-control/get_session_inventory',
      approvalPolicy: 'require',
      initialArguments: {
        version: 'station.session-inventory-mcp/v2',
        operation: 'open',
        scope,
      },
      openExternalLink,
    });
    const iframe = (await screen.findByTitle(
      'MCP tool UI: station-control/get_session_inventory',
    )) as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    const sent = vi.spyOn(target, 'postMessage');
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent('message', { data, source: target }),
      );
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'Inventory', version: '2' },
        appCapabilities: {},
        protocolVersion: '2026-01-26',
      },
    });
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'ui/notifications/tool-result' }),
        '*',
      ),
    );
    const requestOpen = async (id: number, url: string) => {
      sent.mockClear();
      send({ jsonrpc: '2.0', id, method: 'ui/open-link', params: { url } });
      await waitFor(() =>
        expect(sent).toHaveBeenCalledWith(expect.objectContaining({ id }), '*'),
      );
      return sent.mock.calls.find(
        ([message]) => (message as { id?: number }).id === id,
      )?.[0] as { result?: { isError?: boolean } };
    };
    const requestPage = async (id: number) => {
      sent.mockClear();
      send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'get_session_inventory',
          arguments: {
            version: 'station.session-inventory-mcp/v2',
            operation: 'page',
            scope,
            occurrenceId: occurrence,
            groupId: 'work-items',
            continuationToken: 'token'.padEnd(24, 'a'),
          },
        },
      });
      await waitFor(() =>
        expect(sent).toHaveBeenCalledWith(expect.objectContaining({ id }), '*'),
      );
    };
    await expect(requestOpen(2, url235)).resolves.toMatchObject({ result: {} });
    expect(openExternalLink).toHaveBeenLastCalledWith(url235);
    for (const hostile of [
      'https://attacker.example/kontourai/station/issues/235',
      'https://github.com/kontourai/station/issues/235?attacker=1',
      'https://github.com/kontourai/station/issues/0235',
    ])
      await expect(requestOpen(3, hostile)).resolves.toMatchObject({
        result: { isError: true },
      });
    expect(openExternalLink).toHaveBeenCalledTimes(1);
    await requestPage(4);
    await expect(requestOpen(5, url236)).resolves.toMatchObject({ result: {} });
    expect(openExternalLink).toHaveBeenLastCalledWith(url236);
    current = false;
    await expect(requestOpen(6, url235)).resolves.toMatchObject({
      result: { isError: true },
    });
    expect(openExternalLink).toHaveBeenCalledTimes(2);
    current = true;
    pageResult = result(
      236,
      'group-page',
      'replacement_occurrence'.padEnd(32, 'b'),
    );
    await requestPage(7);
    await expect(requestOpen(8, url236)).resolves.toMatchObject({
      result: { isError: true },
    });
    pageResult = result(236, 'group-page');
    await requestPage(9);
    await expect(requestOpen(10, url236)).resolves.toMatchObject({
      result: {},
    });
    pageResult = { ...result(236, 'group-page'), _meta: {} };
    await requestPage(11);
    await expect(requestOpen(12, url236)).resolves.toMatchObject({
      result: { isError: true },
    });
    pageResult = {
      ...result(236, 'group-page'),
      _meta: {
        'station.session-inventory-app/v2': {
          occurrenceId: 'malformed',
          continuations: [],
        },
      },
    };
    await requestPage(13);
    await expect(requestOpen(14, url236)).resolves.toMatchObject({
      result: { isError: true },
    });
    send({ jsonrpc: '2.0', method: 'ui/notifications/request-teardown' });
    pageResult = result(236, 'group-page');
    await requestPage(15);
    await expect(requestOpen(16, url236)).resolves.toMatchObject({
      result: { isError: true },
    });
    frame.unmount();
  });
  test('never resolves or mounts a scripted MCP iframe inside a native shell', () => {
    mockNativeShell = true;
    mockConfig = { mcpUiHost: true };

    renderFrame({ ref: 'hostile/scripted_panel' });

    expect(screen.getByText('MCP UI unsupported')).toBeTruthy();
    expect(
      screen.getByText(/host IPC to subframes.*web client instead/i),
    ).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('shows invalid_ref without calling the resolver', () => {
    renderFrame({ ref: 'bad-ref' });

    expect(screen.getByText('Invalid MCP UI reference')).toBeTruthy();
    expect(screen.getByText('ref: bad-ref')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('shows missing_server from a mocked resolver response', async () => {
    mockResolver({
      success: true,
      data: {
        status: 'missing_server',
        ref: 'github/create_issue',
        serverId: 'github',
        toolName: 'create_issue',
        reason: 'MCP server is not installed',
      },
    });

    renderFrame({ ref: 'github/create_issue' });

    expect(await screen.findByText('MCP server unavailable')).toBeTruthy();
    expect(screen.getByText('MCP server is not installed')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3141/integrations/github/ui/create_issue',
      { method: 'GET' },
    );
  });

  test('shows missing_tool from a mocked resolver response', async () => {
    mockResolver({
      success: true,
      data: {
        status: 'missing_tool',
        ref: 'github/create_issue',
        serverId: 'github',
        toolName: 'create_issue',
      },
    });

    renderFrame({ ref: 'github/create_issue' });

    expect(await screen.findByText('MCP tool unavailable')).toBeTruthy();
  });

  test('shows missing_resource and reports fallback name', async () => {
    mockResolver({
      success: true,
      data: {
        status: 'missing_resource',
        ref: 'github/create_issue',
        serverId: 'github',
        toolName: 'create_issue',
      },
    });

    renderFrame({
      ref: 'github/create_issue',
      fallbackComponentName: 'DefaultLayout',
      fallbackComponent: <button type="button">Open fallback</button>,
    });

    expect(await screen.findByText('MCP UI resource missing')).toBeTruthy();
    expect(screen.getByText('fallback: DefaultLayout')).toBeTruthy();
    expect(screen.getByText('Open fallback')).toBeTruthy();
  });

  test.each(['missing_resource', 'render_revoked'] as const)(
    'reports the terminal %s resolver status without changing frame policy',
    async (status) => {
      const onResolutionStatus = vi.fn();
      mockResolver({
        success: true,
        data: {
          status,
          ref: 'github/create_issue',
          serverId: 'github',
          toolName: 'create_issue',
        },
      });

      renderFrame({ ref: 'github/create_issue', onResolutionStatus });

      await screen.findByRole('status');
      await waitFor(() =>
        expect(onResolutionStatus).toHaveBeenCalledWith({
          ref: 'github/create_issue',
          status,
        }),
      );
    },
  );

  test('treats resolved remote URLs as unsupported without rendering an iframe (host opted out)', async () => {
    // mcpUiHost is on by default; this exercises the explicit opt-out path.
    mockConfig = { mcpUiHost: false };
    mockResolver({
      success: true,
      data: {
        status: 'success',
        ref: 'github/create_issue',
        serverId: 'github',
        toolName: 'create_issue',
        resourceUri: 'https://example.com/mcp-ui',
      },
    });

    renderFrame({ ref: 'github/create_issue' });

    expect(await screen.findByText('MCP UI unsupported')).toBeTruthy();
    expect(
      screen.getByText(
        'Remote MCP UI resources are unsupported until Station has a trusted host security model. No iframe, bridge, or tool proxy is enabled.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTitle('MCP tool UI github/create_issue')).toBeNull();
  });

  test('shows unsupported when the host is opted out (mcpUiHost: false)', async () => {
    mockConfig = { mcpUiHost: false };
    mockResolver({
      success: true,
      data: {
        status: 'success',
        ref: 'github/create_issue',
        serverId: 'github',
        toolName: 'create_issue',
        resourceUri: 'ui://github/create_issue',
      },
    });

    renderFrame({ ref: 'github/create_issue' });

    expect(await screen.findByText('MCP UI unsupported')).toBeTruthy();
    expect(screen.queryByTitle('MCP tool UI github/create_issue')).toBeNull();
  });

  test('shows error when the resolver transport fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ success: false, error: 'resolver failed' }),
    });

    renderFrame({ ref: 'github/create_issue' });

    expect(await screen.findByText('MCP UI failed to load')).toBeTruthy();
    expect(
      screen.getByText('Request failed: Internal Server Error'),
    ).toBeTruthy();
  });

  test('shows error when the resolver envelope reports failure', async () => {
    mockResolver({ success: false, error: 'resolver failed' });

    renderFrame({ ref: 'github/create_issue' });

    expect(await screen.findByText('MCP UI failed to load')).toBeTruthy();
    expect(screen.getByText('resolver failed')).toBeTruthy();
  });

  test('station#2236: a non-string envelope error renders what the server computed, not [object Object]', async () => {
    mockResolver({ success: false, error: { code: 'missing_server' } });

    renderFrame({ ref: 'github/create_issue' });

    expect(await screen.findByText('MCP UI failed to load')).toBeTruthy();
    expect(screen.getByText('{"code":"missing_server"}')).toBeTruthy();
  });

  test('renders a sandboxed iframe with a deny-all CSP when mcpUiHost is enabled', async () => {
    mockConfig = { mcpUiHost: true };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/resource')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/panel',
              mimeType: 'text/html',
              text: '<p>hello panel</p>',
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/panel',
          },
        }),
      };
    });

    renderFrame({ ref: 'github/create_issue' });

    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).toContain('hello panel');
    expect(iframe.srcdoc).toContain("default-src 'none'");
    // No declared csp → deny-by-default network, and no permissions → no allow.
    expect(iframe.srcdoc).toContain("connect-src 'none'");
    expect(iframe.getAttribute('allow')).toBeNull();
    // The unsupported notice must NOT show when the host render is active.
    expect(screen.queryByText('MCP UI unsupported')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3141/integrations/github/ui/create_issue/resource',
      { method: 'GET' },
    );
  });

  test('does not grant the Station shell nonce to untrusted srcdoc scripts', async () => {
    mockConfig = { mcpUiHost: true };
    // Seed the nonce where `resolveCspNonce` actually reads it (the marker
    // element). Seeding the old `window.__STATION_CSP_NONCE__` global left
    // this regression test powerless: that carrier was removed, so the
    // assertion would pass even if someone wired `resolveCspNonce` in here
    // tomorrow (archive#4287).
    // `globalThis.document` on purpose: this test shadows `document` further
    // down with the PARSED srcdoc, so the bare name is in its TDZ up here.
    const cspMarker = globalThis.document.createElement('script');
    cspMarker.nonce = 'shell-csp-nonce';
    cspMarker.setAttribute('data-station-csp-nonce', '');
    globalThis.document.head.appendChild(cspMarker);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/resource')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/panel',
              mimeType: 'text/html',
              text: '<script>window.panelReady = true</script><script src="https://undeclared.example/payload.js"></script>',
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/panel',
          },
        }),
      };
    });

    renderFrame({ ref: 'github/create_issue' });

    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    const document = new DOMParser().parseFromString(
      iframe.srcdoc,
      'text/html',
    );
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).not.toContain("'nonce-shell-csp-nonce'");
    expect(
      [...document.scripts].some(
        (script) => script.textContent === 'window.panelReady = true',
      ),
    ).toBe(true);
    expect(
      document.querySelector(
        'script[src="https://undeclared.example/payload.js"]',
      ),
    ).not.toBeNull();
    expect(
      [...document.scripts].every((script) => !script.hasAttribute('nonce')),
    ).toBe(true);
    expect(iframe.srcdoc).toContain('https://undeclared.example/payload.js');
    expect(
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content'),
    ).not.toContain('undeclared.example');
  });

  test('renders by default (mcpUiHost unset → host on)', async () => {
    // No mcpUiHost in config: the host is on by default and must render.
    mockConfig = { defaultModel: 'claude-sonnet' } as never;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/resource')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/panel',
              mimeType: 'text/html',
              text: '<p>default on</p>',
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/panel',
          },
        }),
      };
    });

    renderFrame({ ref: 'github/create_issue' });

    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain('default on');
    expect(screen.queryByText('MCP UI unsupported')).toBeNull();
  });

  test('builds CSP and permissions from resource metadata', async () => {
    mockConfig = { mcpUiHost: true };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/resource')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/panel',
              mimeType: 'text/html',
              text: '<p>declared</p>',
              ui: {
                csp: {
                  connectDomains: [
                    'https://api.example.com',
                    'wss://events.example.com',
                    'http://insecure.example.com',
                  ],
                  resourceDomains: ['https://cdn.example.com'],
                },
                permissions: { clipboardWrite: {} },
              },
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/panel',
          },
        }),
      };
    });

    renderFrame({ ref: 'github/create_issue' });

    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    // Declared https connect domain is allowed; insecure http is dropped.
    expect(iframe.srcdoc).toContain(
      'connect-src https://api.example.com wss://events.example.com',
    );
    expect(iframe.srcdoc).not.toContain('http://insecure.example.com');
    // Resource domain flows into script/style/img directives.
    expect(iframe.srcdoc).toContain('https://cdn.example.com');
    // Permission-policy from declared permissions.
    expect(iframe.getAttribute('allow')).toContain('clipboard-write');
  });

  test('ignores tool policy when resource metadata is present', async () => {
    mockConfig = { mcpUiHost: true };
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      statusText: 'OK',
      json: async () =>
        url.endsWith('/resource')
          ? {
              success: true,
              data: {
                uri: 'ui://github/panel',
                text: '<p>resource policy</p>',
                ui: {
                  csp: {
                    connectDomains: ['https://resource.example.com'],
                  },
                  permissions: { microphone: {} },
                },
              },
            }
          : {
              success: true,
              data: {
                status: 'success',
                ref: 'github/create_issue',
                serverId: 'github',
                toolName: 'create_issue',
                resourceUri: 'ui://github/panel',
                csp: { connectDomains: ['https://tool.example.com'] },
                permissions: { camera: {} },
              },
            },
    }));

    renderFrame({ ref: 'github/create_issue' });
    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    expect(iframe.srcdoc).toContain('connect-src https://resource.example.com');
    expect(iframe.srcdoc).not.toContain('https://tool.example.com');
    expect(iframe.getAttribute('allow')).toBe('microphone');
  });

  test('loads the resource before mounting the different-origin sandbox proxy', async () => {
    // A distinct origin from jsdom's window.location.origin.
    const frameOrigin = 'http://localhost:4555';
    mockConfig = { mcpUiHost: true, mcpUiFrameOrigin: frameOrigin };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/resource')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/panel',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main>proxied app</main>',
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/panel',
          },
        }),
      };
    });

    renderFrame({ ref: 'github/create_issue' });

    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    // allow-same-origin is granted ONLY because the origin is verified distinct.
    expect(iframe.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin',
    );
    expect(iframe.getAttribute('src')).toBe(`${frameOrigin}/mcp-ui/proxy`);
    expect(iframe.getAttribute('srcdoc')).toBeNull();
    // The host fetches and pins the raw resource before delivering it through
    // the reserved sandbox-resource-ready notification.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3141/integrations/github/ui/create_issue/resource',
      { method: 'GET' },
    );
  });

  test('degrades to opaque-origin srcdoc when the frame origin equals Station origin', async () => {
    // A misconfigured same-origin frame must NOT get allow-same-origin.
    mockConfig = {
      mcpUiHost: true,
      mcpUiFrameOrigin: window.location.origin,
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/resource')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/panel',
              mimeType: 'text/html',
              text: '<p>degraded</p>',
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/panel',
          },
        }),
      };
    });

    renderFrame({ ref: 'github/create_issue' });

    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).toContain('degraded');
    expect(iframe.getAttribute('src')).toBeNull();
  });

  test('isDistinctFrameOrigin only trusts a parseable origin that differs from Station', () => {
    expect(isDistinctFrameOrigin(undefined)).toBe(false);
    expect(isDistinctFrameOrigin('')).toBe(false);
    expect(isDistinctFrameOrigin('not a url')).toBe(false);
    expect(isDistinctFrameOrigin(window.location.origin)).toBe(false);
    expect(isDistinctFrameOrigin('http://localhost:4555')).toBe(true);
  });

  test('falls back to the mcp-ui.dev embedded dialect on missing_resource for a read-only pin', async () => {
    mockConfig = { mcpUiHost: true };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/embedded')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/create_issue',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main id="panel">embedded mcp-ui.dev resource</main>',
            },
          }),
        };
      }
      // SEP-1865 resolve finds no _meta.ui.resourceUri → missing_resource.
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'missing_resource',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
          },
        }),
      };
    });

    renderFrame({ ref: 'github/create_issue', approvalPolicy: 'read-only' });

    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).toContain('embedded mcp-ui.dev resource');
    expect(iframe.srcdoc).toContain("default-src 'none'");
    // It fetched the embedded endpoint, not the SEP-1865 /resource endpoint.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3141/integrations/github/ui/create_issue/embedded',
      { method: 'GET' },
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://localhost:3141/integrations/github/ui/create_issue/resource',
      { method: 'GET' },
    );
  });

  test('does not report missing_resource while an eligible embedded presentation succeeds', async () => {
    const onResolutionStatus = vi.fn();
    mockConfig = { mcpUiHost: true };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/embedded')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/create_issue',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main>embedded view</main>',
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'missing_resource',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
          },
        }),
      };
    });

    renderFrame({
      ref: 'github/create_issue',
      approvalPolicy: 'read-only',
      onResolutionStatus,
    });

    await screen.findByTitle('MCP tool UI: github/create_issue');
    expect(onResolutionStatus).not.toHaveBeenCalled();
  });

  test('reports missing_resource only after the eligible embedded presentation fails', async () => {
    const onResolutionStatus = vi.fn();
    mockConfig = { mcpUiHost: true };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/embedded')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://github/create_issue',
              mimeType: 'text/html;profile=mcp-app',
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'missing_resource',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
          },
        }),
      };
    });

    renderFrame({
      ref: 'github/create_issue',
      approvalPolicy: 'read-only',
      onResolutionStatus,
    });

    await screen.findByText('MCP UI failed to load');
    await waitFor(() =>
      expect(onResolutionStatus).toHaveBeenCalledWith({
        ref: 'github/create_issue',
        status: 'missing_resource',
      }),
    );
  });

  test('does NOT use the embedded dialect when the pin is not read-only', async () => {
    mockConfig = { mcpUiHost: true };
    mockResolver({
      success: true,
      data: {
        status: 'missing_resource',
        ref: 'github/create_issue',
        serverId: 'github',
        toolName: 'create_issue',
      },
    });

    // No approvalPolicy (prompts locally; not read-only) → embedded fetch must not happen.
    renderFrame({ ref: 'github/create_issue' });

    expect(await screen.findByText('MCP UI resource missing')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://localhost:3141/integrations/github/ui/create_issue/embedded',
      { method: 'GET' },
    );
  });

  // A `require` pin reaching the server with no local prompt is proven by the
  // v2 work-item test above: its `tools/call` would hang behind this prompt.
  test.each([
    { approvalPolicy: 'read-only', answer: null, reaches: false },
    { approvalPolicy: undefined, answer: 'Deny', reaches: false },
    { approvalPolicy: 'inherit', answer: 'Deny', reaches: false },
    { approvalPolicy: 'inherit', answer: 'Approve', reaches: true },
  ] as const)(
    'a View tool call under a $approvalPolicy pin answered $answer reaches the server: $reaches',
    async ({ approvalPolicy, answer, reaches }) => {
      mockConfig = { mcpUiHost: true };
      fetchMock.mockImplementation((url: string) => {
        if (url.endsWith('/resource'))
          return Promise.resolve(
            response({
              uri: 'ui://github/create-issue',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main>create issue</main>',
            }),
          );
        if (url.endsWith('/ui/call'))
          return Promise.resolve(response({ content: [], marker: 'CALLED' }));
        return Promise.resolve(
          response({
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/create-issue',
          }),
        );
      });
      renderFrame({ ref: 'github/create_issue', approvalPolicy });
      const iframe = (await screen.findByTitle(
        'MCP tool UI: github/create_issue',
      )) as HTMLIFrameElement;
      const target = iframe.contentWindow!;
      const sent = vi.spyOn(target, 'postMessage');
      const send = (data: unknown) =>
        window.dispatchEvent(
          new MessageEvent('message', { data, source: target }),
        );
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'ui/initialize',
        params: {
          appInfo: { name: 'fixture', version: '1.0.0' },
          appCapabilities: {},
          protocolVersion: '2026-01-26',
        },
      });
      await waitFor(() =>
        expect(sent).toHaveBeenCalledWith(
          expect.objectContaining({ id: 1, result: expect.any(Object) }),
          '*',
        ),
      );
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'create_issue', arguments: { title: 'x' } },
      });
      if (answer) {
        expect(await screen.findByText('Approve MCP tool call')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: answer }));
      }
      await waitFor(() =>
        expect(sent).toHaveBeenCalledWith(
          expect.objectContaining({ id: 2 }),
          '*',
        ),
      );
      const reply = sent.mock.calls.find(
        ([message]) => (message as { id?: number }).id === 2,
      )?.[0] as { result?: unknown; error?: { message?: string } };
      const serverCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/ui/call'),
      );
      if (reaches) {
        expect(reply.error).toBeUndefined();
        expect(reply.result).toMatchObject({ marker: 'CALLED' });
        expect(serverCalls).toHaveLength(1);
      } else {
        expect(reply.result).toBeUndefined();
        expect(reply.error?.message).toMatch(
          answer ? /denied by user/ : /read-only; tool calls are blocked/,
        );
        expect(serverCalls).toHaveLength(0);
      }
      if (!answer)
        expect(screen.queryByText('Approve MCP tool call')).toBeNull();
    },
  );

  test('mediates AppBridge fullscreen and PiP requests through exact Pane host intent', async () => {
    mockConfig = { mcpUiHost: true };
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/create-issue',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            uri: 'ui://github/create-issue',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>create issue</main>',
          },
        }),
      });
    const paneIdentity = {
      descriptorId: toWorkspacePaneDescriptorId('github-create'),
      instanceId: toWorkspacePaneInstanceId('github-create-instance'),
      stateKey: toWorkspacePaneStateKey('github-create-state'),
    };
    const onRequestDisplayMode = vi.fn(() => true);
    const onDisplayModeDecision =
      vi.fn<(decision: MCPAppDisplayModeDecision) => void>();
    const frame = renderFrame({
      ref: 'github/create_issue',
      paneIdentity,
      hostAvailableDisplayModes: ['inline', 'fullscreen'],
      onRequestDisplayMode,
      onDisplayModeDecision,
    });
    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    const postMessage = vi.spyOn(target, 'postMessage');
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          source: target,
        }),
      );
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'fixture', version: '1.0.0' },
        appCapabilities: {
          availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        },
        protocolVersion: '2026-01-26',
      },
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, result: expect.any(Object) }),
        '*',
      ),
    );
    send({
      jsonrpc: '2.0',
      id: 10,
      method: 'ui/request-display-mode',
      params: { mode: 'fullscreen' },
    });
    await waitFor(() =>
      expect(onDisplayModeDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: 'declined',
          actualMode: 'inline',
          reason: 'lifecycle-not-active',
        }),
      ),
    );
    expect(onRequestDisplayMode).not.toHaveBeenCalled();
    onDisplayModeDecision.mockClear();
    send({
      jsonrpc: '2.0',
      method: 'ui/notifications/initialized',
    });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'ui/request-display-mode',
      params: { mode: 'fullscreen' },
    });
    await waitFor(() =>
      expect(onDisplayModeDecision).toHaveBeenCalledWith({
        outcome: 'accepted',
        requestedMode: 'fullscreen',
        actualMode: 'fullscreen',
        panePresentation: 'maximized',
        paneIdentity,
        popout: false,
      }),
    );
    expect(onRequestDisplayMode).toHaveBeenCalledWith('fullscreen');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2, result: { mode: 'fullscreen' } }),
      '*',
    );
    frame.rerenderDisplayMode('fullscreen');

    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'ui/request-display-mode',
      params: { mode: 'pip' },
    });
    await waitFor(() =>
      expect(onDisplayModeDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: 'unsupported',
          requestedMode: 'pip',
          actualMode: 'fullscreen',
          reason: 'pip-unsupported',
          popout: false,
        }),
      ),
    );
    expect(onRequestDisplayMode).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, result: { mode: 'fullscreen' } }),
      '*',
    );
    frame.rerenderDisplayMode('inline');
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'ui/request-display-mode',
      params: { mode: 'pip' },
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 4, result: { mode: 'inline' } }),
        '*',
      ),
    );
    frame.rerenderHost({
      displayMode: 'inline',
      availableModes: ['inline'],
    });
    send({
      jsonrpc: '2.0',
      id: 5,
      method: 'ui/request-display-mode',
      params: { mode: 'fullscreen' },
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 5, result: { mode: 'inline' } }),
        '*',
      ),
    );
    frame.rerenderHost({
      displayMode: 'inline',
      availableModes: ['inline', 'fullscreen'],
    });
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'ui/request-display-mode',
      params: { mode: 'fullscreen' },
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 6, result: { mode: 'fullscreen' } }),
        '*',
      ),
    );
    frame.rerenderHost({
      displayMode: 'inline',
      availableModes: ['inline', 'fullscreen'],
      requestMode: null,
    });
    send({
      jsonrpc: '2.0',
      id: 7,
      method: 'ui/request-display-mode',
      params: { mode: 'fullscreen' },
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7, result: { mode: 'inline' } }),
        '*',
      ),
    );
  });

  test('delivers one host-fetched initial result and updates resolved theme tokens without replay', async () => {
    mockConfig = { mcpUiHost: true };
    const initialArguments = {
      scope: 'answer',
      sessionId: 'session-a',
      turnId: 'turn-a',
    };
    const initialResult = {
      content: [{ type: 'text', text: 'Unassessed' }],
      structuredContent: { version: 'surface.basis-projection/v1' },
    };
    // Use the same DOM authority as Station: ThemeToggle applies data-theme
    // after render. Pre-setting inline tokens hides stale render-time reads.
    const hostThemeStyles = document.createElement('style');
    hostThemeStyles.setAttribute('data-mcp-host-theme-test', '');
    hostThemeStyles.textContent =
      ':root{--bg-primary:rgb(8, 16, 24)}:root[data-theme="light"]{--bg-primary:rgb(255, 252, 241)}:root[data-theme="light"][data-color-theme="latte"]{--bg-primary:rgb(239, 241, 245)}';
    document.head.append(hostThemeStyles);
    document.documentElement.style.setProperty(
      '--text-primary',
      'rgb(240, 245, 240)',
    );
    deviceSettingsStore.set('theme', 'dark');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/initial-result')) {
        expect(init).toMatchObject({ method: 'POST' });
        expect(JSON.parse(String(init?.body))).toEqual({
          arguments: initialArguments,
        });
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({ success: true, data: initialResult }),
        };
      }
      if (url.endsWith('/resource')) {
        return {
          ok: true,
          statusText: 'OK',
          json: async () => ({
            success: true,
            data: {
              uri: 'ui://station/basis/v1',
              mimeType: 'text/html;profile=mcp-app',
              text: '<main>Basis</main>',
            },
          }),
        };
      }
      return {
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'station-control/get_basis',
            serverId: 'station-control',
            toolName: 'get_basis',
            resourceUri: 'ui://station/basis/v1',
          },
        }),
      };
    });
    const frame = renderFrame({
      ref: 'station-control/get_basis',
      initialArguments,
      includeThemeToggle: true,
    });
    const iframe = (await screen.findByTitle(
      'MCP tool UI: station-control/get_basis',
    )) as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    const postMessage = vi.spyOn(target, 'postMessage');
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent('message', { data, source: target }),
      );
    send({
      jsonrpc: '2.0',
      id: 30,
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'Surface Basis', version: '1.0.0' },
        appCapabilities: {},
        protocolVersion: '2026-01-26',
      },
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 30,
          result: expect.objectContaining({
            hostContext: expect.objectContaining({
              theme: 'dark',
              styles: expect.objectContaining({
                variables: expect.objectContaining({
                  '--color-background-primary': 'rgb(8,16,24)',
                }),
              }),
            }),
          }),
        }),
        '*',
      ),
    );
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3141/integrations/station-control/ui/get_basis/initial-result',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/initial-result'),
      ),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'Switch to light mode' }),
    );
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(
      getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-primary')
        .trim(),
    ).toBe('rgb(255,252,241)');
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'ui/notifications/host-context-changed',
          params: expect.objectContaining({
            theme: 'light',
            styles: expect.objectContaining({
              variables: expect.objectContaining({
                '--color-background-primary': 'rgb(255,252,241)',
              }),
            }),
          }),
        }),
        '*',
      ),
    );
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/initial-result'),
      ),
    ).toHaveLength(1);
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'ui/notifications/tool-input',
          params: { arguments: initialArguments },
        }),
        '*',
      ),
    );
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'ui/notifications/tool-result',
          params: initialResult,
        }),
        '*',
      ),
    );
    // A palette change leaves the light/dark setting alone; the frame must
    // still receive the newly resolved tokens.
    postMessage.mockClear();
    act(() => {
      document.documentElement.setAttribute('data-color-theme', 'latte');
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'ui/notifications/host-context-changed',
          // The bridge sends only what changed: the theme name did not.
          params: expect.objectContaining({
            styles: expect.objectContaining({
              variables: expect.objectContaining({
                '--color-background-primary': 'rgb(239,241,245)',
              }),
            }),
          }),
        }),
        '*',
      ),
    );
    frame.rerenderDisplayMode('fullscreen');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/initial-result'),
      ),
    ).toHaveLength(1);
  });

  test('revokes a deferred Basis open after its frame unmounts', async () => {
    mockConfig = { mcpUiHost: true };
    let resolveOpen: ((value: unknown) => void) | undefined;
    const open = new Promise((resolve) => {
      resolveOpen = resolve;
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/basis/app-read')) return open;
      if (url.endsWith('/resource'))
        return Promise.resolve(
          response({
            uri: 'ui://station/basis/task/v2',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>Basis</main>',
          }),
        );
      return Promise.resolve(
        response({
          status: 'success',
          ref: 'station-control/get_task_basis',
          serverId: 'station-control',
          toolName: 'get_task_basis',
          resourceUri: 'ui://station/basis/task/v2',
        }),
      );
    });
    const frame = renderFrame({
      ref: 'station-control/get_task_basis',
      initialArguments: { taskId: 'task-a' },
      basisReadSession: {
        serverId: 'station-control',
        toolName: 'get_task_basis',
        taskId: 'task-a',
      },
    });
    const iframe = (await screen.findByTitle(
      'MCP tool UI: station-control/get_task_basis',
    )) as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          jsonrpc: '2.0',
          id: 1,
          method: 'ui/initialize',
          params: {
            appInfo: { name: 'Basis', version: '1' },
            appCapabilities: {},
            protocolVersion: '2026-01-26',
          },
        },
        source: target,
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { jsonrpc: '2.0', method: 'ui/notifications/initialized' },
        source: target,
      }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3141/api/tasks/task-a/basis/app-read',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    frame.unmount();
    resolveOpen?.(
      response(
        {
          status: 'available',
          taskId: 'task-a',
          offsets: { answerOffset: 0, unassociatedOffset: 0 },
          answers: [],
          unassociated: [],
          gaps: [],
        },
        { 'station.task-basis-app/v1': { occurrenceId: 'old-occurrence' } },
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3141/api/tasks/task-a/basis/app-read',
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ occurrenceId: 'old-occurrence' }),
        }),
      ),
    );
  });

  test('a late continuation cannot cross a same-component Task replacement', async () => {
    mockConfig = { mcpUiHost: true };
    const occurrenceA = 'occurrence_a'.padEnd(32, 'a');
    const occurrenceB = 'occurrence_b'.padEnd(32, 'b');
    const tokenA = 'token_a'.padEnd(32, 'a');
    const tokenB = 'token_b'.padEnd(32, 'b');
    let resolveLate!: (value: ReturnType<typeof response>) => void;
    const late = new Promise<ReturnType<typeof response>>((resolve) => {
      resolveLate = resolve;
    });
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/basis/app-read')) {
        if (init?.method === 'DELETE') return Promise.resolve(response({}));
        const args = JSON.parse(String(init?.body));
        const isA = url.includes('/task-a/');
        if (isA && args.continuationToken) return late;
        // The bridge treats structured content as opaque; domain parser
        // validation is separately exercised with real pages in browser tests.
        return Promise.resolve(
          response(
            {
              taskId: isA ? 'task-a' : 'task-b',
              marker: isA ? 'initial-a' : 'fresh-b',
            },
            {
              'station.task-basis-app/v1': {
                occurrenceId: isA ? occurrenceA : occurrenceB,
                continuationToken: isA ? tokenA : tokenB,
              },
            },
          ),
        );
      }
      if (url.endsWith('/resource'))
        return Promise.resolve(
          response({
            uri: 'ui://station/basis/task/v2',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>Basis</main>',
          }),
        );
      return Promise.resolve(
        response({
          status: 'success',
          ref: 'station-control/get_task_basis',
          serverId: 'station-control',
          toolName: 'get_task_basis',
          resourceUri: 'ui://station/basis/task/v2',
        }),
      );
    });
    const frame = renderFrame({
      ref: 'station-control/get_task_basis',
      approvalPolicy: 'read-only',
      initialArguments: { taskId: 'task-a' },
      basisReadSession: {
        serverId: 'station-control',
        toolName: 'get_task_basis',
        taskId: 'task-a',
      },
    });
    const iframe = (await screen.findByTitle(
      'MCP tool UI: station-control/get_task_basis',
    )) as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    const sent = vi.spyOn(target, 'postMessage');
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent('message', { data, source: target }),
      );
    const initialize = async (id: number) => {
      send({
        jsonrpc: '2.0',
        id,
        method: 'ui/initialize',
        params: {
          appInfo: { name: 'Basis', version: '1' },
          appCapabilities: {},
          protocolVersion: '2026-01-26',
        },
      });
      await waitFor(() =>
        expect(sent).toHaveBeenCalledWith(
          expect.objectContaining({
            id,
            result: expect.objectContaining({
              hostCapabilities: expect.objectContaining({ serverTools: {} }),
            }),
          }),
          '*',
        ),
      );
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    };
    await initialize(70);
    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'ui/notifications/tool-result',
          params: expect.objectContaining({
            structuredContent: expect.objectContaining({ taskId: 'task-a' }),
          }),
        }),
        '*',
      ),
    );
    send({
      jsonrpc: '2.0',
      id: 71,
      method: 'tools/call',
      params: {
        name: 'get_task_basis',
        arguments: { taskId: 'task-a', continuationToken: tokenA },
      },
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3141/api/tasks/task-a/basis/app-read',
        expect.objectContaining({
          body: JSON.stringify({
            continuationToken: tokenA,
            occurrenceId: occurrenceA,
          }),
        }),
      ),
    );
    frame.rerenderBasisTask('task-b');
    await initialize(72);
    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'ui/notifications/tool-result',
          params: expect.objectContaining({
            structuredContent: expect.objectContaining({ taskId: 'task-b' }),
          }),
        }),
        '*',
      ),
    );
    sent.mockClear();
    resolveLate(
      response(
        { taskId: 'task-a', marker: 'OLD_PROTECTED_CONTINUATION' },
        { 'station.task-basis-app/v1': { occurrenceId: occurrenceA } },
      ),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).includes('/task-a/') && init?.method === 'DELETE',
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
    expect(JSON.stringify(sent.mock.calls)).not.toContain(
      'OLD_PROTECTED_CONTINUATION',
    );
    send({
      jsonrpc: '2.0',
      id: 73,
      method: 'tools/call',
      params: {
        name: 'get_task_basis',
        arguments: { taskId: 'task-b', continuationToken: tokenB },
      },
    });
    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 73,
          result: expect.objectContaining({
            structuredContent: expect.objectContaining({ marker: 'fresh-b' }),
          }),
        }),
        '*',
      ),
    );
    expect(JSON.stringify(sent.mock.calls)).not.toContain(
      'OLD_PROTECTED_CONTINUATION',
    );
  });

  test('does not advertise or accept fullscreen without an executable Pane host callback', async () => {
    mockConfig = { mcpUiHost: true };
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            status: 'success',
            ref: 'github/create_issue',
            serverId: 'github',
            toolName: 'create_issue',
            resourceUri: 'ui://github/create-issue',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        statusText: 'OK',
        json: async () => ({
          success: true,
          data: {
            uri: 'ui://github/create-issue',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>create issue</main>',
          },
        }),
      });
    const onDisplayModeDecision = vi.fn();
    renderFrame({
      ref: 'github/create_issue',
      paneIdentity: {
        descriptorId: toWorkspacePaneDescriptorId('github-create'),
        instanceId: toWorkspacePaneInstanceId('github-create-instance'),
        stateKey: toWorkspacePaneStateKey('github-create-state'),
      },
      hostAvailableDisplayModes: ['inline', 'fullscreen'],
      onDisplayModeDecision,
    });
    const iframe = (await screen.findByTitle(
      'MCP tool UI: github/create_issue',
    )) as HTMLIFrameElement;
    const target = iframe.contentWindow!;
    const postMessage = vi.spyOn(target, 'postMessage');
    const send = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent('message', { data, source: target }),
      );
    send({
      jsonrpc: '2.0',
      id: 20,
      method: 'ui/initialize',
      params: {
        appInfo: { name: 'fixture', version: '1.0.0' },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
        protocolVersion: '2026-01-26',
      },
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 20,
          result: expect.objectContaining({
            hostContext: expect.objectContaining({
              availableDisplayModes: ['inline'],
            }),
          }),
        }),
        '*',
      ),
    );
    send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 21,
      method: 'ui/request-display-mode',
      params: { mode: 'fullscreen' },
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 21, result: { mode: 'inline' } }),
        '*',
      ),
    );
    expect(onDisplayModeDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: 'declined',
        actualMode: 'inline',
        reason: 'host-mode-unavailable',
      }),
    );
  });

  test('displays approval policy as requested but non-enforced when host opted out', async () => {
    mockConfig = { mcpUiHost: false };
    mockResolver({
      success: true,
      data: {
        status: 'success',
        ref: 'github/create_issue',
        serverId: 'github',
        toolName: 'create_issue',
        resourceUri: 'https://example.com/mcp-ui',
      },
    });

    renderFrame({ ref: 'github/create_issue', approvalPolicy: 'require' });

    expect(
      await screen.findByText(
        /Approval policy: require\. Tool calls require approval and are gated through the inbox/,
      ),
    ).toBeTruthy();
  });
});

function renderFrame({
  ref,
  fallbackComponent,
  fallbackComponentName,
  approvalPolicy,
  onResolutionStatus,
  paneIdentity,
  currentDisplayMode,
  hostAvailableDisplayModes,
  onRequestDisplayMode,
  onDisplayModeDecision,
  initialArguments,
  basisReadSession,
  openExternalLink,
  includeThemeToggle = false,
  transcriptResult,
}: {
  ref: string;
  transcriptResult?: MCPToolUIFrameProps['transcriptResult'];
  fallbackComponent?: ReactNode;
  fallbackComponentName?: string;
  approvalPolicy?: 'inherit' | 'require' | 'read-only';
  onResolutionStatus?: (resolution: {
    ref: string;
    status: 'missing_resource' | 'render_revoked';
  }) => void;
  paneIdentity?: MCPAppPanePresentationIdentity;
  currentDisplayMode?: 'inline' | 'fullscreen';
  hostAvailableDisplayModes?: readonly ('inline' | 'fullscreen')[];
  onRequestDisplayMode?: (mode: 'inline' | 'fullscreen') => boolean;
  onDisplayModeDecision?: (decision: MCPAppDisplayModeDecision) => void;
  initialArguments?: Record<string, unknown>;
  includeThemeToggle?: boolean;
  basisReadSession?: {
    serverId: 'station-control';
    toolName: 'get_task_basis';
    taskId: string;
  };
  openExternalLink?: (url: string) => Promise<boolean>;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const renderTree = ({
    displayMode = currentDisplayMode,
    availableModes = hostAvailableDisplayModes,
    requestMode = onRequestDisplayMode,
    basisTaskId,
  }: {
    displayMode?: 'inline' | 'fullscreen';
    availableModes?: readonly ('inline' | 'fullscreen')[];
    requestMode?: ((mode: 'inline' | 'fullscreen') => boolean) | null;
    basisTaskId?: string;
  } = {}) => (
    <QueryClientProvider client={queryClient}>
      {includeThemeToggle ? <ThemeToggle /> : null}
      <MCPToolUIFrame
        component={{
          kind: 'mcp-tool-ui',
          ref,
          approvalPolicy,
          initialArguments: basisTaskId
            ? { taskId: basisTaskId }
            : initialArguments
              ? { ...initialArguments }
              : undefined,
        }}
        transcriptResult={transcriptResult}
        fallbackComponent={fallbackComponent}
        fallbackComponentName={fallbackComponentName}
        onResolutionStatus={onResolutionStatus}
        paneIdentity={paneIdentity}
        currentDisplayMode={displayMode}
        hostAvailableDisplayModes={availableModes}
        onRequestDisplayMode={requestMode ?? undefined}
        onDisplayModeDecision={onDisplayModeDecision}
        openExternalLink={openExternalLink}
        basisReadSession={
          basisTaskId && basisReadSession
            ? { ...basisReadSession, taskId: basisTaskId }
            : basisReadSession
        }
      />
    </QueryClientProvider>
  );
  const result = render(renderTree());
  return {
    ...result,
    queryClient,
    rerenderBasisTask: (basisTaskId: string) =>
      result.rerender(renderTree({ basisTaskId })),
    rerenderDisplayMode: (displayMode: 'inline' | 'fullscreen') =>
      result.rerender(renderTree({ displayMode })),
    rerenderHost: (host: {
      displayMode?: 'inline' | 'fullscreen';
      availableModes?: readonly ('inline' | 'fullscreen')[];
      requestMode?: ((mode: 'inline' | 'fullscreen') => boolean) | null;
    }) => result.rerender(renderTree(host)),
  };
}

function mockResolver(body: unknown) {
  fetchMock.mockResolvedValue({
    ok: true,
    statusText: 'OK',
    json: async () => body,
  });
}

function response(data: unknown, meta?: Record<string, unknown>) {
  return {
    ok: true,
    statusText: 'OK',
    json: async () => ({ success: true, data, ...(meta ? { meta } : {}) }),
  };
}

function renderTranscriptCalls(
  calls: NonNullable<
    React.ComponentProps<typeof MessageContent>['contentParts']
  >,
  foldWork = false,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MessageContent
        contentParts={calls}
        textContent=""
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        isStreamingMessage={false}
        foldWork={foldWork}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}
