/** @vitest-environment jsdom */
import type { CustomAppearanceDocument } from '@kontourai/station-contracts/custom-appearance';
import {
  customAppearanceKey,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { KeepBarOptions } from '../../../lib/custom-appearance/keep-bar';

const identity = vi.hoisted(() => ({ current: true, host: 'a' }));
const host = {
  apiBase: 'https://station-a.test',
  authorityKey: 'a',
  isCurrent: () => identity.current,
};
const peer = {
  apiBase: 'https://station-b.test',
  authorityKey: 'b',
  isCurrent: () => true,
};
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => (identity.host === 'a' ? host : peer),
}));
const keepBar = vi.hoisted(() => ({
  options: undefined as KeepBarOptions | undefined,
  destroy: vi.fn(),
}));
vi.mock('../../../lib/custom-appearance/keep-bar', () => ({
  KEEP_BAR_TAG: 'station-appearance-preview',
  mountKeepBar: (options: KeepBarOptions) => {
    keepBar.options = options;
    return {
      destroy: keepBar.destroy,
      keepBlockedReason: () => null,
      keepRect: () => new DOMRect(),
    };
  },
}));

import {
  getCustomAppearanceSnapshot,
  setActiveCustomAppearance,
} from '../../../lib/custom-appearance/controller';
import { cancelCustomAppearancePreview } from '../../../lib/custom-appearance/preview';
import { ConversationConnectionProvider } from '../../conversation/ConversationConnectionContext';
import { type ToolCallData, ToolCallDisplay } from '../ToolCallDisplay';
import { foldTurnWork } from '../tool-call-runs';

const proposalId = 'a'.repeat(64);
const appearance = {
  version: 1 as const,
  name: 'Seaside',
  palette: { dark: { accent: '#336699' } },
  css: '',
};
const proposal = {
  id: proposalId,
  name: appearance.name,
  sourceSessionId: 'session-a',
};
let documentState: CustomAppearanceDocument;
let failKeep: boolean;
let holdReport: boolean;
let resolveReport: ((response: Response) => void) | undefined;
let reads: string[];
let writes: { url: string; method: string; body: Record<string, unknown> }[];
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  });
const tool: ToolCallData = {
  type: 'tool-invocation',
  toolCallId: 'call-a',
  toolName: 'mcp__station-control__propose_appearance',
  state: 'result',
  result: '',
  appearanceProposal: proposal,
};

function mount(
  options: {
    scope?: typeof host;
    apiBase?: string;
    sessionId?: string;
    call?: typeof tool;
  } = {},
) {
  const scope = options.scope ?? host;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <ConversationConnectionProvider
        value={{
          apiBase: options.apiBase ?? scope.apiBase,
          requestScope: scope,
        }}
      >
        <ToolCallDisplay
          toolCall={options.call ?? tool}
          sessionId={options.sessionId ?? 'session-a'}
          showDetails={false}
        />
      </ConversationConnectionProvider>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  identity.current = true;
  identity.host = 'a';
  failKeep = false;
  holdReport = false;
  resolveReport = undefined;
  reads = [];
  writes = [];
  keepBar.options = undefined;
  keepBar.destroy.mockClear();
  documentState = {
    revision: 'r1',
    active: null,
    proposal: {
      ...proposal,
      appearance,
      proposedAt: '2026-11-17T00:00:00.000Z',
    },
    renderReport: null,
  };
  class Sheet {
    cssRules: CSSRule[] = [];
    disabled = false;
    replaceSync() {}
  }
  vi.stubGlobal('CSSStyleSheet', Sheet);
  Object.defineProperty(document, 'adoptedStyleSheets', {
    value: [],
    writable: true,
    configurable: true,
  });
  setActiveCustomAppearance(null);
  setClientCredentialResolver((selector) => {
    const scope = String(selector?.url).startsWith(peer.apiBase) ? peer : host;
    return {
      origin: scope.apiBase,
      credential: 'fixture',
      requestAuthority: scope,
    };
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (!init?.method || init.method === 'GET') {
        reads.push(url);
        return response(
          url.endsWith('/feature-previews')
            ? [{ id: 'appearance-studio', enabled: true }]
            : structuredClone(documentState),
        );
      }
      const body = JSON.parse(String(init.body));
      writes.push({ url, method: init.method, body });
      if (url.endsWith('/report') && holdReport) {
        return new Promise<Response>((resolve) => {
          resolveReport = resolve;
        });
      }
      if (url.endsWith('/keep') && failKeep) {
        documentState = {
          ...documentState,
          revision: 'r-server',
          active: { ...appearance, name: 'Saved elsewhere' },
          proposal: null,
        };
        return new Response(
          JSON.stringify({
            success: false,
            error: 'The appearance changed',
            code: 'custom_appearance_conflict',
          }),
          { status: 409 },
        );
      }
      if (url.endsWith('/keep'))
        documentState = {
          ...documentState,
          revision: 'r2',
          active: documentState.proposal!.appearance,
          proposal: null,
        };
      if (init.method === 'DELETE')
        documentState = { ...documentState, revision: 'r2', proposal: null };
      return response(structuredClone(documentState));
    }),
  );
});
afterEach(() => {
  cleanup();
  cancelCustomAppearancePreview();
  setActiveCustomAppearance(null);
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

async function previewButton() {
  const button = await screen.findByRole('button', { name: 'Preview' });
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  return button;
}

test('a retained tool result previews the exact server proposal through the protected countdown and keeps after fresh validation', async () => {
  mount();
  fireEvent.click(await previewButton());
  await waitFor(() => expect(keepBar.options?.name).toBe('Seaside'));
  expect(keepBar.options).toMatchObject({ fromAgent: true, seconds: 20 });
  expect(getCustomAppearanceSnapshot().previewing?.name).toBe('Seaside');
  expect(writes.filter((write) => write.url.endsWith('/keep'))).toHaveLength(0);
  await act(async () => keepBar.options!.onKeep());
  await screen.findByText('Kept');
  expect(writes.find((write) => write.url.endsWith('/keep'))?.body).toEqual({
    revision: 'r1',
    proposalId,
  });
  expect(getCustomAppearanceSnapshot().active?.name).toBe('Seaside');
});

test('Dismiss rechecks the current revision, settles the exact proposal, and preserves the saved appearance', async () => {
  documentState = {
    ...documentState,
    active: { ...appearance, name: 'Before' },
  };
  setActiveCustomAppearance(documentState.active);
  const { client } = mount();
  await previewButton();
  documentState = { ...documentState, revision: 'r-fresh' };
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  await screen.findByText('Dismissed');
  expect(writes).toEqual([
    {
      url: `${host.apiBase}/api/me/appearance/proposal`,
      method: 'DELETE',
      body: { revision: 'r-fresh' },
    },
  ]);
  expect(keepBar.options).toBeUndefined();
  expect(getCustomAppearanceSnapshot().active?.name).toBe('Before');
  expect(
    client.getQueryData<CustomAppearanceDocument>(customAppearanceKey(host))
      ?.proposal,
  ).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test('a newer proposal disables the old card and an action-time replacement is never previewed or dismissed', async () => {
  mount();
  const preview = await previewButton();
  documentState = {
    ...documentState,
    revision: 'r2',
    proposal: {
      ...documentState.proposal!,
      id: 'b'.repeat(64),
      appearance: { ...appearance, name: 'Newer' },
    },
  };
  fireEvent.click(preview);
  await screen.findByText('Appearance proposal could not be updated');
  expect(keepBar.options).toBeUndefined();
  expect(writes).toHaveLength(0);
  expect(
    (screen.getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText('Superseded')).toBeTruthy();
});

test('a failed Keep reloads the saved server appearance and clears the optimistic proposal', async () => {
  failKeep = true;
  mount();
  fireEvent.click(await previewButton());
  await waitFor(() => expect(keepBar.options).toBeDefined());
  await act(async () => keepBar.options!.onKeep());
  await screen.findByText('Appearance proposal could not be updated');
  expect(getCustomAppearanceSnapshot().active?.name).toBe('Saved elsewhere');
  expect(getCustomAppearanceSnapshot().previewing).toBeNull();
  expect(
    reads.filter((url) => url.endsWith('/appearance')).length,
  ).toBeGreaterThanOrEqual(4);
});

test.each([
  { scope: peer, apiBase: peer.apiBase },
  { scope: host, apiBase: `${host.apiBase}/api/environments/peer/chat-api` },
])(
  'a non-host conversation never reads or acts on host appearance: %j',
  async (target) => {
    mount(target);
    await screen.findByText(
      'Switch to this Station to preview its appearance.',
    );
    expect(reads).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(keepBar.options).toBeUndefined();
    expect(writes).toHaveLength(0);
  },
);

test('a colliding proposal ID from another Session cannot be previewed', async () => {
  documentState = {
    ...documentState,
    proposal: { ...documentState.proposal!, sourceSessionId: 'session-other' },
  };
  mount();
  await screen.findByText('Superseded');
  expect(
    (screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(writes).toHaveLength(0);
});

test('revoking the shell lease cancels its preview and a late Keep cannot write', async () => {
  mount();
  fireEvent.click(await previewButton());
  await waitFor(() => expect(keepBar.options).toBeDefined());
  const options = keepBar.options!;
  identity.current = false;
  await waitFor(() =>
    expect(getCustomAppearanceSnapshot().previewing).toBeNull(),
  );
  await act(async () => options.onKeep());
  expect(writes.filter((write) => write.url.endsWith('/keep'))).toHaveLength(0);
});

test('a late render report cannot restore a pending proposal after Keep', async () => {
  holdReport = true;
  const { client } = mount();
  fireEvent.click(await previewButton());
  await waitFor(() => expect(resolveReport).toBeDefined());
  const reportDocument = structuredClone(documentState);
  await act(async () => keepBar.options!.onKeep());
  await screen.findByText('Kept');
  await act(async () => resolveReport!(response(reportDocument)));
  expect(
    client.getQueryData<CustomAppearanceDocument>(customAppearanceKey(host))
      ?.proposal,
  ).toBeNull();
  expect(
    client.getQueryData<CustomAppearanceDocument>(customAppearanceKey(host))
      ?.active?.name,
  ).toBe('Seaside');
});

test('a qualified tool name stays actionable when a provider also includes its bare original name', async () => {
  mount({ call: { ...tool, originalName: 'propose_appearance' } });
  expect(await previewButton()).toBeTruthy();
});

test('a tool from another server cannot create an appearance card and mobile work folding preserves the real proposal row', () => {
  mount({ call: { ...tool, toolName: 'mcp__other__propose_appearance' } });
  expect(
    screen.queryByRole('region', { name: 'Appearance proposal' }),
  ).toBeNull();
  const ordinary = {
    type: 'tool-invocation',
    toolCallId: 'read',
    toolName: 'read_file',
    result: 'ok',
  };
  const blocks = foldTurnWork([
    ordinary,
    { type: 'text', content: 'Before' },
    { ...tool },
    { type: 'text', content: 'After' },
    { ...ordinary, toolCallId: 'last' },
  ]);
  expect(
    blocks.some((block) => {
      if (block.type !== 'tool-call-run' || block.calls.length !== 1)
        return false;
      const part = block.calls[0]?.part;
      return (
        !!part && 'toolCallId' in part && part.toolCallId === tool.toolCallId
      );
    }),
  ).toBe(true);
});
