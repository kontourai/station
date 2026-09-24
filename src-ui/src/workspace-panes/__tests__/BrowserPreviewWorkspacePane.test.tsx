/** @vitest-environment jsdom */

import {
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
} from '@kontourai/station-contracts/workspace-browser-preview';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  boundIdentity: {
    state: 'resolved' as const,
    project: { id: 'project-uuid-1', slug: 'alpha' },
  },
  paneProps: [] as Array<{
    projectSlug: string;
    target: unknown;
    onAttach: (browserSessionId: string) => void;
  }>,
}));

vi.mock('../useWorkspacePaneBoundIdentity', () => ({
  useWorkspacePaneBoundIdentity: () => mocks.boundIdentity,
}));
// The lazily loaded pane is exercised by its own suite; here we observe what
// the registry slot hands it and what it persists when the pane attaches.
vi.mock('../browser-pane/BrowserPane', () => ({
  default: (props: (typeof mocks.paneProps)[number]) => {
    mocks.paneProps.push(props);
    return <div data-testid="browser-pane">{JSON.stringify(props.target)}</div>;
  },
}));

import { BrowserPreviewWorkspacePane } from '../BrowserPreviewWorkspacePane';
import { createBrowserPreviewPaneInstance } from '../browserPreviewPaneInstance';
import { readBrowserPreviewPaneState } from '../browserPreviewPaneStateStorage';

const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';
const NONCE = '0123456789abcdef0123456789abcdef';
const instance = createBrowserPreviewPaneInstance(
  {
    version: '2.0',
    projectId: 'project-uuid-1',
    browserSessionId: SESSION,
    updatedAt: '2026-09-22T12:00:00.000Z',
  },
  'project-uuid-1',
  NONCE,
)!;
const storageKey = `station:browser-preview-pane-state:v1:${encodeURIComponent(instance.stateKey)}`;

function renderSlot() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <BrowserPreviewWorkspacePane
        descriptor={WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR}
        instance={instance}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  mocks.paneProps.length = 0;
});

describe('BrowserPreviewWorkspacePane (v2 renderer in the v1 slot)', () => {
  test('a v2 record renders the pane attached to its server session', async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: '2.0',
        projectId: 'project-uuid-1',
        browserSessionId: SESSION,
        updatedAt: '2026-09-22T12:00:00.000Z',
      }),
    );
    renderSlot();
    await screen.findByTestId('browser-pane');
    expect(mocks.paneProps.at(-1)).toMatchObject({
      projectSlug: 'alpha',
      target: { kind: 'session', browserSessionId: SESSION },
    });
  });

  test('a v1 record is handed over as a migration, and attaching writes v2 in its place', async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
        projectId: 'project-uuid-1',
        requestedUrl: 'http://127.0.0.1:5173/',
        viewportPreference: 'desktop',
        updatedAt: '2026-08-09T12:00:00.000Z',
      }),
    );
    renderSlot();
    await screen.findByTestId('browser-pane');
    const props = mocks.paneProps.at(-1)!;
    expect(props.target).toEqual({
      kind: 'migrate',
      migration: {
        projectId: 'project-uuid-1',
        requestedUrl: 'http://127.0.0.1:5173/',
        viewportPreference: 'desktop',
      },
    });
    props.onAttach(SESSION);
    await waitFor(() =>
      expect(mocks.paneProps.at(-1)?.target).toEqual({
        kind: 'session',
        browserSessionId: SESSION,
      }),
    );
    const stored = readBrowserPreviewPaneState(
      window.localStorage,
      instance.stateKey,
    );
    expect(stored).toMatchObject({
      version: '2.0',
      state: { projectId: 'project-uuid-1', browserSessionId: SESSION },
    });
    // The v1 URL is gone from the device: the session is server-owned now.
    expect(window.localStorage.getItem(storageKey)).not.toContain('5173');
  });

  test('the Add-pane grid occurrence (no stored record) asks for a page, and attaching persists v2 (D3)', async () => {
    renderSlot();
    await screen.findByTestId('browser-pane');
    const props = mocks.paneProps.at(-1)!;
    expect(props.target).toEqual({ kind: 'new' });
    props.onAttach(SESSION);
    await waitFor(() =>
      expect(mocks.paneProps.at(-1)?.target).toEqual({
        kind: 'session',
        browserSessionId: SESSION,
      }),
    );
    expect(
      readBrowserPreviewPaneState(window.localStorage, instance.stateKey),
    ).toMatchObject({
      version: '2.0',
      state: { projectId: 'project-uuid-1', browserSessionId: SESSION },
    });
  });

  test('a stored record for ANOTHER Project is a state mismatch, never a browser', () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: '2.0',
        projectId: 'someone-elses-project',
        browserSessionId: SESSION,
        updatedAt: '2026-09-22T12:00:00.000Z',
      }),
    );
    renderSlot();
    expect(screen.queryByTestId('browser-pane')).toBeNull();
  });
});
