import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AfterToolCallEvent } from '@strands-agents/sdk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventStore } from '../../services/orchestration/event-store.js';
import { createMCPToolProvenanceGeneration } from '../../services/orchestration/mcp-tool-provenance.js';
import { createAgentHooks } from '../agents/agent-hooks.js';
import { runWithAuthorizedTurnCorrelation } from '../conversation/authorized-turn-correlation.js';
import {
  bindStrandsInvocationContext,
  wireStrandsAgentHooks,
} from '../frameworks/strands-agent-hooks.js';
import {
  createVoltAgentLifecycleHooks,
  toVoltAgentTool,
} from '../frameworks/voltagent-adapter.js';
import { normalizeLoadedMCPTools } from '../tools/mcp-tool-names.js';
import { WorkItemCapture } from '../work-item-capture.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function store() {
  const directory = mkdtempSync(join(tmpdir(), 'station-work-item-framework-'));
  directories.push(directory);
  const value = new EventStore(join(directory, 'orchestration.sqlite'));
  value.upsertSession({
    provider: 'station-agent',
    threadId: 'session-1',
    status: 'ready',
    createdAt: '2026-08-28T12:00:00.000Z',
    updatedAt: '2026-08-28T12:00:00.000Z',
  });
  return value;
}

function complete(store: EventStore) {
  expect(
    store.listSessionWorkItemObservations({
      sessionId: 'session-1',
      conversationId: 'session-1',
    }),
  ).toEqual([]);
  store.appendEvent({
    eventId: 'event-1',
    provider: 'station-agent',
    threadId: 'session-1',
    turnId: 'turn-1',
    createdAt: '2026-08-28T12:01:00.000Z',
    method: 'tool.completed',
    itemId: 'call-1',
    toolCallId: 'call-1',
    toolName: 'github_createIssue',
    status: 'success',
  } as any);
  expect(
    store.listSessionWorkItemObservations({
      sessionId: 'session-1',
      conversationId: 'session-1',
    }),
  ).toHaveLength(1);
}

function managedHooks(store: EventStore) {
  return createAgentHooks({
    spec: { tools: { autoApprove: ['github_createIssue'] } } as any,
    appConfig: {},
    configLoader: {} as any,
    agentFixedTokens: new Map(),
    memoryAdapters: new Map(),
    toolNameMapping: new Map(),
    logger: { debug: vi.fn(), warn: vi.fn() },
    isCurrentRuntimeGeneration: () => true,
    workItemCapture: new WorkItemCapture(store, () => true),
  });
}

function content() {
  return [
    {
      type: 'text',
      text: JSON.stringify({
        id: '1234567890',
        url: 'https://github.com/kontourai/station/issues/235',
      }),
    },
  ];
}

describe('managed framework work-item capture ordering', () => {
  test('VoltAgent lifecycle stages before the relay can append its canonical terminal', async () => {
    const eventStore = store();
    try {
      const generation = createMCPToolProvenanceGeneration();
      const [loaded] = normalizeLoadedMCPTools(
        'planner',
        [{ name: 'github_createIssue', execute: vi.fn() }] as any,
        new Map(),
        new Map(),
        generation,
        'github',
        () => ({ serverId: 'github', originalToolName: 'create_issue' }),
        { debug: vi.fn() },
      );
      const lifecycle = createVoltAgentLifecycleHooks(
        'planner',
        managedHooks(eventStore),
      );
      const tool = toVoltAgentTool(loaded as any);
      await runWithAuthorizedTurnCorrelation(
        {
          accountId: 'account-1',
          sessionId: 'session-1',
          turnId: 'turn-1',
          correlationId: 'correlation-1',
        },
        async () => {
          const context = {
            conversationId: 'session-1',
            userId: 'user-1',
            context: new Map(),
          } as any;
          await lifecycle.onToolStart!({
            agent: {} as any,
            tool,
            context,
            args: { owner: 'kontourai', repo: 'station', title: 'Capture' },
            options: { toolContext: { callId: 'call-1' } } as any,
          });
          await lifecycle.onToolEnd!({
            agent: {} as any,
            tool,
            context,
            output: content(),
            error: undefined,
            options: { toolContext: { callId: 'call-1' } } as any,
          });
        },
      );
      complete(eventStore);
    } finally {
      eventStore.close();
    }
  });

  test('Strands AfterToolCall lifecycle stages before the relay can append its canonical terminal', () => {
    const eventStore = store();
    try {
      const callbacks = new Map<any, any>();
      const generation = createMCPToolProvenanceGeneration();
      const provenance = generation.mint({
        serverId: 'github',
        originalToolName: 'create_issue',
        runtimeName: 'github_createIssue',
        integrationId: 'github',
      });
      const state: Record<string, unknown> = {};
      bindStrandsInvocationContext(state, {
        agentSlug: 'planner',
        conversationId: 'session-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        principalId: 'account-1',
        userId: 'user-1',
      });
      wireStrandsAgentHooks({
        strandsAgent: {
          addHook: (type: any, handler: any) => callbacks.set(type, handler),
        } as any,
        hooks: managedHooks(eventStore),
        deniedToolCalls: new Map(),
        invocationCtx: { agentSlug: 'planner' },
        memoryAdapter: {} as any,
        logger: { info: vi.fn() },
        resolvedModel: 'test',
        getLastStreamUsage: () => null,
        findMCPToolProvenance: () => provenance,
      });
      callbacks.get(AfterToolCallEvent)({
        invocationState: state,
        toolUse: {
          name: 'github_createIssue',
          toolUseId: 'call-1',
          input: { owner: 'kontourai', repo: 'station', title: 'Capture' },
        },
        result: { content: content() },
      });
      complete(eventStore);
    } finally {
      eventStore.close();
    }
  });
});
