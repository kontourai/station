/** @vitest-environment jsdom */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_WORKING_CONFIGURATION_PREVIEW } from '@kontourai/station-contracts/project-working-configuration';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../../src-server/__test-utils__/temp-dirs.js';
import { createProjectWorkingConfigurationRoutes } from '../../../../../src-server/routes/projects/project-working-configuration-routes.js';
import { ProjectWorkingConfigurationService } from '../../../../../src-server/services/projects/project-working-configuration.js';
import { ProjectWorkingConfiguration } from '../ProjectWorkingConfiguration';

const flags = vi.hoisted(() => new Set<string>());
vi.mock('../../../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => flags,
}));
const makeTempDir = trackTempDirs();
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  flags.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('the real Sources editor applies reviewed defaults once, retains edits on rediscovery, and refuses a revoked apply without running setup', async () => {
  flags.add(PROJECT_WORKING_CONFIGURATION_PREVIEW);
  const home = makeTempDir('working-config-ui-');
  const cwd = join(home, 'checkout');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'AGENTS.md'), 'Preserve intentional edits.');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ scripts: { test: 'do-not-run' } }),
  );
  let allowed = true;
  const service = new ProjectWorkingConfigurationService(home, async () => ({
    projectId: 'project-1',
    cwd,
  }));
  const app = new Hono().route(
    '/api/projects',
    createProjectWorkingConfigurationRoutes({
      service,
      enabled: () => true,
      authorize: async () => ({
        projectId: 'project-1',
        actorId: 'person',
        isCurrent: () => allowed,
      }),
    }),
  );
  const authority = {
    apiBase: 'http://working.test',
    authorityKey: 'operator',
    isCurrent: () => true,
  };
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  }));
  const fetch = vi.fn(async (url: string | Request, init?: RequestInit) =>
    app.request(String(url), init),
  );
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkingConfiguration
        slug="work"
        projectId="project-1"
        authority={authority}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review working configuration' }),
  );
  fireEvent.change(screen.getByLabelText('Completion criteria'), {
    target: { value: 'Independent review and evidence.' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Apply reviewed defaults' }),
  );
  await screen.findByText('Reviewed revision 1');
  expect(
    (await service.discover('work', () => true)).current?.draft
      .completionCriteria,
  ).toBe('Independent review and evidence.');
  expect(
    fetch.mock.calls.filter(([, init]) => init?.method === 'PUT'),
  ).toHaveLength(1);
  writeFileSync(join(cwd, 'AGENTS.md'), 'Changed repository rule.');
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Discover repository instructions again',
    }),
  );
  await screen.findByText('Reviewed revision 1 · Repository sources changed');
  fireEvent.click(
    screen.getByRole('button', { name: 'Review working configuration' }),
  );
  expect(
    screen.getByLabelText<HTMLTextAreaElement>('Completion criteria').value,
  ).toBe('Independent review and evidence.');
  allowed = false;
  fireEvent.click(
    screen.getByRole('button', { name: 'Apply reviewed defaults' }),
  );
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect((await service.discover('work', () => true)).current?.revision).toBe(
    1,
  );
});

test('disabled preview mounts no configuration requests or editor', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ProjectWorkingConfiguration
        slug="work"
        projectId="project-1"
        authority={{
          apiBase: 'http://working.test',
          authorityKey: 'test',
        }}
      />
    </QueryClientProvider>,
  );
  expect(
    screen.queryByRole('region', { name: 'Project working configuration' }),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
