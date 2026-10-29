/** @vitest-environment jsdom */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProductTelemetryIncidents } from '@kontourai/station-contracts/product-telemetry';
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
import { trackTempDirs } from '../../../../../src-server/__test-utils__/temp-dirs';
import { createTelemetryCompanionRoutes } from '../../../../../src-server/routes/system/telemetry-companion-routes';
import { createTelemetryIncidentLinkRoutes } from '../../../../../src-server/routes/system/telemetry-incident-link-routes';
import { TelemetryIncidentLinks } from '../../../../../src-server/services/telemetry-incident-links';
import { CompanionProductIncidents } from '../CompanionProductIncidents';

const h = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }));
vi.mock('../../../lib/clipboard', () => ({ copyToClipboard: h.copy }));
const clients: QueryClient[] = [];
const makeTempDir = trackTempDirs();
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  h.copy.mockClear();
});

test('issue draft uses a fresh authorized Core/SDK read and refuses clipboard export after authority loss', async () => {
  let operator = true;
  let dropLinkReply = false;
  const home = makeTempDir('station-incident-ui-');
  const writes: Array<{ operationId: string }> = [];
  const window = {
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-02T00:00:00.000Z',
  };
  const report: ProductTelemetryIncidents = {
    protocol: 'station-product-incidents/v1',
    scope: 'received-product-observations',
    window,
    retentionDays: 30,
    eventTime: 'producer-wall-clock',
    deliveryCoverage: 'unknown',
    storageProbes: 'not-recorded',
    rows: [
      {
        id: 'a'.repeat(64),
        event: 'engine_turn',
        engine: 'codex',
        failureKind: 'unclassified',
        build: {
          version: '1.2.3',
          platform: 'linux',
          arch: 'x64',
          sha: 'b'.repeat(40),
          sha_source: 'build-stamp',
        },
        firstSeen: '2026-10-01T12:00:00.000Z',
        lastSeen: '2026-10-01T12:00:00.000Z',
        observed: 4,
        observedInstalls: 2,
        affectedInstalls: 1,
        populations: {
          succeeded: 3,
          failed: 1,
          aborted: 0,
          unresolved: 0,
          unknown: 0,
        },
      },
    ],
  };
  const read = vi.fn(async () => report);
  const app = new Hono().route(
    '/api/operator/telemetry-companion',
    createTelemetryCompanionRoutes({
      requireOperator: async () => {
        if (!operator) throw new Error('private authentication detail');
      },
      prerequisites: async () => {
        throw new Error('unused');
      },
      productIncidents: read,
    }),
  );
  const requireOperator = async () => {
    if (!operator) throw new Error('operator required');
  };
  app.route(
    '/api/operator/telemetry-companion',
    createTelemetryIncidentLinkRoutes({
      store: new TelemetryIncidentLinks(home),
      requireOperator,
      capture: async () => ({
        installationId: '11234567-89ab-4cde-8fab-0123456789ab',
        groupIds: new Set(report.rows.map((row) => row.id)),
        assertCurrent: requireOperator,
      }),
    }),
  );
  const authority = {
    apiBase: 'https://station.test',
    authorityKey: 'operator-test',
    isCurrent: () => true,
  };
  setClientCredentialResolver(() => ({
    origin: authority.apiBase,
    requestAuthority: authority,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        const body: unknown = await request.clone().json();
        if (
          body &&
          typeof body === 'object' &&
          'operationId' in body &&
          typeof body.operationId === 'string'
        )
          writes.push({ operationId: body.operationId });
      }
      const result = await app.fetch(request);
      if (dropLinkReply && request.method === 'POST' && result.ok) {
        dropLinkReply = false;
        throw new TypeError('reply lost');
      }
      return result;
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <CompanionProductIncidents authority={authority} window={window} />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review issue draft' }),
  );
  const draft = await screen.findByLabelText('Reviewable issue draft');
  expect(draft.getAttribute('readonly')).not.toBeNull();
  expect(screen.getByDisplayValue(/Observed denominator: 4/)).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(2);
  const issueUrl = 'https://github.com/kontourai/station/issues/3463';
  fireEvent.change(await screen.findByLabelText('Existing GitHub issue URL'), {
    target: { value: issueUrl },
  });
  dropLinkReply = true;
  fireEvent.click(screen.getByRole('button', { name: 'Link existing issue' }));
  expect(await screen.findByText(/The link was not confirmed/)).toBeTruthy();
  expect(
    await screen.findByRole('link', { name: 'github:kontourai/station#3463' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Link existing issue' }));
  expect(await screen.findByText('Issue reference linked.')).toBeTruthy();
  expect(writes).toHaveLength(2);
  expect(writes[0]?.operationId).toBe(writes[1]?.operationId);
  expect(
    JSON.parse(
      await readFile(
        join(home, 'security/telemetry-incident-links.json'),
        'utf8',
      ),
    ),
  ).toMatchObject({ records: [{ groupId: 'a'.repeat(64), state: 'active' }] });

  fireEvent.click(screen.getByRole('button', { name: 'Copy reviewed draft' }));
  await waitFor(() => expect(h.copy).toHaveBeenCalledTimes(1));
  expect(h.copy.mock.calls[0]?.[0]).toContain(
    'Source revision: ' + 'b'.repeat(40),
  );
  operator = false;
  fireEvent.click(screen.getByRole('button', { name: 'Copy reviewed draft' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Previous groups and drafts are hidden',
  );
  expect(screen.queryByLabelText('Reviewable issue draft')).toBeNull();
  expect(h.copy).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/private authentication detail/)).toBeNull();
});
