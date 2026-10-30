import { describe, expect, test } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import { createAutomationLedger } from '../../../services/automation/automation-ledger.js';
import { AutomationPolicyUnavailableError } from '../../../services/automation/automation-store.js';
import { createAutomationRoutes } from '../automations.js';

const makeTempDir = trackTempDirs();
const enabledPreview = {
  select: <T>(branches: { enabled: () => T; disabled: () => T }) =>
    branches.enabled(),
};

const logger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never;

function seededLedger() {
  const ledger = createAutomationLedger({
    directory: makeTempDir('automation-routes-'),
  });
  const now = Date.parse('2026-10-06T08:00:00.000Z');
  for (let id = 1; id <= 3; id += 1) {
    ledger.recordDelivery({
      sourceId: 'source-1',
      transportId: `workflow_run:${id}:1:completed`,
      semanticKey: `workflow_run:${id}:1:completed`,
      eventType: 'github.workflow_run.completed',
      receivedAt: now + id,
      outcome: id === 2 ? 'matched' : 'no-match',
      ...(id === 2 ? { ruleId: 'rule-1' } : {}),
    });
  }
  return ledger;
}

describe('GET /automations/deliveries', () => {
  test('disabled preview refuses without opening the ledger', async () => {
    let reads = 0;
    const app = createAutomationRoutes(
      {
        listPolls: () => [],
        preview: { select: (branches) => branches.disabled() },
        listDeliveries: () => {
          reads += 1;
          return [];
        },
      },
      logger,
    );
    const response = await app.request('/deliveries');
    expect(response.status).toBe(404);
    expect(await json(response)).toMatchObject({
      code: 'feature_preview_disabled',
      previewId: 'github-automation-observations',
    });
    expect(reads).toBe(0);
  });

  test('returns the ledger rows newest first, bounded by limit', async () => {
    const ledger = seededLedger();
    ledger.recordPoll({
      sourceId: 'source-1',
      polledAt: Date.now(),
      outcome: 'partial',
    });
    const app = createAutomationRoutes(
      {
        listPolls: () => ledger.listPolls(),
        preview: enabledPreview,
        listDeliveries: (limit) => ledger.listDeliveries(limit),
      },
      logger,
    );
    const all = await app.request('/deliveries');
    expect(all.status).toBe(200);
    const body = await json(all);
    expect(body.success).toBe(true);
    expect(body.data.polls).toEqual([
      expect.objectContaining({ sourceId: 'source-1', lastOutcome: 'partial' }),
    ]);
    expect(
      body.data.deliveries.map(
        (row: { semanticKey: string }) => row.semanticKey,
      ),
    ).toEqual([
      'workflow_run:3:1:completed',
      'workflow_run:2:1:completed',
      'workflow_run:1:1:completed',
    ]);
    expect(body.data.deliveries[1]).toMatchObject({
      outcome: 'matched',
      ruleId: 'rule-1',
    });
    expect(Object.keys(body.data.deliveries[1]).sort()).toEqual([
      'deliveryKey',
      'eventType',
      'outcome',
      'receivedAt',
      'ruleId',
      'semanticKey',
      'sourceId',
      'updatedAt',
    ]);
    const one = await json(await app.request('/deliveries?limit=1'));
    expect(one.data.deliveries).toHaveLength(1);
    ledger.close();
  });

  test.each(['0', '201', 'abc', '1.5', '-1', ''])(
    'refuses limit=%s rather than clamping it',
    async (limit) => {
      let called = false;
      const app = createAutomationRoutes(
        {
          listPolls: () => [],
          preview: enabledPreview,
          listDeliveries: () => {
            called = true;
            return [];
          },
        },
        logger,
      );
      const response = await app.request(`/deliveries?limit=${limit}`);
      expect(response.status).toBe(400);
      expect(called).toBe(false);
    },
  );

  test('an unavailable ledger is a 503 with a path-free message', async () => {
    const app = createAutomationRoutes(
      {
        listPolls: () => [],
        preview: enabledPreview,
        listDeliveries: () => {
          throw new AutomationPolicyUnavailableError(
            'ledger unopenable /secret/path',
          );
        },
      },
      logger,
    );
    const response = await app.request('/deliveries');
    expect(response.status).toBe(503);
    const body = await json(response);
    expect(body).toEqual({
      success: false,
      error: 'Automation policy is unavailable.',
      code: 'policy_unavailable',
    });
  });

  test('hosted mode sees no Automation surface', async () => {
    const app = createAutomationRoutes(
      {
        listPolls: () => [],
        preview: enabledPreview,
        listDeliveries: () => [],
        readAuthorityForRequest: () => ({ mode: 'hosted' }) as never,
      },
      logger,
    );
    expect((await app.request('/deliveries')).status).toBe(404);
  });

  test('reads need the read tier; no Automation mutation is classified yet', () => {
    expect(requiredPairingScope('GET', '/automations/deliveries')).toBe(
      'access:manage',
    );
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(
        requiredPairingScope(method, '/automations/rules'),
        method,
      ).toBeUndefined();
    }
  });
});
