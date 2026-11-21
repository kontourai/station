/**
 * The resolver's child-fan-out refusal (`delegated_tool_blocked`), through the
 * production `createRequestDelegationResolver` over stand-in records of the
 * calling session. The route-level refusal is in
 * `routes/orchestration/__tests__/orchestration-portable-delegation.test.ts`.
 */
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import { describe, expect, test } from 'vitest';
import type { StationControlCaller } from '../../../tools/station-control-shared.js';
import { createChildDelegationContext } from '../delegation.js';
import {
  createRequestDelegationResolver,
  type DelegationFanOutTool,
  type RequestDelegationSources,
} from '../request-delegation.js';

const CALLER: StationControlCaller = {
  sessionId: 'session-caller',
  assurance: 'bound',
  conversationId: 'conversation-caller',
};

function resolver(started: Record<string, unknown> | undefined) {
  const sources: RequestDelegationSources = {
    isInternalRequest: () => true,
    resolveCaller: () => CALLER,
    startedMetadata: () => started,
    sessionEngine: () => 'codex',
    loadAgentSpec: async () => ({}) as never,
    isRegistryDefaultAgent: async () => true,
  };
  return createRequestDelegationResolver(sources);
}

const request = new Request('http://station.test/delegations', {
  method: 'POST',
});

/** A recorded context exactly as `createChildDelegationContext` produces it. */
function childRecord(
  overrides: Partial<AgentDelegationContext> = {},
): Record<string, unknown> {
  return {
    agentSlug: 'child-agent',
    delegation: {
      ...createChildDelegationContext({
        agentSlug: 'root-agent',
        conversationId: 'conversation-root',
      }),
      ...overrides,
    },
  };
}

const TOOLS: DelegationFanOutTool[] = ['delegate_task', 'send_message'];

describe('createRequestDelegationResolver child fan-out', () => {
  test('derives a tracked grandchild from the caller while preserving the root and restrictions', async () => {
    await expect(
      resolver(childRecord({ blockedTools: ['shell_*'] }))(request, {
        tool: 'delegate_task',
        delegation: {
          ...(childRecord().delegation as AgentDelegationContext),
          rootConversationId: 'forged',
        },
      }),
    ).resolves.toMatchObject({
      provenance: 'caller-derived',
      context: {
        depth: 2,
        maxDepth: 2,
        parentConversationId: 'conversation-caller',
        parentSessionId: 'session-caller',
        rootConversationId: 'conversation-root',
        blockedTools: expect.arrayContaining(['shell_*']),
        denyApprovals: true,
      },
    });
  });

  test('refuses a child at the inherited depth limit', async () => {
    await expect(
      resolver(childRecord({ depth: 1, maxDepth: 1 }))(request, {
        tool: 'delegate_task',
      }),
    ).rejects.toMatchObject({ code: 'delegation_depth_exceeded' });
  });

  test('refuses child messaging even when the recorded policy does not include the built-in denial', async () => {
    await expect(
      resolver(
        childRecord({
          allowedTools: ['station-control_send_message'],
          blockedTools: [],
        }),
      )(request, { tool: 'send_message' }),
    ).rejects.toMatchObject({ code: 'delegated_tool_blocked' });
  });

  test('an inherited tool restriction can still block nested delegation', async () => {
    await expect(
      resolver(childRecord({ toolAllowlistConstraints: [['read_file']] }))(
        request,
        {
          tool: 'delegate_task',
        },
      ),
    ).rejects.toMatchObject({ code: 'delegated_tool_blocked' });
  });

  test.each(TOOLS)(
    'a root caller may %s and gets a depth-1 child',
    async (tool) => {
      const resolved = await resolver({ agentSlug: 'root-agent' })(request, {
        tool,
      });
      expect(resolved).toMatchObject({
        provenance: 'caller-derived',
        context: { mode: 'isolated-child', depth: 1 },
      });
    },
  );
});
