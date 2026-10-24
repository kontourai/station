import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AnalyticsViewDefinition,
  parseAnalyticsSavedView,
  resolveAnalyticsViewWindows,
} from '@kontourai/station-contracts/analytics-views';
import { expect, test } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { RecipientStore } from '../../../analytics/recipient-store.js';
import { AnalyticsSavedViews } from '../../../analytics/saved-views.js';
import {
  type EnrollmentActor,
  SourceEnrollmentStore,
} from '../../../analytics/source-enrollment-store.js';
import { AuthorityObservationRejected } from '../../../services/identity/authority-observation.js';
import { createAnalyticsSavedViewRoutes } from '../analytics-saved-views.js';

const temporary = trackTempDirs();
async function fixture() {
  const home = temporary('saved-views-'),
    sources = new RecipientStore(home);
  let user = 'alice',
    tenant: string | null = null,
    live = true,
    refuse = false;
  const actor = (): EnrollmentActor => ({
    sourceStationId: 'receiver',
    userId: user,
    mode: tenant ? 'hosted' : 'personal',
    tenantId: tenant,
    ownerIds: [user],
    assertCurrent: async () => {
      if (!live)
        throw new AuthorityObservationRejected(403, 'authority_changed');
    },
  });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const sourceActor = { ...actor(), sourceStationId: `source-${i}` };
    const source = new SourceEnrollmentStore(temporary('saved-view-source-'));
    const intent = await source.prepare(sourceActor, {
      operationId: randomUUID(),
      proposedDestination: {
        stationId: 'receiver',
        origin: 'https://receiver.example.test',
      },
      scope: 'individual',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      retention: { mode: 'retained-copy', days: 7 },
    });
    const id = randomUUID();
    ids.push(id);
    await sources.prepare(actor(), {
      operationId: id,
      proposedSourceOrigin: `https://source-${i}.example.test`,
      sourceIntent: intent,
    });
  }
  const make = () =>
    createAnalyticsSavedViewRoutes({
      store: new AnalyticsSavedViews(home, async (a, ids) => {
        await sources.assertViewSources(a, ids);
        if (refuse) live = false;
      }),
      capture: async () => actor(),
    });
  const definition: AnalyticsViewDefinition = {
    title: 'Model cost trend',
    sources: ids.map((recipientId) => ({
      recipientId,
      provider: 'claude',
      model: 'actual-model',
    })),
    range: { kind: 'relative', days: 14 },
    comparison: { kind: 'previous' },
    groupBy: 'model',
    measure: 'reportedCost',
    timeZone: 'UTC',
  };
  return {
    home,
    ids,
    definition,
    make,
    asUser: (value: string) => {
      user = value;
    },
    tenant: (value: string | null) => {
      tenant = value;
    },
    live: (value: boolean) => {
      live = value;
    },
    refuse: () => {
      refuse = true;
    },
    actor,
  };
}
const send = (
  app: ReturnType<typeof createAnalyticsSavedViewRoutes>,
  method: string,
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
async function data(response: Response): Promise<unknown> {
  return z.object({ data: z.unknown() }).parse(await response.json()).data;
}
test('saved views survive restart, enforce revision checks and erase definitions without resurrecting operation IDs', async () => {
  const h = await fixture();
  let app = h.make();
  const id = randomUUID();
  const created = await send(app, 'POST', '/', {
    operationId: id,
    definition: h.definition,
  });
  expect(created.status).toBe(201);
  const original = parseAnalyticsSavedView(await data(created));
  expect(
    resolveAnalyticsViewWindows(original.definition, '2026-10-24'),
  ).toEqual({
    primary: { from: '2026-10-11', to: '2026-10-24' },
    comparison: { from: '2026-09-27', to: '2026-10-10' },
  });
  app = h.make();
  expect(await data(await app.request(`/${id}`))).toEqual(original);
  expect(
    (
      await send(app, 'POST', '/', {
        operationId: id,
        definition: h.definition,
      })
    ).status,
  ).toBe(201);
  const results = await Promise.all(
    ['one', 'two'].map((title) =>
      send(app, 'PUT', `/${id}`, {
        expectedRevision: 1,
        definition: { ...h.definition, title },
      }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const exported = await app.request(`/${id}/export`);
  expect(exported.status).toBe(200);
  expect(parseAnalyticsSavedView(await data(exported)).revision).toBe(2);
  expect(
    (await send(app, 'DELETE', `/${id}`, { expectedRevision: 1 })).status,
  ).toBe(409);
  expect(
    (await send(app, 'DELETE', `/${id}`, { expectedRevision: 2 })).status,
  ).toBe(200);
  expect(
    (await send(app, 'DELETE', `/${id}`, { expectedRevision: 2 })).status,
  ).toBe(200);
  expect((await app.request(`/${id}`)).status).toBe(404);
  expect(
    (
      await send(app, 'POST', '/', {
        operationId: id,
        definition: h.definition,
      })
    ).status,
  ).toBe(409);
  const raw = await readFile(
    join(h.home, 'security/analytics-saved-views.json'),
    'utf8',
  );
  expect(raw).not.toContain('Model cost trend');
  for (const source of h.ids) expect(raw).not.toContain(source);
});
test('foreign persons and tenants cannot read, update, delete or export a saved definition, and body identities grant nothing', async () => {
  const h = await fixture(),
    app = h.make(),
    id = randomUUID();
  expect(
    (
      await send(app, 'POST', '/', {
        operationId: id,
        definition: h.definition,
      })
    ).status,
  ).toBe(201);
  for (const change of [
    () => h.asUser('bob'),
    () => {
      h.asUser('alice');
      h.tenant('tenant-b');
    },
  ]) {
    change();
    expect(
      (await send(app, 'DELETE', `/${id}`, { expectedRevision: 1 })).status,
    ).toBe(404);
    expect(await data(await app.request('/'))).toEqual([]);
    expect((await app.request(`/${id}`)).status).toBe(404);
    expect((await app.request(`/${id}/export`)).status).toBe(404);
    expect(
      (
        await send(app, 'PUT', `/${id}`, {
          expectedRevision: 1,
          definition: h.definition,
        })
      ).status,
    ).toBe(404);
  }
  h.tenant(null);
  expect(
    (
      await send(app, 'POST', '/', {
        operationId: randomUUID(),
        definition: h.definition,
        owner: 'alice',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send(app, 'POST', '/', {
        operationId: randomUUID(),
        definition: {
          ...h.definition,
          sources: [{ recipientId: randomUUID() }],
        },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send(app, 'POST', '/', {
        operationId: randomUUID(),
        definition: { ...h.definition, engine: 'guessed' },
      })
    ).status,
  ).toBe(400);
});
test('lost person authority between source validation and commit leaves no saved view', async () => {
  const h = await fixture(),
    app = h.make(),
    id = randomUUID();
  h.refuse();
  expect(
    (
      await send(app, 'POST', '/', {
        operationId: id,
        definition: h.definition,
      })
    ).status,
  ).toBe(403);
  h.live(true);
  expect((await app.request(`/${id}`)).status).toBe(404);
});
