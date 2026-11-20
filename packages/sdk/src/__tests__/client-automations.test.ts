import type { AutomationDeliveryPage } from '@kontourai/station-contracts/automation';
import { afterEach, expect, test, vi } from 'vitest';
import { StationHttpError } from '../client/api-error-message';
import {
  enableAutomationRule,
  listAutomationDeliveries,
  retryAutomationEpisode,
} from '../client/automations';

afterEach(() => vi.unstubAllGlobals());

test('preserves partial source coverage alongside bounded delivery history', async () => {
  const page = {
    deliveries: [],
    polls: [
      {
        sourceId: 'source-1',
        lastPolledAt: '2026-10-29T00:00:00Z',
        lastOutcome: 'partial',
      },
    ],
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ success: true, data: page }));
  vi.stubGlobal('fetch', fetcher);
  expect(
    await listAutomationDeliveries('http://station.test', { limit: 5 }),
  ).toEqual(page);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    'http://station.test/automations/deliveries?limit=5',
  );
});

test('preserves preview refusal details and distinguishes an older host', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            error: 'Enable GitHub automation observations in Settings.',
            code: 'feature_preview_disabled',
            previewId: 'github-automation-observations',
            settingsPath: '/settings?view=feature-previews',
          },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'Not found' }, { status: 404 }),
      ),
  );
  await expect(
    listAutomationDeliveries('http://station.test'),
  ).rejects.toMatchObject({
    status: 404,
    code: 'feature_preview_disabled',
    previewId: 'github-automation-observations',
  });
  await expect(listAutomationDeliveries('http://station.test')).rejects.toThrow(
    'not supported on this Station',
  );
});

test('non-JSON transport failures retain their HTTP status', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unavailable', { status: 503 })),
  );
  await expect(
    listAutomationDeliveries('http://station.test'),
  ).rejects.toBeInstanceOf(StationHttpError);
});

test('returns per-rule modes and decisions on each delivery (#4509)', async () => {
  const page: AutomationDeliveryPage = {
    deliveries: [
      {
        deliveryKey: 'a'.repeat(64),
        sourceId: 'source-1',
        semanticKey: 'workflow_run:1:1:completed',
        eventType: 'github.workflow_run.completed',
        receivedAt: '2026-11-04T00:00:00.000Z',
        updatedAt: '2026-11-04T00:00:00.000Z',
        outcome: 'matched',
        ruleId: 'rule-live',
        decisions: [
          {
            ruleId: 'rule-live',
            ruleName: 'Live',
            mode: 'live',
            outcome: 'intent-retained',
            actionKind: 'dispatch-task',
            projectId: 'station',
            agentId: 'repairer',
            episodeId: '1',
            decidedAt: '2026-11-04T00:00:00.000Z',
          },
          {
            ruleId: 'rule-observe',
            ruleName: 'Observe',
            mode: 'observe',
            outcome: 'suppressed',
            reason: 'rate-limited',
            actionKind: 'isolated-repair',
            projectId: 'station',
            agentId: 'repairer',
            episodeId: '1',
            decidedAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      },
    ],
    polls: [],
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ success: true, data: page })),
  );
  const result = await listAutomationDeliveries('http://station.test');
  expect(result.deliveries[0]?.decisions).toEqual(
    page.deliveries[0]?.decisions,
  );
});

test('a deliberate not-found is reported as such; any other 404 means an older host (#4513)', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            error: 'Automation rule not found',
            code: 'automation_not_found',
          },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ success: false, error: 'Not found' }, { status: 404 }),
      ),
  );
  await expect(
    enableAutomationRule('http://station.test', 'rule-1', 'f'.repeat(64)),
  ).rejects.toThrow('Automation rule not found');
  await expect(
    enableAutomationRule('http://station.test', 'rule-1', 'f'.repeat(64)),
  ).rejects.toThrow('not supported on this Station');
});

test('retry-episode sends the rule and episode as one encoded target (#4513)', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      success: true,
      data: { ruleId: 'rule-1', episodeId: '42.2', retry: 1 },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  expect(
    await retryAutomationEpisode('http://station.test', {
      ruleId: 'rule-1',
      episodeId: '42.2',
    }),
  ).toEqual({ ruleId: 'rule-1', episodeId: '42.2', retry: 1 });
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    'http://station.test/automations/episodes/rule-1%3A42.2/retry',
  );
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST');
});
