/**
 * @vitest-environment jsdom
 *
 * Epic #2323 S3 — the Plugin preview pane's guardrail, over the REAL
 * in-process loader (`pluginRegistry.loadDraftBundle`, the same script
 * injection installed bundles use).
 *
 * jsdom never executes an external `<script src>`, so — exactly as
 * `PluginRegistry.csp.test.ts` does — the browser's part is stood in for by
 * evaluating the registration the bundle's footer would write and then
 * dispatching `load`. Everything before that point is real: which URL is
 * requested, when, and whether a script element exists at all.
 *
 * The SDK boundary and LayoutRenderer are reduced to pass-throughs (the same
 * reductions `ProjectLayoutRenderer.test.tsx` and
 * `WorkspacePaneRouteView.test.tsx` use); the boundary records the identity
 * it was handed so the test can assert a draft carries no installed plugin's.
 */
import type { PluginDraftStatus } from '@kontourai/station-contracts/plugin-draft';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SAME_ORIGIN = 'http://localhost:3000';

const mocks = vi.hoisted(() => ({
  boundaryIdentities: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../platform/native', () => ({
  nativePlatformPromise: Promise.resolve({ platform: 'web' }),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3000' }),
}));

vi.mock('../PluginWorkspacePaneSDKBoundary', () => ({
  PluginWorkspacePaneSDKBoundary: ({
    children,
    ...identity
  }: {
    children: ReactNode;
  } & Record<string, unknown>) => {
    mocks.boundaryIdentities.push(identity);
    return children;
  },
}));

vi.mock('../../layouts', () => ({
  LayoutRenderer: ({
    trustedPluginLayout: Draft,
  }: {
    trustedPluginLayout: () => ReactNode;
  }) => <Draft />,
}));

import { pluginRegistry } from '../../core/PluginRegistry';
import {
  PLUGIN_DRAFT_DISCLOSURE,
  PluginDraftPreviewPane,
} from '../PluginDraftPreviewPane';

const DRAFT_ID = 'draft_0123456789abcdef0123456789abcdef';

function status(generation: number | null): PluginDraftStatus {
  return {
    projectSlug: 'demo',
    draftId: DRAFT_ID,
    state: 'ready',
    generation,
    ...(generation ? { registrationKey: `${DRAFT_ID}:${generation}` } : {}),
    hasCss: false,
    pluginName: 'connected-pulse',
    pluginVersion: '1.0.0',
    panes: [
      {
        id: 'pane:plugin%3Aconnected-pulse:pulse:workspace',
        name: 'Connected Pulse',
        component: 'pulse',
      },
    ],
    diagnostics: [],
  };
}

let currentStatus = status(1);
let fetchMock: ReturnType<typeof vi.fn>;

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

function draftScripts(): HTMLScriptElement[] {
  return [
    ...document.head.querySelectorAll<HTMLScriptElement>(
      'script[data-station-plugin-draft]',
    ),
  ];
}

/** The browser's part of a same-origin script load, stood in for. */
async function completeDraftLoad(generation: number, label: string) {
  const key = `${DRAFT_ID}:${generation}`;
  let script: HTMLScriptElement | undefined;
  await waitFor(() => {
    script = draftScripts().find(
      (node) => node.getAttribute('data-station-plugin-draft') === key,
    );
    expect(script).toBeDefined();
  });
  expect(script!.getAttribute('src')).toBe(
    `${SAME_ORIGIN}/api/projects/demo/plugin-draft/generations/${generation}/bundle.js`,
  );
  (window as any).__station_ai_plugin_drafts ??= {};
  (window as any).__station_ai_plugin_drafts[key] = {
    components: { pulse: () => <p>{label}</p> },
  };
  await act(async () => {
    script!.dispatchEvent(new Event('load'));
  });
}

function renderPane(client = new QueryClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <PluginDraftPreviewPane projectSlug="demo" />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  currentStatus = status(1);
  mocks.boundaryIdentities.length = 0;
  pluginRegistry.setApiBase(SAME_ORIGIN);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/plugin-draft/lease'))
      return new Response(JSON.stringify(currentStatus));
    return new Response('unexpected', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.head
    .querySelectorAll('[data-station-plugin-draft]')
    .forEach((node) => node.remove());
  delete (window as any).__station_ai_plugin_drafts;
  delete (window as any).__station_ai_plugins;
});

describe('Plugin preview pane guardrail', () => {
  test('opening the pane fetches and executes no draft code', async () => {
    renderPane();
    await screen.findByText(PLUGIN_DRAFT_DISCLOSURE);
    const run = await screen.findByRole('button', { name: 'Run revision 1' });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    // Give any eager loader every chance to misbehave.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(requestedUrls().every((url) => url.endsWith('/lease'))).toBe(true);
    expect(draftScripts()).toEqual([]);
    expect((window as any).__station_ai_plugin_drafts).toBeUndefined();
  });

  test('the click runs that revision in-process, without touching an installed plugin of the same name', async () => {
    const installed = { components: { pulse: () => <p>installed pulse</p> } };
    (window as any).__station_ai_plugins = { 'connected-pulse': installed };
    renderPane();
    const run = await screen.findByRole('button', { name: 'Run revision 1' });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    await completeDraftLoad(1, 'draft pulse 1');

    expect(await screen.findByText('draft pulse 1')).toBeTruthy();
    expect(screen.queryByText('installed pulse')).toBeNull();
    expect((window as any).__station_ai_plugins).toEqual({
      'connected-pulse': installed,
    });
    // A draft carries no installed plugin's request identity.
    expect(mocks.boundaryIdentities.at(-1)).toMatchObject({
      projectSlug: 'demo',
    });
    expect(mocks.boundaryIdentities.at(-1)?.pluginName).toBeUndefined();
  });

  test('a new revision shows a one-click bar and does not run on its own', async () => {
    const { client } = renderPane();
    const run = await screen.findByRole('button', { name: 'Run revision 1' });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    await completeDraftLoad(1, 'draft pulse 1');
    await screen.findByText('draft pulse 1');

    currentStatus = status(2);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['plugin-draft'] });
    });
    const runNext = await screen.findByRole('button', {
      name: 'Run revision 2',
    });
    expect(screen.getByText('Revision 2 ready.')).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // Still revision 1, and revision 2 was never requested.
    expect(screen.getByText('draft pulse 1')).toBeTruthy();
    expect(
      draftScripts().some((node) =>
        node.getAttribute('src')?.includes('/generations/2/'),
      ),
    ).toBe(false);

    fireEvent.click(runNext);
    await completeDraftLoad(2, 'draft pulse 2');
    expect(await screen.findByText('draft pulse 2')).toBeTruthy();
    expect(screen.queryByText('draft pulse 1')).toBeNull();
    // Replacing a revision unloads the previous one's registration and nodes.
    expect(
      (window as any).__station_ai_plugin_drafts[`${DRAFT_ID}:1`],
    ).toBeUndefined();
    expect(
      draftScripts().map((node) =>
        node.getAttribute('data-station-plugin-draft'),
      ),
    ).toEqual([`${DRAFT_ID}:2`]);
  });

  test('another viewer or tab starts inert, and the opt-in is stored nowhere', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const first = renderPane();
    const run = await screen.findByRole('button', { name: 'Run revision 1' });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    await completeDraftLoad(1, 'draft pulse 1');
    await screen.findByText('draft pulse 1');

    // A second viewer of the same Project in this document.
    const second = render(
      <QueryClientProvider client={new QueryClient()}>
        <PluginDraftPreviewPane projectSlug="demo" />
      </QueryClientProvider>,
    );
    const secondPane = within(second.container);
    expect(
      await secondPane.findByRole('button', { name: 'Run revision 1' }),
    ).toBeTruthy();
    expect(secondPane.getByText(PLUGIN_DRAFT_DISCLOSURE)).toBeTruthy();
    expect(secondPane.queryByText('draft pulse 1')).toBeNull();
    expect(secondPane.queryByRole('button', { name: 'Stop' })).toBeNull();
    second.unmount();

    // A reload (a fresh mount) starts inert too.
    first.unmount();
    renderPane();
    await screen.findByText(PLUGIN_DRAFT_DISCLOSURE);
    expect(screen.queryByText('draft pulse 1')).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  test('stopping unloads the revision', async () => {
    renderPane();
    const run = await screen.findByRole('button', { name: 'Run revision 1' });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
    await completeDraftLoad(1, 'draft pulse 1');
    await screen.findByText('draft pulse 1');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText(PLUGIN_DRAFT_DISCLOSURE);
    expect(screen.queryByText('draft pulse 1')).toBeNull();
    expect(draftScripts()).toEqual([]);
    expect(
      (window as any).__station_ai_plugin_drafts[`${DRAFT_ID}:1`],
    ).toBeUndefined();
  });
});
