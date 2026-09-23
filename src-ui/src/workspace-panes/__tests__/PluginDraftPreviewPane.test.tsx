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
  apiBase: 'http://localhost:3000',
}));

vi.mock('../../platform/native', () => ({
  nativePlatformPromise: Promise.resolve({ platform: 'web' }),
}));

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: mocks.apiBase }),
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
const LIFETIME = 'a1b2c3d4e5f6';

function digestFor(generation: number, lifetime = LIFETIME): string {
  return `${lifetime}${String(generation).padStart(4, '0')}`.padEnd(32, 'f');
}

function keyFor(generation: number, lifetime = LIFETIME): string {
  return `${DRAFT_ID}:${lifetime}:${generation}`;
}

function status(
  generation: number | null,
  lifetime = LIFETIME,
): PluginDraftStatus {
  return {
    projectSlug: 'demo',
    draftId: DRAFT_ID,
    state: 'ready',
    generation,
    ...(generation
      ? {
          registrationKey: keyFor(generation, lifetime),
          digest: digestFor(generation, lifetime),
        }
      : {}),
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
async function completeDraftLoad(
  generation: number,
  label: string,
  lifetime = LIFETIME,
  project = 'demo',
) {
  const key = keyFor(generation, lifetime);
  let script: HTMLScriptElement | undefined;
  await waitFor(() => {
    script = draftScripts().find(
      (node) => node.getAttribute('data-station-plugin-draft') === key,
    );
    expect(script).toBeDefined();
  });
  expect(script!.getAttribute('src')).toBe(
    `${SAME_ORIGIN}/api/projects/${project}/plugin-draft/generations/${generation}/${digestFor(generation, lifetime)}/bundle.js`,
  );
  (window as any).__station_ai_plugin_drafts ??= {};
  (window as any).__station_ai_plugin_drafts[key] = {
    components: { pulse: () => <p>{label}</p> },
  };
  await act(async () => {
    script!.dispatchEvent(new Event('load'));
  });
}

function renderPane(client = new QueryClient(), projectSlug = 'demo') {
  const view = render(
    <QueryClientProvider client={client}>
      <PluginDraftPreviewPane projectSlug={projectSlug} />
    </QueryClientProvider>,
  );
  return {
    client,
    ...view,
    rerenderWith: (slug: string) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <PluginDraftPreviewPane projectSlug={slug} />
        </QueryClientProvider>,
      ),
  };
}

let leaseRefused = false;

beforeEach(() => {
  currentStatus = status(1);
  leaseRefused = false;
  mocks.apiBase = SAME_ORIGIN;
  mocks.boundaryIdentities.length = 0;
  pluginRegistry.setApiBase(SAME_ORIGIN);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/plugin-draft/lease'))
      return leaseRefused
        ? new Response('{"error":{"code":"insufficient_scope"}}', {
            status: 403,
          })
        : new Response(JSON.stringify(currentStatus));
    if (url.endsWith('/plugin-draft'))
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
    await waitFor(() =>
      expect((run as HTMLButtonElement).disabled).toBe(false),
    );
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
    await waitFor(() =>
      expect((run as HTMLButtonElement).disabled).toBe(false),
    );
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
    await waitFor(() =>
      expect((run as HTMLButtonElement).disabled).toBe(false),
    );
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
      (window as any).__station_ai_plugin_drafts[keyFor(1)],
    ).toBeUndefined();
    expect(
      draftScripts().map((node) =>
        node.getAttribute('data-station-plugin-draft'),
      ),
    ).toEqual([keyFor(2)]);
  });

  test('another viewer or tab starts inert, and the opt-in is stored nowhere', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const first = renderPane();
    const run = await screen.findByRole('button', { name: 'Run revision 1' });
    await waitFor(() =>
      expect((run as HTMLButtonElement).disabled).toBe(false),
    );
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
    await waitFor(() =>
      expect((run as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(run);
    await completeDraftLoad(1, 'draft pulse 1');
    await screen.findByText('draft pulse 1');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await screen.findByText(PLUGIN_DRAFT_DISCLOSURE);
    expect(screen.queryByText('draft pulse 1')).toBeNull();
    expect(draftScripts()).toEqual([]);
    expect(
      (window as any).__station_ai_plugin_drafts[keyFor(1)],
    ).toBeUndefined();
  });

  // S3 review HIGH-3: the pane's occurrence id is the same in every Project,
  // so a host may re-render it for another Project. A choice made in one
  // Project must never become a load of another Project's bundle.
  test.each([
    ['another Project', () => ({ slug: 'other' })],
    [
      'another Station connection',
      () => ({ apiBase: 'http://127.0.0.1:3999' }),
    ],
  ])(
    'a pane re-rendered for %s starts inert and injects nothing',
    async (_label, change) => {
      const view = renderPane();
      const run = await screen.findByRole('button', { name: 'Run revision 1' });
      await waitFor(() =>
        expect((run as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(run);
      await completeDraftLoad(1, 'draft pulse 1');
      await screen.findByText('draft pulse 1');
      const scriptsBefore = draftScripts().length;

      const next = change() as { slug?: string; apiBase?: string };
      if (next.apiBase) {
        mocks.apiBase = next.apiBase;
        pluginRegistry.setApiBase(next.apiBase);
      }
      view.rerenderWith(next.slug ?? 'demo');
      await screen.findByText(PLUGIN_DRAFT_DISCLOSURE);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(screen.queryByText('draft pulse 1')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
      // Nothing new was injected, and the previous revision was unloaded.
      expect(draftScripts().length).toBeLessThanOrEqual(scriptsBefore);
      expect(
        draftScripts().some(
          (node) =>
            node.getAttribute('src')?.includes('/projects/other/') ||
            !node.getAttribute('src')?.startsWith(SAME_ORIGIN),
        ),
      ).toBe(false);
      expect(draftScripts()).toEqual([]);
    },
  );

  // Coming BACK to the Project a revision was chosen in is a new visit: the
  // earlier choice does not survive the round trip and re-run on its own.
  test('switching away and back does not resume a revision without a click', async () => {
    const view = renderPane();
    const run = await screen.findByRole('button', { name: 'Run revision 1' });
    await waitFor(() =>
      expect((run as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(run);
    await completeDraftLoad(1, 'draft pulse 1');
    await screen.findByText('draft pulse 1');

    view.rerenderWith('other');
    await screen.findByText(PLUGIN_DRAFT_DISCLOSURE);
    view.rerenderWith('demo');
    await screen.findByText(PLUGIN_DRAFT_DISCLOSURE);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(draftScripts()).toEqual([]);
  });

  // S3 review MEDIUM-1: after a server restart the counter starts over. The
  // pane compares the whole revision identity, so a new lifetime's revision 1
  // is offered as new (not hidden behind "1 < 2") and still needs a click.
  test('a revision from a new server lifetime is offered, not hidden or auto-run', async () => {
    currentStatus = status(2);
    const { client } = renderPane();
    const run = await screen.findByRole('button', { name: 'Run revision 2' });
    await waitFor(() =>
      expect((run as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(run);
    await completeDraftLoad(2, 'old lifetime 2');
    await screen.findByText('old lifetime 2');

    currentStatus = status(1, 'ffeeddccbbaa');
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['plugin-draft'] });
    });
    expect(
      await screen.findByRole('button', { name: 'Run revision 1' }),
    ).toBeTruthy();
    expect(screen.getByText('old lifetime 2')).toBeTruthy();
    expect(
      draftScripts().some((node) =>
        node.getAttribute('src')?.includes('/generations/1/'),
      ),
    ).toBe(false);
  });

  // S3 review LOW (d): a read-only paired device cannot start a lease (it
  // makes the host build). It reads status instead and says why.
  test('a device that cannot start a lease reads status and explains', async () => {
    leaseRefused = true;
    renderPane();
    expect(
      await screen.findByText(/can’t start a preview from this device/),
    ).toBeTruthy();
    expect(screen.getByText(PLUGIN_DRAFT_DISCLOSURE)).toBeTruthy();
    expect(requestedUrls()).toContain(
      `${SAME_ORIGIN}/api/projects/demo/plugin-draft`,
    );
    expect(draftScripts()).toEqual([]);
  });

  // Round 2 LOW-3: when automatic change detection is off, the pane says so
  // and offers a manual Rebuild, which builds and never runs anything.
  test('says when automatic rebuilds are off and rebuilds on request without running', async () => {
    currentStatus = {
      ...status(1),
      watch: { native: true, polling: false, reason: 'more than 2000 entries' },
    };
    renderPane();
    expect(
      await screen.findByText(/Automatic rebuilds may not happen/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/plugin-draft/lease') &&
            (init as RequestInit | undefined)?.body ===
              JSON.stringify({ rebuild: true }),
        ),
      ).toBe(true),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(draftScripts()).toEqual([]);
  });
});
