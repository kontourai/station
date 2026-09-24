/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import { BrowserPreviewPaneLauncher } from '../BrowserPreviewPaneLauncher';
import { readBrowserPreviewPaneState } from '../browserPreviewPaneStateStorage';
import type { WorkspacePaneHostOpenAction } from '../WorkspacePaneHostOpenContext';
import {
  WORKSPACE_PANE_OPENED,
  workspacePaneOpenRefused,
} from '../workspacePaneHostOpenOutcome';

const AVAILABLE = {
  state: 'available' as const,
  reason: { code: 'ready' as const, source: 'resolver' as const },
};
const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';

function transportAnswering(status: number, body: unknown) {
  return vi.fn(
    async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
}

function renderLauncher(
  host: WorkspacePaneHostOpenAction | null,
  transport: (input: unknown, init?: RequestInit) => Promise<Response>,
  availability = AVAILABLE as Parameters<
    typeof BrowserPreviewPaneLauncher
  >[0]['availability'],
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserPreviewPaneLauncher
        projectId="project-uuid-1"
        projectSlug="alpha"
        host={host}
        availability={availability}
        transport={transport as never}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('BrowserPreviewPaneLauncher', () => {
  test('opens a server session for the address, then a pane attached to it', async () => {
    // `satisfies` pins the fake to the real contract (#1596).
    const open = vi.fn(((_instance, preparation) =>
      preparation?.prepare() === false
        ? workspacePaneOpenRefused('not-persisted')
        : WORKSPACE_PANE_OPENED) satisfies WorkspacePaneHostOpenAction['open']);
    const transport = transportAnswering(201, {
      success: true,
      data: { browserSessionId: SESSION },
    });
    renderLauncher({ open }, transport);
    fireEvent.change(screen.getByLabelText('Browser address'), {
      target: { value: 'example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Browser' }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    const [url, init] = transport.mock.calls[0]!;
    expect(String(url)).toBe('http://station.test/api/browser/sessions');
    expect(JSON.parse(String(init?.body))).toEqual({
      projectSlug: 'alpha',
      url: 'example.com',
    });
    const instance = open.mock.calls[0]![0];
    expect(
      readBrowserPreviewPaneState(window.localStorage, instance.stateKey),
    ).toMatchObject({
      version: '2.0',
      state: { projectId: 'project-uuid-1', browserSessionId: SESSION },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test("shows the server's refusal and opens nothing", async () => {
    const open = vi.fn();
    renderLauncher(
      { open },
      transportAnswering(400, {
        success: false,
        code: 'url-not-allowed',
        detail: { urlRejection: 'unsupported-scheme' },
      }),
    );
    fireEvent.change(screen.getByLabelText('Browser address'), {
      target: { value: 'chrome://settings' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Browser' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Station can't open chrome: URLs. Only http and https pages open here.",
    );
    expect(open).not.toHaveBeenCalled();
  });

  test('a Station without the browser routes and a caller without standing are each told so (S3)', async () => {
    const open = vi.fn();
    renderLauncher({ open }, transportAnswering(404, 'Not Found'));
    fireEvent.click(screen.getByRole('button', { name: 'Open Browser' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "The browser isn't available on this Station.",
    );
    cleanup();
    renderLauncher(
      { open },
      transportAnswering(403, { success: false, code: 'access-denied' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Browser' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Only the Station operator and this Project's admins can open a browser here.",
    );
    expect(open).not.toHaveBeenCalled();
  });

  test('a session the pane host refused to show is closed again, not left running (S8)', async () => {
    const open = vi.fn((() =>
      workspacePaneOpenRefused(
        'no-lease',
      )) satisfies WorkspacePaneHostOpenAction['open']);
    const transport = vi.fn(async (_input: unknown, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? new Response(JSON.stringify({ success: true, data: {} }))
        : new Response(
            JSON.stringify({
              success: true,
              data: { browserSessionId: SESSION },
            }),
            { status: 201 },
          ),
    );
    renderLauncher({ open }, transport);
    fireEvent.click(screen.getByRole('button', { name: 'Open Browser' }));
    await waitFor(() =>
      expect(
        transport.mock.calls.some(
          ([url, init]) =>
            init?.method === 'DELETE' &&
            String(url) ===
              `http://station.test/api/browser/sessions/${SESSION}`,
        ),
      ).toBe(true),
    );
    // And with no pane host at all.
    cleanup();
    transport.mockClear();
    renderLauncher(null, transport, AVAILABLE);
    // The form is disabled without a host, so nothing is created at all.
    expect(screen.getByRole('button', { name: 'Open Browser' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  test('reports the reason the host refused, not one sentence for every refusal', async () => {
    const open = vi.fn((() =>
      workspacePaneOpenRefused(
        'no-lease',
      )) satisfies WorkspacePaneHostOpenAction['open']);
    renderLauncher(
      { open },
      transportAnswering(201, {
        success: true,
        data: { browserSessionId: SESSION },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Browser' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This tab cannot save workspace changes right now, so the pane was not opened.',
    );
  });

  test('a Station with no browser yet shows the operator the consented download instead of failing', async () => {
    const open = vi.fn();
    const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const reply = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      if (path === '/api/browser/sessions' && init?.method === 'POST')
        return reply(409, { success: false, code: 'browser-unavailable' });
      if (path === '/api/browser/projects/alpha/access')
        return reply(200, {
          success: true,
          data: {
            projectId: 'project-uuid-1',
            role: 'operator',
            operator: true,
            browser: 'not-ready',
          },
        });
      if (path === '/api/browser/acquisition')
        return reply(200, {
          success: true,
          data: {
            state: 'needs-consent',
            version: '140.0.1',
            downloadBytes: 152_000_000,
          },
        });
      return reply(599, {});
    });
    renderLauncher({ open }, transport);
    fireEvent.click(screen.getByRole('button', { name: 'Open Browser' }));
    expect(
      await screen.findByRole('button', { name: 'Download Chromium (152 MB)' }),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  test('keeps creation disabled with the catalog-resolved unavailable reason', () => {
    const open = vi.fn();
    const transport = transportAnswering(201, {});
    renderLauncher({ open }, transport, {
      state: 'temporarily-unavailable',
      reason: { code: 'health-unavailable', source: 'health' },
    } as never);
    const button = screen.getByRole('button', { name: 'Open Browser' });
    expect(button).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain(
      'temporarily unavailable',
    );
    fireEvent.click(button);
    expect(transport).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
