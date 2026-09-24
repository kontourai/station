/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));

import BrowserSetup from '../BrowserSetup';

function access(data: object) {
  return vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, data }), { status: 200 }),
  );
}

function renderSetup(transport: ReturnType<typeof access>, onReady = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserSetup
        projectSlug="alpha"
        onReady={onReady}
        transport={transport as never}
      />
    </QueryClientProvider>,
  );
  return onReady;
}

afterEach(() => cleanup());

describe('BrowserSetup (the launcher’s acquisition step)', () => {
  test('a Project admin is told to ask the operator; nothing operator-only is read', async () => {
    const transport = access({
      projectId: 'p-alpha',
      role: 'project-admin',
      operator: false,
      browser: 'not-ready',
    });
    renderSetup(transport);
    expect(
      await screen.findByText(
        'Ask the Station operator to set up the browser.',
      ),
    ).toBeTruthy();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0]![0])).toBe(
      'http://station.test/api/browser/projects/alpha/access',
    );
  });

  test('a browser that became ready says so', async () => {
    renderSetup(
      access({
        projectId: 'p-alpha',
        role: 'operator',
        operator: true,
        browser: 'ready',
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('The browser is ready')).toBeTruthy(),
    );
  });
});
