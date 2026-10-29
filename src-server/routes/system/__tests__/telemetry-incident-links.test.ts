import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { z } from 'zod/v3';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { assertRuntimeHttpRouteCoverage } from '../../../security/pairing-route-scopes.js';
import { TelemetryIncidentLinks } from '../../../services/telemetry-incident-links.js';
import { createTelemetryIncidentLinkRoutes } from '../telemetry-incident-link-routes.js';

const makeTempDir = trackTempDirs();
const groupId = 'a'.repeat(64),
  id = '11234567-89ab-4cde-8fab-0123456789ab';
const window = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
};
const issueUrl = 'https://github.com/kontourai/station/issues/3463';
const path = `/product-incidents/${groupId}/links`;
const query = new URLSearchParams(window);
const mutation = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
function fixture() {
  const home = makeTempDir('station-incident-links-');
  let operator = true,
    installationId = '21234567-89ab-4cde-8fab-0123456789ab',
    groups = new Set([groupId]),
    now = Date.parse('2026-10-02T00:00:00.000Z'),
    failBeforeWrite = false;
  const requireOperator = async () => {
    if (!operator) throw new Error('private authority detail');
  };
  const create = () =>
    new Hono().route(
      '/',
      createTelemetryIncidentLinkRoutes({
        store: new TelemetryIncidentLinks(home, () => now),
        requireOperator,
        capture: async () => {
          await requireOperator();
          let checks = 0;
          return {
            installationId,
            groupIds: new Set(groups),
            assertCurrent: async () => {
              if (failBeforeWrite && ++checks === 2) operator = false;
              await requireOperator();
            },
          };
        },
      }),
    );
  return {
    app: create(),
    reopen: create,
    file: join(home, 'security/telemetry-incident-links.json'),
    setOperator: (value: boolean) => {
      operator = value;
    },
    setInstallation: (value: string) => {
      installationId = value;
    },
    setGroups: (value: string[]) => {
      groups = new Set(value);
    },
    expire: () => {
      now += 31 * 86400000;
    },
    failWrite: () => {
      failBeforeWrite = true;
    },
  };
}

test('operator links survive reopen and lost replies, reject conflicting reuse, and delete without resurrection', async () => {
  const h = fixture(),
    input = { operationId: id, window, issueUrl };
  h.setOperator(false);
  expect((await h.app.request(path, mutation('POST', input))).status).toBe(403);
  h.setOperator(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await h.app.request(path, mutation('POST', input));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id, state: 'active' } });
  }
  const listed = await h.reopen().request(`${path}?${query}`);
  expect(listed.headers.get('cache-control')).toBe('no-store');
  expect(await listed.json()).toMatchObject({
    data: [
      {
        id,
        groupId,
        issue: {
          provider: 'github',
          url: issueUrl,
          workItemRef: 'github:kontourai/station#3463',
        },
        window,
        createdAt: '2026-10-02T00:00:00.000Z',
        expiresAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  });
  expect(
    (
      await h.app.request(
        path,
        mutation('POST', {
          ...input,
          issueUrl: 'https://github.com/kontourai/station/issues/1229',
        }),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await h.app.request(
        path,
        mutation('POST', {
          ...input,
          operationId: '31234567-89ab-4cde-8fab-0123456789ab',
        }),
      )
    ).status,
  ).toBe(409);
  for (let attempt = 0; attempt < 2; attempt++)
    expect(
      (await h.app.request(`${path}/${id}`, mutation('DELETE', { window })))
        .status,
    ).toBe(200);
  expect(await readFile(h.file, 'utf8')).not.toContain(issueUrl);
  const old = await h.app.request(path, mutation('POST', input));
  expect(await old.json()).toEqual({ data: { id, state: 'deleted' } });
  expect(await (await h.app.request(`${path}?${query}`)).json()).toEqual({
    data: [],
  });
});

test('link access is installation and current-group scoped, and lost authority before write leaves bytes unchanged', async () => {
  const h = fixture(),
    input = { operationId: id, window, issueUrl };
  expect((await h.app.request(path, mutation('POST', input))).status).toBe(200);
  const original = await readFile(h.file, 'utf8');
  h.setInstallation('41234567-89ab-4cde-8fab-0123456789ab');
  expect(await (await h.app.request(`${path}?${query}`)).json()).toEqual({
    data: [],
  });
  expect(
    (await h.app.request(`${path}/${id}`, mutation('DELETE', { window })))
      .status,
  ).toBe(404);
  h.setInstallation('21234567-89ab-4cde-8fab-0123456789ab');
  h.setGroups([]);
  const hidden = await h.app.request(`${path}?${query}`);
  expect(hidden.status).toBe(404);
  expect(await hidden.text()).not.toContain(issueUrl);
  h.setGroups([groupId]);
  h.failWrite();
  const refused = await h.app.request(
    path,
    mutation('POST', {
      ...input,
      operationId: '51234567-89ab-4cde-8fab-0123456789ab',
      issueUrl: 'https://github.com/kontourai/station/issues/1229',
    }),
  );
  expect(refused.status).toBe(403);
  expect(await readFile(h.file, 'utf8')).toBe(original);
});

test('link capacity, URL hygiene, expiration and corrupt state fail explicitly', async () => {
  const h = fixture();
  for (const url of [
    'http://github.com/kontourai/station/issues/1',
    'https://github.com/kontourai/station/issues/1?token=secret',
    'https://user:secret@github.com/kontourai/station/issues/1',
  ])
    expect(
      (
        await h.app.request(
          path,
          mutation('POST', { operationId: id, window, issueUrl: url }),
        )
      ).status,
    ).toBe(400);
  for (let n = 1; n <= 8; n++)
    expect(
      (
        await h.app.request(
          path,
          mutation('POST', {
            operationId: `11234567-89ab-4cde-8fab-${String(n).padStart(12, '0')}`,
            window,
            issueUrl: `https://github.com/kontourai/station/issues/${n}`,
          }),
        )
      ).status,
    ).toBe(200);
  const list = z
    .object({ data: z.array(z.unknown()) })
    .parse(await (await h.app.request(`${path}?${query}`)).json());
  expect(list.data).toHaveLength(8);
  expect(
    (
      await h.app.request(
        path,
        mutation('POST', { operationId: id, window, issueUrl }),
      )
    ).status,
  ).toBe(507);
  h.expire();
  expect(await (await h.app.request(`${path}?${query}`)).json()).toEqual({
    data: [],
  });
  expect(
    (
      await h.app.request(
        path,
        mutation('POST', { operationId: id, window, issueUrl }),
      )
    ).status,
  ).toBe(200);
  expect(await readFile(h.file, 'utf8')).not.toContain(
    'https://github.com/kontourai/station/issues/1"',
  );
  await writeFile(h.file, '{}');
  const corrupt = await h.app.request(`${path}?${query}`);
  expect(corrupt.status).toBe(503);
  expect(await corrupt.text()).not.toContain(issueUrl);
});

test('mounted incident links satisfy the startup HTTP capability guard', () => {
  const app = new Hono().route(
    '/api/operator/telemetry-companion',
    fixture().app,
  );
  expect(() => assertRuntimeHttpRouteCoverage(app.routes)).not.toThrow();
});
