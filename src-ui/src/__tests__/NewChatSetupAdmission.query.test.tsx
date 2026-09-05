// @vitest-environment jsdom
import {
  _setApiBase,
  setClientCredentialResolver,
} from '@kontourai/station-sdk';
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NewChatModal } from '../components/modals/NewChatModal';
import type { AgentData } from '../contexts/AgentsContext';
import { bannerStore, useBanners } from '../contexts/banner-store';
import { NavigationProvider } from '../contexts/NavigationContext';
import { navigationStore } from '../contexts/navigation-store';
import type { ProjectMetadata } from '../contexts/ProjectsContext';

vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => undefined }));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));
const NEEDS = {
  slug: 'needs-setup',
  name: 'Needs setup',
  available: false,
  unavailableReason: 'Connect a Model',
  unavailableFix: { kind: 'model-connection' },
  model: 'old',
  modelOptions: [{ id: 'old', name: 'Old model' }],
} as AgentData;
const OLD_READY = {
  ...NEEDS,
  slug: 'other',
  name: 'Other',
  available: true,
  unavailableReason: undefined,
  unavailableFix: undefined,
} as AgentData;
const PROJECT = {
  slug: 'alpha',
  name: 'Alpha',
  workingDirectory: '/fixture/alpha',
  layoutCount: 0,
} as ProjectMetadata;
const authority = {
  apiBase: 'https://station.test',
  authorityKey: 'a:1',
  isCurrent: () => true,
};
function BannerControls() {
  return (
    <>
      {useBanners().flatMap(
        (banner) =>
          banner.actions?.map((action) => (
            <button key={action.label} type="button" onClick={action.onClick}>
              {action.label}
            </button>
          )) || [],
      )}
    </>
  );
}
beforeEach(() => {
  _setApiBase('https://station.test');
  setClientCredentialResolver(undefined);
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  Element.prototype.scrollIntoView = vi.fn();
  navigationStore.navigate('/');
});
afterEach(() => {
  cleanup();
  bannerStore.clear();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
  _setApiBase('');
});

test('real SDK observers cannot admit stale ready rows when notifications lag failed refetch', async () => {
  let stage: 'initial' | 'offline' | 'changed' = 'initial';
  const fresh = {
    ...OLD_READY,
    available: false,
    unavailableReason: 'Permission revoked',
    unavailableFix: { kind: 'policy' },
    model: 'new',
    modelOptions: [{ id: 'new', name: 'New model' }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      ).pathname;
      if (path === '/api/agents' && stage === 'offline')
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Catalog temporarily unavailable',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      let data: unknown = [];
      if (path === '/api/agents')
        data = stage === 'changed' ? [NEEDS, fresh] : [NEEDS, OLD_READY];
      if (path === '/api/projects') data = [PROJECT];
      if (path === '/api/projects/alpha')
        data = { ...PROJECT, agents: ['needs-setup', 'other'] };
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const onSelect = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <NavigationProvider>
        <NewChatModal
          agents={[NEEDS, OLD_READY]}
          projects={[PROJECT]}
          activeProjectSlug="alpha"
          onSelect={onSelect}
          onClose={vi.fn()}
          requestAuthority={authority}
        />
        <BannerControls />
      </NavigationProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(
    (client.getQueryData(['agents']) as { agents: AgentData[] }).agents[1]
      .available,
  ).toBe(true);
  expect(
    view.container.querySelector<HTMLButtonElement>('[data-agent-slug="other"]')
      ?.disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Connect Needs setup' }));
  await screen.findByRole('button', { name: 'Return to New Chat' });
  const queued: Array<() => void> = [];
  notifyManager.setScheduler((callback) => queued.push(callback));
  vi.useFakeTimers();
  stage = 'offline';
  fireEvent.click(screen.getByRole('button', { name: 'Return to New Chat' }));
  expect(screen.queryByRole('dialog', { name: 'New Chat' })).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(client.getQueryState(['agents'])?.status).toBe('error');
  expect(queued.length).toBeGreaterThan(0);
  expect(screen.getByText("Couldn't recheck chat setup")).toBeTruthy();
  expect(view.container.querySelector('[data-agent-slug="other"]')).toBeNull();
  expect(onSelect).not.toHaveBeenCalled();
  // Caller props still contain OLD_READY. A successful retry must consume the
  // SDK's fresh same-ID projection before queued observer notifications run.
  stage = 'changed';
  fireEvent.click(screen.getByRole('button', { name: 'Retry connections' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(
    view.container.querySelector<HTMLButtonElement>('[data-agent-slug="other"]')
      ?.disabled,
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'Model: New' })).toBeTruthy();
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => {
    queued.splice(0).forEach((callback) => callback());
  });
  client.clear();
});
