/** @vitest-environment jsdom */
import type { OperatorSetupReceipt } from '@kontourai/station-contracts/project';
import { _setApiBase } from '@kontourai/station-sdk';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ProjectOperatorSetup } from '../ProjectOperatorSetup';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  sessionStorage.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test.each(['succeeded', 'uncertain'] as const)(
  'setup previews before separate authorization and recovers a lost run response as %s after remount without rerunning',
  async (outcome) => {
    const authority = {
      apiBase: 'http://station.test',
      authorityKey: 'operator',
      draftRecoveryKey: 'fixture',
      isCurrent: () => true,
    };
    _setApiBase(authority.apiBase);
    setClientCredentialResolver(() => ({
      origin: authority.apiBase,
      requestAuthority: authority,
    }));
    let receipt: OperatorSetupReceipt | undefined;
    let runs = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/preview') && init?.method === 'POST') {
          const request = JSON.parse(String(init.body));
          receipt = {
            id: request.id,
            projectId: 'project-id',
            projectSlug: 'setup',
            cwd: '/host/selected-checkout',
            command: request.command,
            inputs: [{ path: 'package.json', sha256: 'a'.repeat(64) }],
            sourceCommit: 'b'.repeat(40),
            inputDigest: 'c'.repeat(64),
            timeoutSeconds: request.timeoutSeconds,
            phase: 'previewed',
            updatedAt: '2026-10-22T00:00:00.000Z',
          };
        } else if (path.endsWith('/run') && init?.method === 'POST') {
          expect(JSON.parse(String(init.body))).toEqual({ authorize: true });
          if (!receipt) throw new Error('no preview');
          receipt = {
            ...receipt,
            phase: outcome,
            exitCode: outcome === 'succeeded' ? 0 : undefined,
          };
          runs++;
          throw new TypeError('response lost');
        } else if (
          init?.method !== 'GET' ||
          !receipt ||
          !path.endsWith(receipt.id)
        )
          throw new Error(`Unexpected setup request ${init?.method} ${path}`);
        return new Response(JSON.stringify({ success: true, data: receipt }));
      }),
    );
    const mount = () => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      });
      clients.push(client);
      return render(
        <QueryClientProvider client={client}>
          <ProjectOperatorSetup
            slug="setup"
            projectId="project-id"
            authority={authority}
          />
        </QueryClientProvider>,
      );
    };
    let view = mount();
    fireEvent.click(
      screen.getByText('Optional repository setup', { exact: true }),
    );
    fireEvent.change(screen.getByLabelText('Setup command'), {
      target: { value: 'npm ci' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview setup' }));
    await screen.findByText('Setup: previewed');
    expect(runs).toBe(0);
    const diagnostics = screen
      .getByText('Setup diagnostics')
      .closest('details');
    expect(diagnostics).not.toBeNull();
    expect(diagnostics?.open).toBe(false);
    expect(
      screen.getByText('a'.repeat(64), { exact: false }).closest('details'),
    ).toBe(diagnostics);
    expect(
      screen.getByText('npm ci', { selector: 'pre' }).closest('details'),
    ).not.toBe(diagnostics);
    expect(
      screen.getByText(/Station does not sandbox it/).closest('details'),
    ).not.toBe(diagnostics);
    fireEvent.click(screen.getByText('Setup diagnostics'));
    expect(diagnostics?.open).toBe(true);
    expect(
      screen
        .getByRole('button', { name: 'Run reviewed setup' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(
      screen.getByLabelText('I authorize this exact command on this Station.'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run reviewed setup' }));
    await waitFor(() => expect(runs).toBe(1));
    view.unmount();
    view = mount();
    await screen.findByText(`Setup: ${outcome}`);
    if (outcome === 'uncertain') {
      const warning = screen.getByText(/The command may still be running/);
      expect(
        warning.closest('details')?.querySelector(':scope > summary')
          ?.textContent,
      ).toBe('Optional repository setup');
      expect(warning.textContent).toContain(
        'This operation will not run again.',
      );
    }
    expect(
      screen.queryByRole('button', { name: 'Run reviewed setup' }),
    ).toBeNull();
    expect(runs).toBe(1);
    view.unmount();
  },
);
