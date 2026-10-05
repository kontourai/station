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
import { createChildDelegationContext } from '../../../runtime/agents/delegation.js';
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

/**
 * Per-call usage events as the Muse serve adapter writes them (a per-turn
 * reporter, so each event is its own receipt; Codex restates a cumulative
 * total that one receipt per engine process replaces).
 */
function usage(store: EventStore, threadId: string, count: number, from = 0) {
  for (let index = from; index < from + count; index += 1)
    store.appendEvent({
      eventId: `${threadId}:usage:${index}`,
      threadId,
      turnId: `${threadId}:turn:${index}`,
      provider: 'muse',
      method: 'token-usage.updated',
      createdAt: '2026-09-23T00:00:03.000Z',
      promptTokens: 10,
      completionTokens: 1,
    } as CanonicalRuntimeEvent);
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
    // for it, as what it is: a last-request size, never tokens used.
    expect(
      claudeSubagents.map((child) => child.own?.lastRequestTokens),
    ).toEqual(foldedSubagentTokens(ROOT));
    for (const child of claudeSubagents)
      expect(child.own?.totalTokens).toBeUndefined();
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

  test('a Claude conversation whose engine resumed its transcript reports the resumed running cost once (station#3320)', () => {
    const store = fixtureStore();
    // The cost-bearing usage event the Claude adapter's result handler
    // writes; figures from a live Agent SDK 0.3.278 probe, where the resumed
    // query() reported 0.0324923 already including the first 0.030603.
    const result = (reportedCostUsd: number) =>
      store.appendEvent({
        eventId: `${ROOT}:result:${++ordinal}`,
        threadId: ROOT,
        turnId: `${ROOT}:turn:${ordinal}`,
        provider: 'claude',
        method: 'token-usage.updated',
        createdAt: '2026-09-23T00:00:03.000Z',
        promptTokens: 10,
        completionTokens: 3,
        reportedCostUsd,
      } as CanonicalRuntimeEvent);
    start(store, ROOT, 'claude', { cwd: '/work' });
    result(0.030603);
    // The adapter's session.started for a query() built with `resume`.
    start(store, ROOT, 'claude', { cwd: '/work', nativeSessionResumed: true });
    result(0.030603);
    result(0.0324923);
    const outcome = service(store).readThreadUsageTree(ROOT, as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    // One receipt per engine process would report 0.0630953.
    expect(outcome.tree.root.own?.reportedCost).toHaveLength(1);
    expect(outcome.tree.root.own?.reportedCost?.[0]?.amount).toBeCloseTo(
      0.0324923,
      10,
    );
    expect(outcome.tree.total.cost.reportedCost).toHaveLength(1);
    expect(outcome.tree.total.cost.reportedCost?.[0]?.amount).toBeCloseTo(
      0.0324923,
      10,
    );
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

  test('a delegate on a paired Station, recorded by the real dispatch writer, is shown and makes the total partial', () => {
    const store = fixtureStore();
    start(store, 'conv-codex', 'codex');
    const svc = service(store);
    // What delegateTask records after forwarding to a peer: its own thread id,
    // the REMOTE task id, and the parent conversation the route resolved.
    const peerThread = svc.recordPeerDelegationActivityDispatch({
      taskId: 'remote-task-1',
      conversationId: 'remote-task-1',
      prompt: 'Build it on the lab Station',
      userId: OWNER,
      environment: { id: 'env-peer', name: 'Lab', kind: 'peer' },
      target: { kind: 'agent', id: 'agent-x' },
      parentConversationId: 'conv-codex',
    });
    expect(peerThread).not.toBe('remote-task-1');
    const outcome = svc.readThreadUsageTree('conv-codex', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.root.children).toHaveLength(1);
    const [peer] = outcome.tree.root.children;
    expect(peer).toMatchObject({
      kind: 'station-delegate',
      id: peerThread,
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

  test('a peer dispatch naming the conversation only by parentTaskId is found too', () => {
    const store = fixtureStore();
    start(store, 'conv-codex', 'codex');
    const svc = service(store);
    svc.recordPeerDelegationActivityDispatch({
      taskId: 'remote-task-2',
      conversationId: 'remote-task-2',
      prompt: 'p',
      userId: OWNER,
      environment: { id: 'env-peer', name: 'Lab', kind: 'peer' },
      target: { kind: 'agent', id: 'agent-x' },
      parentTaskId: 'conv-codex',
    });
    const outcome = svc.readThreadUsageTree('conv-codex', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.root.children.map((child) => child.location)).toEqual([
      'paired-station',
    ]);
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

  test('a session the reader cannot read that names the conversation is ignored, not counted as missing', () => {
    const store = fixtureStore();
    start(store, 'conv-codex', 'codex');
    usage(store, 'conv-codex', 1);
    start(
      store,
      'private-task',
      'codex',
      delegateMetadata('private-task', 'conv-codex'),
      'someone-else',
    );
    usage(store, 'private-task', 5);
    const outcome = service(store).readThreadUsageTree('conv-codex', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.root.children).toEqual([]);
    expect(outcome.tree.total.tokens).toMatchObject({
      totalTokens: 11,
      complete: true,
    });
    expect(outcome.tree.total.partialReasons).toEqual([]);
    store.close();
  });

  test('#3323: an unreadable peer dispatch whose link Station derived makes the total partial; a claimed one is ignored', () => {
    const store = fixtureStore();
    start(store, 'conv-codex', 'codex');
    usage(store, 'conv-codex', 1);
    const svc = service(store);
    const dispatch = (
      taskId: string,
      provenance: 'caller-derived' | 'direct-claim',
    ) =>
      svc.recordPeerDelegationActivityDispatch({
        taskId,
        conversationId: taskId,
        prompt: `Secret ${taskId}`,
        // In hosted mode Station's own requests act as the operator.
        userId: 'station-operator',
        environment: { id: 'env-peer', name: 'Lab', kind: 'peer' },
        target: { kind: 'agent', id: 'agent-x' },
        parentConversationId: 'conv-codex',
        delegationProvenance: provenance,
      });
    const claimed = dispatch('remote-claimed', 'direct-claim');
    let outcome = svc.readThreadUsageTree('conv-codex', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.total.tokens.complete).toBe(true);
    expect(outcome.tree.total.partialReasons).toEqual([]);

    const derived = dispatch('remote-derived', 'caller-derived');
    outcome = svc.readThreadUsageTree('conv-codex', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.root.children).toEqual([]);
    expect(outcome.tree.total.tokens).toMatchObject({
      totalTokens: 11,
      complete: false,
    });
    expect(outcome.tree.total.partialReasons).toEqual([
      "1 delegated task runs under an owner you can't read, so its usage is not counted.",
    ]);
    const text = JSON.stringify(outcome.tree);
    for (const hidden of [claimed, derived, 'Secret'])
      expect(text).not.toContain(hidden);
    store.close();
  });

  test('#3323: a provenance stamp counts only on the start that names the parent, never on a later configuration', () => {
    const store = fixtureStore();
    start(store, 'conv-codex', 'codex');
    const context = createChildDelegationContext({
      agentSlug: 'coder',
      conversationId: 'conv-codex',
    });
    // Started with a claimed context, then a configuration carrying the
    // stamp: a start is the only row a dispatch route stamps.
    start(
      store,
      'claimed-task',
      'codex',
      { taskId: 'claimed-task', delegation: context },
      'someone-else',
    );
    store.appendEvent({
      eventId: 'claimed-task:configured',
      threadId: 'claimed-task',
      sessionId: 'claimed-task',
      provider: 'codex',
      method: 'session.configured',
      createdAt: '2026-09-23T00:00:02.000Z',
      metadata: {
        delegation: context,
        stationDelegationProvenance: 'runtime-attested',
      },
    } as CanonicalRuntimeEvent);
    // Stamped on its start, but naming another conversation there (and
    // claiming this one by parentTaskId); a later configuration names this
    // one. The other id sorts first, so the link the read picks is this
    // conversation's, which the stamp never vouched for.
    start(
      store,
      'other-parent',
      'codex',
      {
        taskId: 'other-parent',
        parentTaskId: 'conv-codex',
        delegation: createChildDelegationContext({
          agentSlug: 'coder',
          conversationId: 'conv-a-elsewhere',
        }),
        stationDelegationProvenance: 'runtime-attested',
      },
      'someone-else',
    );
    store.appendEvent({
      eventId: 'other-parent:configured',
      threadId: 'other-parent',
      sessionId: 'other-parent',
      provider: 'codex',
      method: 'session.configured',
      createdAt: '2026-09-23T00:00:02.000Z',
      metadata: { parentConversationId: 'conv-codex' },
    } as CanonicalRuntimeEvent);
    const outcome = service(store).readThreadUsageTree('conv-codex', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.total.tokens.complete).toBe(true);
    expect(outcome.tree.total.partialReasons).toEqual([]);
    // Control: the same unreadable start, stamped where it names the parent.
    start(
      store,
      'attested-task',
      'codex',
      {
        taskId: 'attested-task',
        delegation: context,
        stationDelegationProvenance: 'runtime-attested',
      },
      'someone-else',
    );
    const control = service(store).readThreadUsageTree('conv-codex', as(OWNER));
    if (control.status !== 'found') throw new Error(control.status);
    expect(control.tree.total.tokens.complete).toBe(false);
    expect(control.tree.total.partialReasons).toHaveLength(1);
    store.close();
  });

  test('unreadable sessions naming the conversation never crowd out a readable delegate', () => {
    const store = fixtureStore();
    start(store, 'conv-h', 'codex');
    for (let index = 0; index < 250; index += 1)
      start(
        store,
        `hid-${index}`,
        'codex',
        delegateMetadata(`hid-${index}`, 'conv-h'),
        'someone-else',
      );
    start(store, 'vis', 'codex', delegateMetadata('vis', 'conv-h'));
    usage(store, 'vis', 1);
    const outcome = service(store).readThreadUsageTree('conv-h', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.root.children.map((child) => child.id)).toEqual([
      'vis',
    ]);
    expect(outcome.tree.total.tokens.totalTokens).toBe(11);
    store.close();
  });

  test('a level with 1,000 delegate records is read; 1,001 is refused, readable or not', () => {
    const store = fixtureStore();
    start(store, 'conv-many', 'codex');
    for (let index = 0; index < 1000; index += 1)
      start(
        store,
        `many-${index}`,
        'codex',
        delegateMetadata(`many-${index}`, 'conv-many'),
        'someone-else',
      );
    const atBound = service(store).readThreadUsageTree('conv-many', as(OWNER));
    expect(atBound.status).toBe('found');
    start(
      store,
      'many-1000',
      'codex',
      delegateMetadata('many-1000', 'conv-many'),
      'someone-else',
    );
    expect(service(store).readThreadUsageTree('conv-many', as(OWNER))).toEqual({
      status: 'too-large',
      limit: 'delegate-records',
      max: 1000,
    });
    store.close();
  });

  test('a delegate launched by an agent of the conversation is found by its delegation context, with no parentTaskId', () => {
    const store = fixtureStore();
    start(store, 'conv-agent', 'claude');
    // What the route stamps for an engine session's delegate_task call: the
    // context derived from the calling session's own conversation.
    start(store, 'task-ctx', 'codex', {
      taskId: 'task-ctx',
      delegation: createChildDelegationContext({
        agentSlug: 'coder',
        conversationId: 'conv-agent',
      }),
    });
    usage(store, 'task-ctx', 2);
    // A parentTaskId claim never overrides a delegation context naming
    // another conversation.
    start(store, 'task-elsewhere', 'codex', {
      taskId: 'task-elsewhere',
      parentTaskId: 'conv-agent',
      delegation: createChildDelegationContext({
        agentSlug: 'coder',
        conversationId: 'conv-other',
      }),
    });
    usage(store, 'task-elsewhere', 3);
    const outcome = service(store).readThreadUsageTree('conv-agent', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.root.children.map((child) => child.id)).toEqual([
      'task-ctx',
    ]);
    expect(outcome.tree.total.tokens.totalTokens).toBe(22);
    store.close();
  });

  test('a delegate naming a later session of the conversation is found, and the lineage itself is not a child', () => {
    const store = fixtureStore();
    start(store, 'root-l', 'codex');
    store.reserveNextConversationSession({
      conversationId: 'root-l',
      predecessorSessionId: 'root-l',
      proposedSessionId: 'root-l:session:2',
      createdAt: '2026-09-23T00:00:05.000Z',
    });
    // The successor session carries launch metadata naming its own
    // conversation; it is the conversation's own usage, counted once.
    start(store, 'root-l:session:2', 'codex', {
      taskId: 'root-l:session:2',
      parentTaskId: 'root-l',
    });
    usage(store, 'root-l:session:2', 1);
    start(
      store,
      'task-l',
      'codex',
      delegateMetadata('task-l', 'root-l:session:2'),
    );
    usage(store, 'task-l', 1);
    const outcome = service(store).readThreadUsageTree('root-l', as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(outcome.tree.root.children.map((child) => child.id)).toEqual([
      'task-l',
    ]);
    expect(outcome.tree.total.tokens.totalTokens).toBe(22);
    store.close();
  });

  test("a child-work delta naming another session as its reporter is not this conversation's subagent", () => {
    const store = fixtureStore();
    seedClaudeRoot(store);
    // The same real frames, reported by another session but written on this
    // conversation's thread.
    append(
      store,
      replayClaudeTaskCapture('task-subagents', { threadId: 'elsewhere' })
        .events.filter((event) => event.method === 'child-work.updated')
        .map((event) => ({
          ...event,
          eventId: `misfiled:${event.eventId}`,
          threadId: ROOT,
        })),
    );
    const outcome = service(store).readThreadUsageTree(ROOT, as(OWNER));
    if (outcome.status !== 'found') throw new Error(outcome.status);
    expect(
      outcome.tree.root.children.filter(
        (child) => child.kind === 'engine-subagent',
      ),
    ).toHaveLength(foldedSubagentTokens(ROOT).length);
    store.close();
  });

  test('delegates nest to the depth bound; one level deeper is refused', () => {
    const store = fixtureStore();
    start(store, 'd0', 'codex');
    for (let level = 1; level <= 8; level += 1)
      start(
        store,
        `d${level}`,
        'codex',
        delegateMetadata(`d${level}`, `d${level - 1}`),
      );
    const atBound = service(store).readThreadUsageTree('d0', as(OWNER));
    expect(atBound.status === 'found' && atBound.tree.nodeCount).toBe(9);
    start(store, 'd9', 'codex', delegateMetadata('d9', 'd8'));
    expect(service(store).readThreadUsageTree('d0', as(OWNER))).toEqual({
      status: 'too-large',
      limit: 'depth',
      max: 8,
    });
    store.close();
  });

  test('5,000 usage observations across the tree are read; one more is refused', () => {
    const store = fixtureStore();
    start(store, 'e0', 'codex');
    start(store, 'e1', 'codex', delegateMetadata('e1', 'e0'));
    usage(store, 'e0', 3_000);
    usage(store, 'e1', 2_000);
    const atBound = service(store).readThreadUsageTree('e0', as(OWNER));
    expect(
      atBound.status === 'found' && atBound.tree.total.tokens.totalTokens,
    ).toBe(55_000);
    usage(store, 'e1', 1, 9_000);
    expect(service(store).readThreadUsageTree('e0', as(OWNER))).toEqual({
      status: 'too-large',
      limit: 'usage-events',
      max: 5_000,
    });
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
