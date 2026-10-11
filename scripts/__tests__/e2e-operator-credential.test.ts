import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  e2eOperatorAuthorizationHeaders,
  readE2EOperatorCredential,
} from '../../tests/helpers/e2e-operator-credential';
import { seedE2EUsageTelemetryDisclosure } from '../run-e2e-suite.mjs';

const roots: string[] = [];
const OPERATOR_CREDENTIAL = 'a'.repeat(43);

function stationHome(record: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'station-e2e-credential-'));
  roots.push(home);
  mkdirSync(join(home, 'security'));
  writeFileSync(
    join(home, 'security', 'environment.json'),
    JSON.stringify(record),
  );
  return home;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('nested Station E2E operator credential', () => {
  test('reads the exact disposable home and authenticates protected readiness', () => {
    const credential = readE2EOperatorCredential(
      stationHome({ credential: OPERATOR_CREDENTIAL }),
    );

    expect(credential).toBe(OPERATOR_CREDENTIAL);
    expect(e2eOperatorAuthorizationHeaders(credential)).toEqual({
      Authorization: `Bearer ${OPERATOR_CREDENTIAL}`,
    });
  });

  test.each([{}, { credential: '' }, { credential: 'malformed' }])(
    'fails closed for an invalid nested-home record %#',
    (record) => {
      expect(() => readE2EOperatorCredential(stationHome(record))).toThrow(
        'did not publish a valid operator credential',
      );
    },
  );
});

describe('ordinary-suite disclosure bootstrap', () => {
  test('acknowledges the revision returned by the authenticated disclosure read', async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        success: true,
        data: {
          acknowledgementProtocol: 2,
          inventoryRevision: 'inventory-served-by-this-station',
          acknowledged: requests.length === 2,
        },
      });
    });
    await seedE2EUsageTelemetryDisclosure(
      'http://station.test',
      OPERATOR_CREDENTIAL,
      fetchImpl,
    );
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(
      'http://station.test/api/usage-telemetry/disclosure',
    );
    for (const request of requests)
      expect(request.headers.get('authorization')).toBe(
        `Bearer ${OPERATOR_CREDENTIAL}`,
      );
    expect(requests[1].method).toBe('POST');
    expect(requests[1].headers.get('content-type')).toBe('application/json');
    expect(await requests[1].json()).toEqual({
      acknowledgementProtocol: 2,
      inventoryRevision: 'inventory-served-by-this-station',
    });
  });

  test.each([
    { status: 401, body: {} },
    {
      status: 200,
      body: {
        success: true,
        data: { acknowledgementProtocol: 1, inventoryRevision: 'old' },
      },
    },
    {
      status: 200,
      body: { success: true, data: { acknowledgementProtocol: 2 } },
    },
  ])(
    'does not post consent when the disclosure cannot be read: %#',
    async ({ status, body }) => {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json(body, { status }),
      );
      await expect(
        seedE2EUsageTelemetryDisclosure(
          'http://station.test',
          OPERATOR_CREDENTIAL,
          fetchImpl,
        ),
      ).rejects.toThrow('Could not read');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );
});
