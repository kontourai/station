import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AutomationConfiguration,
  AutomationRule,
} from '@kontourai/station-contracts/automation';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FeaturePreviewRegistry } from '../../feature-previews/feature-preview-registry.js';
import { BuiltinScheduler } from '../../scheduling/builtin-scheduler.js';
import { createSchedulerLedger } from '../../scheduling/scheduler-ledger.js';
import {
  type AutomationLedger,
  createAutomationLedger,
  SharedAutomationLedger,
} from '../automation-ledger.js';
import { AutomationStore } from '../automation-store.js';
import {
  CURSOR_OVERLAP_MS,
  composeGitHubAutomationObservation,
  GitHubPollAutomationPoller,
  pinnedWorkflowFiles,
} from '../github-poll.js';
import {
  QUALIFICATION_RULE,
  workflowRun,
} from './fixtures/workflow-run-fixture.js';

const makeTempDir = trackTempDirs();
const enabledPreview = {
  select: <T>(branches: { enabled: () => T; disabled: () => T }) =>
    branches.enabled(),
};

const INTERVAL = 300_000;
const WORKFLOW_RUNS_URL =
  'https://api.github.com/repos/kontourai/station/actions/workflows/main-qualification.yml/runs?status=completed&per_page=20';

function configuration(
  rules: readonly AutomationRule[] = [QUALIFICATION_RULE],
): AutomationConfiguration {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: 'source-1',
        kind: 'github-poll',
        name: 'station',
        repository: 'kontourai/station',
        enabled: true,
        grants: [
          { projectId: 'station', agentId: 'repairer', actions: ['notify'] },
        ],
        credentialSecretBinding: 'github-token',
        pollIntervalMs: INTERVAL,
      },
    ],
    rules,
  };
}

function writeConfiguration(home: string, value: AutomationConfiguration) {
  const path = join(home, 'security', 'automations.json');
  mkdirSync(join(home, 'security'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** GitHub's list shape: `{ total_count, workflow_runs }`. */
function listing(runs: readonly unknown[], status = 200): Response {
  return new Response(
    JSON.stringify(
      status === 200
        ? { total_count: runs.length, workflow_runs: runs }
        : { message: 'Bad credentials' },
    ),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function resolver() {
  const settle = vi.fn();
  return {
    settle,
    resolveForIntegration: vi.fn(async () => ({
      environment: { GITHUB_TOKEN: 'ghs_test_token' },
      settlement: { settle },
    })),
  };
}

const iso = (ms: number) =>
  new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('github-poll through the built-in scheduler tick', () => {
  test('the scheduler tick polls the source and records a matched delivery, starting nothing', async () => {
    const home = makeTempDir('automation-poll-home-');
    writeConfiguration(home, configuration());
    const automationDirectory = join(home, 'automation');
    const credentials = resolver();
    const fetcher = vi.fn(async () =>
      listing([
        workflowRun({
          conclusion: 'failure',
          updatedAt: iso(Date.now() - 60_000),
        }),
      ]),
    );
    const turnAdapter = { invoke: vi.fn() };
    const shared = new SharedAutomationLedger(() =>
      createAutomationLedger({ directory: automationDirectory }),
    );
    const scheduler = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: join(home, 'scheduler') }),
      turnAdapter,
      automationPoller: new GitHubPollAutomationPoller({
        preview: enabledPreview,
        store: new AutomationStore(home),
        ledger: shared,
        fetcher,
        integrationSecretResolver: credentials as never,
      }),
    });
    const reader = createAutomationLedger({ directory: automationDirectory });
    try {
      scheduler.start();
      await vi.waitFor(() =>
        expect(reader.listDeliveries()).toEqual([
          expect.objectContaining({
            sourceId: 'source-1',
            semanticKey: 'workflow_run:37423043587:1:completed',
            outcome: 'matched',
            ruleId: 'rule-qualification',
            episodeId: '37423043587',
          }),
        ]),
      );
    } finally {
      await scheduler.stop();
    }
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(WORKFLOW_RUNS_URL);
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ghs_test_token',
    );
    // The external monitor's credential path: exact binding, settled once.
    expect(credentials.resolveForIntegration).toHaveBeenCalledWith({
      integrationId: 'automation:github-poll',
      secretEnvRefs: { GITHUB_TOKEN: 'github-token' },
    });
    expect(credentials.settle).toHaveBeenCalledExactlyOnceWith({
      outcome: 'success',
    });
    expect(reader.listEpisodes()).toEqual([
      expect.objectContaining({ episodeId: '37423043587', state: 'open' }),
    ]);
    // Observe-only: no scheduled turn and no action claim.
    expect(turnAdapter.invoke).not.toHaveBeenCalled();
    expect(reader.pollState('source-1')).toMatchObject({ lastOutcome: 'ok' });
    // stop() closed the poller's ledger: the next use reopens it.
    expect(() => shared.get().listDeliveries()).not.toThrow();
    shared.close();
    reader.close();
  });

  test('stop() waits for an in-flight poll and aborts its request', async () => {
    const home = makeTempDir('automation-poll-stop-');
    writeConfiguration(home, configuration());
    let aborted = false;
    const fetcher = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    );
    const close = vi.fn();
    const stopLedger = createAutomationLedger({
      directory: join(home, 'automation'),
    });
    const scheduler = new BuiltinScheduler({
      ledger: createSchedulerLedger({ directory: join(home, 'scheduler') }),
      turnAdapter: { invoke: vi.fn() },
      automationPoller: new GitHubPollAutomationPoller({
        preview: enabledPreview,
        store: new AutomationStore(home),
        ledger: {
          get: () => stopLedger,
          close,
        },
        fetcher,
        integrationSecretResolver: resolver() as never,
      }),
    });
    scheduler.start();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await scheduler.stop();
    expect(aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    stopLedger.close();
  });
});

describe('GitHubPollAutomationPoller', () => {
  let home: string;
  let directory: string;
  let ledger: AutomationLedger;
  const signal = new AbortController().signal;
  const T0 = Date.parse('2026-10-06T08:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    home = makeTempDir('automation-poller-');
    directory = join(home, 'automation');
    writeConfiguration(home, configuration());
    ledger = createAutomationLedger({ directory, busyTimeoutMs: 200 });
  });
  afterEach(() => {
    ledger.close();
    vi.useRealTimers();
  });

  function poller(fetcher: (url: string) => Promise<Response>) {
    const instance = new GitHubPollAutomationPoller({
      preview: enabledPreview,
      store: new AutomationStore(home),
      ledger: {
        get: () => ledger,
        close: () => undefined,
      },
      fetcher,
      integrationSecretResolver: resolver() as never,
    });
    return {
      poll: (input: Parameters<GitHubPollAutomationPoller['poll']>[0]) => {
        vi.setSystemTime(input.now);
        return instance.poll(input);
      },
    };
  }

  test('hosted composition offers no preview and constructs no poller despite a saved enabled choice', async () => {
    const registry = new FeaturePreviewRegistry(home, {
      info: () => undefined,
    } as never);
    const personal = composeGitHubAutomationObservation({
      hosted: false,
      featurePreviews: registry,
      store: new AutomationStore(home),
      ledger: { get: () => ledger, close: () => undefined },
    });
    expect(personal.poller).toBeDefined();
    await registry.setEnabled('github-automation-observations', true);
    const hostedRegistry = new FeaturePreviewRegistry(home, {
      info: () => undefined,
    } as never);
    const hosted = composeGitHubAutomationObservation({
      hosted: true,
      featurePreviews: hostedRegistry,
      store: new AutomationStore(home),
      ledger: { get: () => ledger, close: () => undefined },
    });
    expect(hosted).toEqual({ preview: undefined, poller: undefined });
    expect(
      hostedRegistry
        .list()
        .some((preview) => preview.id === 'github-automation-observations'),
    ).toBe(false);
  });

  test('disabled preview does no IO; disabling during a fetch discards the observation', async () => {
    const registry = new FeaturePreviewRegistry(home, {
      info: () => undefined,
    } as never);
    const preview = registry.bind({
      id: 'github-automation-observations',
      label: 'GitHub observations',
      description: 'Observe only',
    });
    const get = vi.fn(() => ledger);
    const fetcher = vi.fn(async () => {
      await registry.setEnabled('github-automation-observations', false);
      return listing([
        workflowRun({ conclusion: 'failure', updatedAt: iso(T0 - 1000) }),
      ]);
    });
    const subject = new GitHubPollAutomationPoller({
      preview,
      store: new AutomationStore(home),
      ledger: { get, close: () => undefined },
      fetcher,
      integrationSecretResolver: resolver() as never,
    });
    expect(await subject.poll({ now: T0, signal })).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await registry.setEnabled('github-automation-observations', true);
    await subject.poll({ now: T0, signal });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(ledger.listDeliveries()).toEqual([]);
    expect(ledger.pollState('source-1')).toBeUndefined();
  });

  test('a run finishing during the fetch is checked against response observation time', async () => {
    const subject = poller(async () => {
      vi.setSystemTime(T0 + 2000);
      return listing([
        workflowRun({ conclusion: 'failure', updatedAt: iso(T0 + 1000) }),
      ]);
    });
    expect(await subject.poll({ now: T0, signal })).toEqual([
      expect.objectContaining({ matched: 1, refused: 0 }),
    ]);
  });

  test('disabling the preview during the first workflow prevents another request', async () => {
    const second = {
      ...QUALIFICATION_RULE,
      id: 'rule-second',
      match: {
        ...QUALIFICATION_RULE.match,
        where: {
          ...QUALIFICATION_RULE.match.where,
          'workflow.path': '.github/workflows/nightly.yml',
        },
      },
    };
    writeConfiguration(home, configuration([QUALIFICATION_RULE, second]));
    const registry = new FeaturePreviewRegistry(home, {
      info: () => undefined,
    } as never);
    const preview = registry.bind({
      id: 'github-automation-observations',
      label: 'GitHub observations',
      description: 'Observe only',
    });
    await registry.setEnabled('github-automation-observations', true);
    const fetcher = vi.fn(async () => {
      await registry.setEnabled('github-automation-observations', false);
      return listing([]);
    });
    const subject = new GitHubPollAutomationPoller({
      preview,
      store: new AutomationStore(home),
      ledger: { get: () => ledger, close: () => undefined },
      fetcher,
      integrationSecretResolver: resolver() as never,
    });
    expect(await subject.poll({ now: T0, signal })).toEqual([
      expect.objectContaining({ outcome: 'skipped-disabled' }),
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(ledger.pollState('source-1')).toBeUndefined();
  });

  test('a bounded listing records partial coverage without advancing the cursor', async () => {
    const run = workflowRun({
      conclusion: 'failure',
      updatedAt: iso(T0 - 1000),
    });
    const subject = poller(async () =>
      Response.json({ total_count: 21, workflow_runs: [run] }),
    );
    expect(await subject.poll({ now: T0, signal })).toEqual([
      expect.objectContaining({ outcome: 'partial', matched: 1 }),
    ]);
    expect(ledger.pollState('source-1')).toMatchObject({
      lastOutcome: 'partial',
    });
    expect(ledger.pollState('source-1')?.cursorMs).toBeUndefined();
    expect(ledger.listPolls()).toEqual([
      {
        sourceId: 'source-1',
        lastPolledAt: new Date(T0).toISOString(),
        lastOutcome: 'partial',
      },
    ]);
    expect(await subject.poll({ now: T0 + INTERVAL, signal })).toEqual([
      expect.objectContaining({ outcome: 'partial', duplicate: 1 }),
    ]);
    expect(ledger.listDeliveries()).toHaveLength(1);
  });

  test('a future-dated refused run cannot move the cursor past valid observations', async () => {
    const run = workflowRun({
      conclusion: 'failure',
      updatedAt: iso(T0 + 86400000),
    });
    const subject = poller(async () => listing([run]));
    expect(await subject.poll({ now: T0, signal })).toEqual([
      expect.objectContaining({ refused: 1, matched: 0 }),
    ]);
    expect(ledger.pollState('source-1')?.cursorMs).toBe(T0 - 72 * 3600000);
  });

  test('source revocation during a fetch records no delivery or checkpoint', async () => {
    const subject = poller(async () => {
      const config = configuration();
      writeConfiguration(home, {
        ...config,
        sources: config.sources.map((source) => ({
          ...source,
          enabled: false,
        })),
      });
      return listing([
        workflowRun({ conclusion: 'failure', updatedAt: iso(T0 - 1000) }),
      ]);
    });
    await subject.poll({ now: T0, signal });
    expect(ledger.listDeliveries()).toEqual([]);
    expect(ledger.pollState('source-1')).toBeUndefined();
  });

  test('re-polling the same run is a duplicate; a new attempt is new; not-due polls nothing', async () => {
    const red = workflowRun({
      conclusion: 'failure',
      updatedAt: iso(T0 - 60_000),
    });
    const fetcher = vi.fn(async () => listing([red]));
    const subject = poller(fetcher);
    expect(await subject.poll({ now: T0, signal })).toEqual([
      expect.objectContaining({ outcome: 'ok', matched: 1 }),
    ]);
    expect(await subject.poll({ now: T0 + INTERVAL - 1, signal })).toEqual([
      expect.objectContaining({ outcome: 'skipped-not-due' }),
    ]);
    expect(fetcher).toHaveBeenCalledOnce();

    expect(await subject.poll({ now: T0 + INTERVAL, signal })).toEqual([
      expect.objectContaining({ outcome: 'ok', duplicate: 1, matched: 0 }),
    ]);
    expect(ledger.listDeliveries()).toHaveLength(1);

    const rerun = workflowRun({
      conclusion: 'failure',
      runAttempt: 2,
      updatedAt: iso(T0 + INTERVAL),
    });
    fetcher.mockImplementation(async () => listing([red, rerun]));
    expect(await subject.poll({ now: T0 + 2 * INTERVAL, signal })).toEqual([
      expect.objectContaining({ duplicate: 1, matched: 1 }),
    ]);
    expect(
      ledger.listDeliveries().map(({ semanticKey }) => semanticKey),
    ).toEqual([
      'workflow_run:37423043587:2:completed',
      'workflow_run:37423043587:1:completed',
    ]);
  });

  test('a stale run is refused once, then the cursor passes it', async () => {
    const stale = workflowRun({
      id: 1001,
      conclusion: 'failure',
      updatedAt: iso(T0 - 73 * 60 * 60 * 1000),
    });
    const fetcher = vi.fn(async () => listing([stale]));
    const subject = poller(fetcher);
    expect(await subject.poll({ now: T0, signal })).toEqual([
      expect.objectContaining({ refused: 1, seen: 1 }),
    ]);
    expect(ledger.listDeliveries()).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        reason: 'stale_event',
        semanticKey: 'workflow_run:1001:1:completed',
      }),
    ]);
    expect(await subject.poll({ now: T0 + INTERVAL, signal })).toEqual([
      expect.objectContaining({ refused: 0, seen: 0 }),
    ]);
    expect(ledger.listDeliveries()).toHaveLength(1);
  });

  test('a run inside the cursor overlap is re-read and dedupes', async () => {
    const early = workflowRun({
      id: 2001,
      conclusion: 'failure',
      updatedAt: iso(T0 - 1_000),
    });
    const fetcher = vi.fn(async () => listing([early]));
    const subject = poller(fetcher);
    await subject.poll({ now: T0, signal });
    const late = workflowRun({
      id: 2002,
      conclusion: 'success',
      updatedAt: iso(T0 - CURSOR_OVERLAP_MS / 2),
    });
    fetcher.mockImplementation(async () => listing([early, late]));
    expect(await subject.poll({ now: T0 + INTERVAL, signal })).toEqual([
      expect.objectContaining({ seen: 2, duplicate: 1, noMatch: 1 }),
    ]);
  });

  test('a malformed run is refused and never matched', async () => {
    const bad = workflowRun({
      id: 3001,
      conclusion: 'failure',
      updatedAt: iso(T0 - 1_000),
    });
    bad.head_sha = 'not-a-sha';
    const subject = poller(vi.fn(async () => listing([bad])));
    await subject.poll({ now: T0, signal });
    expect(ledger.listDeliveries()).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        reason: 'malformed_request',
      }),
    ]);
    expect(ledger.listEpisodes()).toEqual([]);
  });

  test('an unauthorized poll records no delivery and keeps the cursor', async () => {
    const subject = poller(vi.fn(async () => listing([], 401)));
    expect(await subject.poll({ now: T0, signal })).toEqual([
      expect.objectContaining({ outcome: 'unauthorized' }),
    ]);
    expect(ledger.listDeliveries()).toEqual([]);
    expect(ledger.pollState('source-1')).toEqual({
      sourceId: 'source-1',
      lastPolledAt: T0,
      lastOutcome: 'unauthorized',
    });
  });

  test('a source whose rules are all disabled spends no request', async () => {
    writeConfiguration(
      home,
      configuration([{ ...QUALIFICATION_RULE, enabled: false }]),
    );
    const fetcher = vi.fn(async () => listing([]));
    expect(await poller(fetcher).poll({ now: T0, signal })).toEqual([
      expect.objectContaining({ outcome: 'skipped-no-rules' }),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('a rule that leaves workflow.path open polls the whole repository', async () => {
    const open: AutomationRule = {
      ...QUALIFICATION_RULE,
      match: {
        type: 'github.workflow_run.completed',
        where: { 'run.conclusion': 'failure' },
      },
      episode: undefined,
    };
    writeConfiguration(home, configuration([open]));
    const fetcher = vi.fn(async (_url: string) => listing([]));
    await poller(fetcher).poll({ now: T0, signal });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/kontourai/station/actions/runs?status=completed&per_page=20',
    );
  });
});

describe('pinnedWorkflowFiles', () => {
  test('pins the files every matcher names, including closeOn', () => {
    expect(pinnedWorkflowFiles([QUALIFICATION_RULE])).toEqual([
      'main-qualification.yml',
    ]);
  });

  test('falls back to the repository when a path is outside .github/workflows', () => {
    expect(
      pinnedWorkflowFiles([
        {
          ...QUALIFICATION_RULE,
          match: {
            ...QUALIFICATION_RULE.match,
            where: { 'workflow.path': '../evil.yml' },
          },
        },
      ]),
    ).toBeUndefined();
  });
});
