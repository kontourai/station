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
  test.each(TOOLS)('refuses %s from a delegated child', async (tool) => {
    await expect(
      resolver(childRecord())(request, { tool }),
    ).rejects.toMatchObject({ code: 'delegated_tool_blocked' });
  });

  test.each(TOOLS)(
    'refuses %s before the depth limit, even one level below it',
    async (tool) => {
      // depth 1 of maxDepth 3: the depth check would admit it.
      await expect(
        resolver(childRecord({ maxDepth: 3 }))(request, { tool }),
      ).rejects.toMatchObject({ code: 'delegated_tool_blocked' });
    },
  );

  test.each(TOOLS)(
    'an Agent allowedTools that names %s cannot re-allow the built-in denial',
    async (tool) => {
      await expect(
        resolver(
          childRecord({ allowedTools: [`station-control_${tool}`] }),
        )(request, { tool }),
      ).rejects.toMatchObject({ code: 'delegated_tool_blocked' });
    },
  );

  test.each(TOOLS)(
    'a context recorded without blockedTools still refuses %s',
    async (tool) => {
      const record = childRecord();
      delete (record.delegation as Record<string, unknown>).blockedTools;
      await expect(resolver(record)(request, { tool })).rejects.toMatchObject({
        code: 'delegated_tool_blocked',
      });
    },
  );

  test.each(TOOLS)('a root caller may %s and gets a depth-1 child', async (tool) => {
    const resolved = await resolver({ agentSlug: 'root-agent' })(request, {
      tool,
    });
    expect(resolved).toMatchObject({
      provenance: 'caller-derived',
      context: { mode: 'isolated-child', depth: 1 },
    });
  });
});
