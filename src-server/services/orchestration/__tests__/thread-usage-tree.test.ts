/**
 * A conversation's usage tree, read through the service from a real event
 * store holding what the real writers produce: Claude Code task frames and
 * results replayed through the Claude adapter's own mapper, a Codex collab
 * capture replayed through the Codex transport, and delegate sessions with
 * the launch metadata the delegation path stamps.
 *
 * Expected figures are read from the raw captures here, not from the code
 * under test.
 */
import { join } from 'node:path';
import {
  applyChildWorkDelta,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { ThreadUsageNode } from '@kontourai/station-contracts/thread-usage-tree';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  loadClaudeTaskCapture,
  replayClaudeTaskCapture,
} from '../../../providers/__tests__/claude-task-captures.js';
import {
  CODEX_COLLAB_STATION_THREAD,
  CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED,
  replayCodexCapture,
} from '../../../providers/__tests__/codex-collab-fixtures.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();
const OWNER = 'usage-owner';
const ROOT = 'conv-claude';
const as = (userId: string) =>
  sessionReadAuthorityFromRequest(userId, undefined, undefined);

let ordinal = 0;
function start(
  store: EventStore,
  threadId: string,
  provider: string,
  metadata: Record<string, unknown> = {},
  userId = OWNER,
) {
  store.upsertSession({
    provider: provider as never,
    threadId,
    status: 'closed',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:01.000Z',
  });
  store.appendEvent({
    eventId: `${threadId}:start:${++ordinal}`,
    threadId,
    sessionId: threadId,
    provider,
    method: 'session.started',
    createdAt: '2026-09-23T00:00:00.000Z',
    metadata: { userId, ...metadata },
  } as CanonicalRuntimeEvent);
}

function append(store: EventStore, events: CanonicalRuntimeEvent[]) {
  for (const event of events) store.appendEvent(event);
}

/** A delegated task, as the delegation path stamps its launch. */
function delegateMetadata(taskId: string, parentTaskId: string, extra = {}) {
  return {
    taskId,
    parentTaskId,
    delegationTitle: `Delegated ${taskId}`,
    ...extra,
  };
}

function service(store: EventStore) {
  const created = new OrchestrationService({
    eventStore: store,
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  } as never);
  created.initialize();
  return created;
}

function fixtureStore() {
  const directory = makeTempDir('thread-usage-tree-');
  return new EventStore(join(directory, 'orchestration.sqlite'));
}

/** The Claude capture's own figures: per-turn tokens, the latest running cost. */
function claudeCaptureFigures() {
  const lines = loadClaudeTaskCapture('task-subagents').flatMap((line) =>
    line.message ? [line.message as Record<string, any>] : [],
  );
  const results = lines.filter((line) => line.type === 'result');
  const notifications = lines.filter(
    (line) => line.type === 'system' && line.subtype === 'task_notification',
  );
  return {
    tokens: results.reduce(
      (sum, line) => sum + line.usage.input_tokens + line.usage.output_tokens,
      0,
    ),
    cost: results.at(-1)!.total_cost_usd as number,
    subagentTokens: notifications.map((line) => line.usage.total_tokens),
  };
}

/** The Codex capture's own figures: the parent's last cumulative total, the child's. */
function codexCaptureFigures() {
  const usage = CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED.map(
    (line) => JSON.parse(line).msg,
  ).filter((msg) => msg?.method === 'thread/tokenUsage/updated');
  const parentId = usage[0].params.threadId;
  const parent = usage.filter((msg) => msg.params.threadId === parentId);
  const child = usage.filter((msg) => msg.params.threadId !== parentId);
  return {
    parentTokens: parent.at(-1).params.tokenUsage.total.totalTokens as number,
    childTokens: child.at(-1).params.tokenUsage.total.totalTokens as number,
  };
}

/** What the child-work contract's own reducer keeps for each Claude subagent. */
function foldedSubagentTokens(threadId: string) {
  let registry = createEmptyChildWorkRegistry();
  for (const event of replayClaudeTaskCapture('task-subagents', { threadId })
    .events)
    if (event.method === 'child-work.updated')
      registry = applyChildWorkDelta(registry, event.delta);
  return childWorkForReporter(registry, threadId).map(
    (item) => item.usage?.totalTokens,
  );
}

function walk(node: ThreadUsageNode): ThreadUsageNode[] {
  return [node, ...node.children.flatMap(walk)];
}

function seedClaudeRoot(store: EventStore) {
  start(store, ROOT, 'claude');
  append(
    store,
    replayClaudeTaskCapture('task-subagents', { threadId: ROOT }).events,
  );
}

function seedCodexDelegate(store: EventStore, parent = ROOT) {
  start(
    store,
    CODEX_COLLAB_STATION_THREAD,
    'codex',
    delegateMetadata(CODEX_COLLAB_STATION_THREAD, parent),
  );
  append(
    store,
    replayCodexCapture(CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED).events,
  );
}

describe('conversation usage tree', () => {
  test('a Claude parent with a Codex delegate totals its own turns, the delegate and the delegate subagent, and counts no Claude subagent tokens', () => {
    const store = fixtureStore();
    seedClaudeRoot(store);
    seedCodexDelegate(store);
    const claude = claudeCaptureFigures();
    const codex = codexCaptureFigures();
    const outcome = service(store).readThreadUsageTree(ROOT, as(OWNER));
    expect(outcome.status).toBe('found');
    if (outcome.status !== 'found') return;
    const { tree } = outcome;

    expect(tree.root.own?.totalTokens).toBe(claude.tokens);
    expect(tree.root.own?.reportedCost).toEqual([
      { amount: claude.cost, currency: 'USD' },
    ]);
    const claudeSubagents = tree.root.children.filter(
      (child) => child.kind === 'engine-subagent',
    );
    // Each subagent keeps the figure the child-work contract's own fold keeps
    // for it (the read must not re-derive child usage another way).
    expect(claudeSubagents.map((child) => child.own?.totalTokens)).toEqual(
      foldedSubagentTokens(ROOT),
    );
    for (const child of claudeSubagents)
      expect(child.relation).toMatchObject({
        tokens: 'not-reported',
        cost: 'included-in-parent',
      });

    const delegate = tree.root.children.find(
      (child) => child.kind === 'station-delegate',
    )!;
    expect(delegate).toMatchObject({
      id: CODEX_COLLAB_STATION_THREAD,
      location: 'local',
      depth: 1,
      relation: { tokens: 'added', cost: 'added' },
    });
    expect(delegate.own?.totalTokens).toBe(codex.parentTokens);
    const codexChild = delegate.children.find(
      (child) => child.kind === 'engine-subagent',
    )!;
    expect(codexChild).toMatchObject({
      depth: 2,
      own: { totalTokens: codex.childTokens },
      relation: { tokens: 'added', cost: 'not-reported' },
    });

    // The Claude subagents' figures (each a last-request size) stay out; the
    // delegate and its own subagent are added.
    expect(tree.total.tokens.totalTokens).toBe(
      claude.tokens + codex.parentTokens + codex.childTokens,
    );
    expect(tree.total.tokens.complete).toBe(false);
    expect(tree.total.cost.reportedCost).toEqual([
      { amount: claude.cost, currency: 'USD' },
    ]);
    expect(tree.nodeCount).toBe(walk(tree.root).length);
    store.close();
  });

  test('a subagent whose cost is included in its parent is not added and does not make the cost partial', () => {
    const store = fixtureStore();
    seedClaudeRoot(store);
    const claude = claudeCaptureFigures();
    const outcome = service(store).readThreadUsageTree(ROOT, as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    const { total } = outcome.tree;
    // Two settled subagents with tens of thousands of reported tokens each:
    // none of it reaches the total, and the cost is the parent's alone.
    expect(claude.subagentTokens.length).toBe(2);
    expect(total.tokens.totalTokens).toBe(claude.tokens);
    expect(total.cost.reportedCost).toEqual([
      { amount: claude.cost, currency: 'USD' },
    ]);
    expect(total.cost.complete).toBe(true);
    // The tokens are partial, and say why.
    expect(total.tokens.complete).toBe(false);
    expect(total.partialReasons).toEqual([
      expect.stringMatching(
        /^Tokens not counted: Claude Code .*\(2 children\)$/,
      ),
    ]);
    store.close();
  });

  test('a delegate on a paired Station is shown and makes the total partial', () => {
    const store = fixtureStore();
    start(store, 'conv-codex', 'codex');
    start(
      store,
      'peer-task',
      'codex',
      delegateMetadata('peer-task', 'conv-codex', { environmentKind: 'peer' }),
    );
    const outcome = service(store).readThreadUsageTree('conv-codex', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    const [peer] = outcome.tree.root.children;
    expect(peer).toMatchObject({
      kind: 'station-delegate',
      id: 'peer-task',
      location: 'paired-station',
      relation: { tokens: 'not-reported', cost: 'not-reported' },
    });
    expect(peer.own).toBeUndefined();
    expect(outcome.tree.total.tokens.complete).toBe(false);
    expect(outcome.tree.total.cost.complete).toBe(false);
    expect(outcome.tree.total.partialReasons.join(' ')).toMatch(
      /paired Station/,
    );
    store.close();
  });

  test('estimates under different currencies stay separate buckets and reported cost stays apart from them', () => {
    const store = fixtureStore();
    seedClaudeRoot(store);
    const snapshot = (id: string, currency: string, model: string) => ({
      id,
      capturedAt: '2026-09-01T00:00:00.000Z',
      currency,
      provider: 'codex',
      model,
      inputPerMillion: 1,
      outputPerMillion: 2,
    });
    for (const [taskId, currency] of [
      ['task-usd', 'USD'],
      ['task-eur', 'EUR'],
    ] as const) {
      start(store, taskId, 'codex', delegateMetadata(taskId, ROOT));
      store.appendEvent({
        eventId: `${taskId}:configured`,
        threadId: taskId,
        sessionId: taskId,
        provider: 'codex',
        method: 'session.configured',
        createdAt: '2026-09-23T00:00:02.000Z',
        model: 'gpt-test',
      } as CanonicalRuntimeEvent);
      store.appendEvent({
        eventId: `${taskId}:usage`,
        threadId: taskId,
        turnId: `${taskId}:turn`,
        provider: 'codex',
        method: 'token-usage.updated',
        createdAt: '2026-09-23T00:00:03.000Z',
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        pricingSnapshot: snapshot(`snap-${currency}`, currency, 'gpt-test'),
      } as CanonicalRuntimeEvent);
    }
    const outcome = service(store).readThreadUsageTree(ROOT, as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    const { cost } = outcome.tree.total;
    expect(
      [...(cost.estimatedCost ?? [])].sort((a, b) =>
        a.currency.localeCompare(b.currency),
      ),
    ).toEqual([
      expect.objectContaining({
        amount: 3,
        currency: 'EUR',
        pricingSnapshotId: 'snap-EUR',
      }),
      expect.objectContaining({
        amount: 3,
        currency: 'USD',
        pricingSnapshotId: 'snap-USD',
      }),
    ]);
    // The provider-reported Claude cost is never folded into an estimate.
    expect(cost.reportedCost).toEqual([
      { amount: claudeCaptureFigures().cost, currency: 'USD' },
    ]);
    store.close();
  });

  test('a delegate the reader cannot read is counted as missing and never described', () => {
    const store = fixtureStore();
    start(store, 'conv-codex', 'codex');
    start(
      store,
      'private-task',
      'codex',
      delegateMetadata('private-task', 'conv-codex'),
      'someone-else',
    );
    const outcome = service(store).readThreadUsageTree('conv-codex', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.root.children).toEqual([]);
    expect(outcome.tree.total.tokens.complete).toBe(false);
    expect(outcome.tree.total.partialReasons).toEqual([
      '1 delegated task is not visible to you and not counted.',
    ]);
    store.close();
  });

  test('a reader who cannot read the conversation gets nothing', () => {
    const store = fixtureStore();
    seedClaudeRoot(store);
    expect(
      service(store).readThreadUsageTree(ROOT, as('stranger')).status,
    ).toBe('not-found');
    store.close();
  });

  test('a tree at its node bound is read whole; one node past it is refused, not cut', () => {
    const store = fixtureStore();
    start(store, 'conv-wide', 'codex');
    // 199 delegates plus the root is exactly the 200-node bound.
    for (let index = 0; index < 199; index += 1)
      start(
        store,
        `wide-${index}`,
        'codex',
        delegateMetadata(`wide-${index}`, 'conv-wide'),
      );
    const atBound = service(store).readThreadUsageTree('conv-wide', as(OWNER));
    expect(atBound.status === 'found' && atBound.tree.nodeCount).toBe(200);
    start(
      store,
      'wide-199',
      'codex',
      delegateMetadata('wide-199', 'conv-wide'),
    );
    const outcome = service(store).readThreadUsageTree('conv-wide', as(OWNER));
    expect(outcome).toEqual({ status: 'too-large', limit: 'nodes', max: 200 });
    store.close();
  });
});
