import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { requiredPairingScope } from '../../../security/pairing-route-scopes.js';
import {
  QUALIFICATION_RULE,
  workflowRun,
} from '../../../services/automation/__tests__/fixtures/workflow-run-fixture.js';
import { recordAutomationEvent } from '../../../services/automation/automation-intake.js';
import { createAutomationLedger } from '../../../services/automation/automation-ledger.js';
import {
  projectAutomationEpisode,
  retryAutomationEpisode,
} from '../../../services/automation/automation-operator.js';
import {
  AutomationPolicyUnavailableError,
  AutomationStore,
} from '../../../services/automation/automation-store.js';
import { normalizeGitHubWorkflowRun } from '../../../services/automation/github-workflow-run.js';
import {
  type AutomationOperator,
  createAutomationRoutes,
} from '../automations.js';

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

  test('returns each matched rule mode and decision with a bounded action snapshot (#4509)', async () => {
    const ledger = createAutomationLedger({
      directory: makeTempDir('automation-routes-decisions-'),
    });
    const source = {
      id: 'source-1',
      kind: 'github-poll' as const,
      name: 'source',
      enabled: true,
      repository: 'kontourai/station',
      grants: [
        {
          projectId: 'station',
          agentId: 'repairer',
          actions: ['dispatch-task' as const],
        },
      ],
    };
    const rule = (id: string, mode: 'observe' | 'live') => ({
      ...QUALIFICATION_RULE,
      id,
      name: `Rule ${id}`,
      mode,
      action: {
        kind: 'dispatch-task' as const,
        projectId: 'station',
        agentId: 'repairer',
        instructions: 'SECRET-INSTRUCTIONS-NOT-PROJECTED',
        budget: { maxTurns: 1, maxTokens: 1000, maxWallRuntimeMs: 60000 },
      },
    });
    const now = Date.parse('2026-10-06T08:00:00.000Z');
    const normalized = normalizeGitHubWorkflowRun(
      workflowRun({ conclusion: 'failure', updatedAt: '2026-10-06T06:34:46Z' }),
      { source, receivedAt: now },
    );
    if (normalized.kind !== 'event') throw new Error(normalized.reason);
    recordAutomationEvent({
      ledger,
      source,
      rules: [rule('rule-a', 'observe'), rule('rule-b', 'live')],
      event: normalized.event,
      transportId: normalized.event.semanticKey,
      now,
    });
    const app = createAutomationRoutes(
      {
        listPolls: () => ledger.listPolls(),
        preview: enabledPreview,
        listDeliveries: (limit) => ledger.listDeliveries(limit),
      },
      logger,
    );
    const response = await app.request('/deliveries');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('SECRET-INSTRUCTIONS-NOT-PROJECTED');
    expect(text).not.toContain('run.head_sha');
    const [delivery] = JSON.parse(text).data.deliveries;
    expect(delivery).toMatchObject({ outcome: 'matched', ruleId: 'rule-b' });
    expect(delivery.decisions).toEqual([
      {
        ruleId: 'rule-a',
        ruleName: 'Rule rule-a',
        mode: 'observe',
        outcome: 'would-start',
        actionKind: 'dispatch-task',
        projectId: 'station',
        agentId: 'repairer',
        episodeId: '37423043587',
        decidedAt: '2026-10-06T08:00:00.000Z',
      },
      {
        ruleId: 'rule-b',
        ruleName: 'Rule rule-b',
        mode: 'live',
        outcome: 'intent-retained',
        actionKind: 'dispatch-task',
        projectId: 'station',
        agentId: 'repairer',
        episodeId: '37423043587',
        decidedAt: '2026-10-06T08:00:00.000Z',
      },
    ]);
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

  test('reads and mutations need access management (#4513)', () => {
    expect(requiredPairingScope('GET', '/automations/deliveries')).toBe(
      'access:manage',
    );
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredPairingScope(method, '/automations/rules'), method).toBe(
        'access:manage',
      );
    }
  });
});

// ── #4513: the operator surface ───────────────────────────────────────────

const OPERATOR: AutomationOperator = {
  id: 'operator',
  assertCurrent: async () => undefined,
};
const DISPATCH_RULE = {
  name: 'Diagnose',
  match: QUALIFICATION_RULE.match,
  episode: QUALIFICATION_RULE.episode,
  action: {
    kind: 'dispatch-task',
    projectId: 'station',
    agentId: 'repairer',
    instructions: 'Diagnose the failing run.',
    budget: { maxTurns: 2, maxTokens: 10_000, maxWallRuntimeMs: 60_000 },
  },
  rateLimit: { maxStartsPerHour: 2 },
};

async function operatorSurface(
  options: {
    operator?: (request: Request) => Promise<AutomationOperator>;
    preview?: boolean;
    grants?: string[];
  } = {},
) {
  const home = makeTempDir('automation-operator-');
  const store = new AutomationStore(home);
  const ledger = createAutomationLedger({ directory: join(home, 'ledger') });
  let previewOn = options.preview ?? true;
  const app = createAutomationRoutes(
    {
      listPolls: () => [],
      listDeliveries: (limit) => ledger.listDeliveries(limit),
      preview: {
        select: (branches) =>
          previewOn ? branches.enabled() : branches.disabled(),
      },
      store,
      listOpenEpisodes: (limit) =>
        ledger.listOpenEpisodes(limit).map(projectAutomationEpisode),
      retryEpisode: (ruleId, episodeId) =>
        retryAutomationEpisode({
          ledger,
          read: () => store.read(),
          ruleId,
          episodeId,
          now: Date.now(),
        }),
      operator: options.operator ?? (async () => OPERATOR),
    },
    logger,
  );
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json' },
          }),
    });
  const source = await store.createSource({
    kind: 'github-poll',
    name: 'Main',
    repository: 'kontourai/station',
    grants: [
      {
        projectId: 'station',
        agentId: 'repairer',
        actions: (options.grants ?? ['dispatch-task']) as never,
      },
    ],
  });
  const fingerprint = async () =>
    (
      (await json(await send('GET', '/rules'))) as {
        data: { configurationFingerprint: string };
      }
    ).data.configurationFingerprint;
  return {
    app,
    send,
    store,
    ledger,
    sourceId: source.source.id,
    fingerprint,
    setPreview: (on: boolean) => {
      previewOn = on;
    },
  };
}

describe('Automation operator surface (#4513)', () => {
  test('creates, edits, enables, disables and deletes a dispatch-task rule end to end', async () => {
    const s = await operatorSurface();
    const created = await s.send('POST', '/rules', {
      ...DISPATCH_RULE,
      sourceId: s.sourceId,
    });
    expect(created.status).toBe(201);
    const rule = (
      (await json(created)) as { data: { id: string; mode: string } }
    ).data;
    expect(rule.mode).toBe('observe');

    const edited = await s.send('PUT', `/rules/${rule.id}`, {
      ...DISPATCH_RULE,
      name: 'Diagnose (edited)',
      expectedFingerprint: await s.fingerprint(),
    });
    expect(edited.status).toBe(200);
    expect(s.store.read().rules[0]).toMatchObject({
      id: rule.id,
      name: 'Diagnose (edited)',
      mode: 'observe',
      sourceId: s.sourceId,
    });

    // A stale fingerprint is refused; nothing changes.
    const stale = await s.send('PUT', `/rules/${rule.id}/enable`, {
      expectedFingerprint: 'a'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(s.store.read().rules[0]?.mode).toBe('observe');

    expect(
      (
        await s.send('PUT', `/rules/${rule.id}/enable`, {
          expectedFingerprint: await s.fingerprint(),
        })
      ).status,
    ).toBe(200);
    expect(s.store.read().rules[0]?.mode).toBe('live');
    expect((await s.send('PUT', `/rules/${rule.id}/disable`)).status).toBe(200);
    expect(s.store.read().rules[0]?.mode).toBe('off');
    expect((await s.send('DELETE', `/rules/${rule.id}`)).status).toBe(200);
    expect(s.store.read().rules).toEqual([]);
    expect((await s.send('DELETE', `/sources/${s.sourceId}`)).status).toBe(200);
    expect(s.store.read().sources).toEqual([]);
  });

  test('every mutation is refused without the operator in person; reads still work', async () => {
    const s = await operatorSurface({
      operator: async () => {
        throw new Error('agent session');
      },
    });
    for (const [method, path, body] of [
      ['POST', '/rules', { ...DISPATCH_RULE, sourceId: s.sourceId }],
      [
        'POST',
        '/sources',
        { kind: 'github-poll', name: 'x', repository: 'a/b' },
      ],
      [
        'PUT',
        `/sources/${s.sourceId}/enable`,
        { expectedFingerprint: 'a'.repeat(64) },
      ],
      ['PUT', `/sources/${s.sourceId}/disable`, {}],
      ['DELETE', `/sources/${s.sourceId}`, undefined],
      ['POST', '/episodes/rule-1%3A42/retry', {}],
    ] as const) {
      const response = await s.send(method, path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await json(response)).toMatchObject({ code: 'operator_required' });
    }
    expect(s.store.read().rules).toEqual([]);
    expect(s.store.read().sources[0]?.enabled).toBe(false);
    expect((await s.send('GET', '/sources')).status).toBe(200);
    expect((await s.send('GET', '/rules')).status).toBe(200);
  });

  test('this surface creates and edits dispatch-task rules only', async () => {
    const s = await operatorSurface({
      grants: ['dispatch-task', 'isolated-repair'],
    });
    const repair = await s.send('POST', '/rules', {
      ...DISPATCH_RULE,
      sourceId: s.sourceId,
      action: {
        kind: 'isolated-repair',
        projectId: 'station',
        agentId: 'repairer',
        profileId: 'profile',
        instructions: 'x',
        budget: { maxProviderRequests: 1, maxWallRuntimeMs: 1000 },
      },
    });
    expect(repair.status).toBe(400);
    // A source granting repair is enabled from the repair surface only.
    const enable = await s.send('PUT', `/sources/${s.sourceId}/enable`, {
      expectedFingerprint: await s.fingerprint(),
    });
    expect(enable.status).toBe(409);
    expect(await json(enable)).toMatchObject({
      code: 'repair_surface_required',
    });
  });

  test('with the preview off, changes that widen authority are refused but disable and delete still work', async () => {
    const s = await operatorSurface();
    const created = await s.send('POST', '/rules', {
      ...DISPATCH_RULE,
      sourceId: s.sourceId,
    });
    const rule = ((await json(created)) as { data: { id: string } }).data;
    const fingerprint = await s.fingerprint();
    s.setPreview(false);
    const enable = await s.send('PUT', `/rules/${rule.id}/enable`, {
      expectedFingerprint: fingerprint,
    });
    expect(enable.status).toBe(404);
    expect(await json(enable)).toMatchObject({
      code: 'feature_preview_disabled',
    });
    expect((await s.send('PUT', `/rules/${rule.id}/disable`)).status).toBe(200);
    expect((await s.send('DELETE', `/rules/${rule.id}`)).status).toBe(200);
  });

  test('lists sources without secrets and open episodes without their internal key', async () => {
    const s = await operatorSurface();
    const sources = (await json(await s.send('GET', '/sources'))) as {
      data: { sources: Record<string, unknown>[] };
    };
    expect(sources.data.sources).toHaveLength(1);
    expect(sources.data.sources[0]).not.toHaveProperty('secret');
    s.ledger.openEpisode({
      ruleId: 'rule-1',
      episodeKey: '["rule-1","x"]',
      episodeId: '42',
      maxAttempts: 1,
      now: Date.now(),
    });
    const episodes = (await json(await s.send('GET', '/episodes'))) as {
      data: { episodes: Record<string, unknown>[] };
    };
    expect(episodes.data.episodes).toEqual([
      expect.objectContaining({
        ruleId: 'rule-1',
        episodeId: '42',
        state: 'open',
      }),
    ]);
    expect(episodes.data.episodes[0]).not.toHaveProperty('episodeKey');
  });

  test('retry-episode explains each refusal and parses its target', async () => {
    const s = await operatorSurface();
    expect(
      (await s.send('POST', '/episodes/no-separator/retry', {})).status,
    ).toBe(400);
    const missing = await s.send('POST', '/episodes/rule-1%3A42/retry', {});
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ code: 'automation_not_found' });
    s.ledger.openEpisode({
      ruleId: 'rule-1',
      episodeKey: '["rule-1","x"]',
      episodeId: '42',
      maxAttempts: 1,
      now: Date.now(),
    });
    const open = await s.send('POST', '/episodes/rule-1%3A42/retry', {});
    expect(open.status).toBe(409);
    expect(await json(open)).toMatchObject({ code: 'not-exhausted' });
  });
});
