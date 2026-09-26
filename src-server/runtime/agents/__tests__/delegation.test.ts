import { agentId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test } from 'vitest';
import { attestProposalSourceContext } from '../../../services/plugins/plugin-proposal-provenance.js';
import { wrapDelegationAwareTools } from '../../mcp/mcp-manager.js';
import {
  createChildDelegationContext,
  DEFAULT_CHILD_BLOCKED_TOOLS,
  isDelegatedToolAllowed,
} from '../delegation.js';
import { verifyDelegationContextAttestation } from '../delegation-attestation.js';

describe('delegation helpers', () => {
  test('creates child delegation context with inherited root metadata', () => {
    const context = createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'conv-parent',
      spec: {
        name: 'Planner',
        prompt: 'Plan well',
        delegation: {
          maxDepth: 3,
          allowedTools: ['github_*'],
          blockedTools: ['station-control_update_*'],
        },
      },
      current: {
        mode: 'isolated-child',
        depth: 1,
        maxDepth: 3,
        parentAgentSlug: agentId('root'),
        rootAgentSlug: agentId('root'),
        rootConversationId: 'conv-root',
      },
    });

    expect(context).toEqual({
      mode: 'isolated-child',
      depth: 2,
      maxDepth: 3,
      parentAgentSlug: 'planner',
      parentConversationId: 'conv-parent',
      rootAgentSlug: 'root',
      rootConversationId: 'conv-root',
      allowedTools: ['github_*'],
      blockedTools: [
        ...DEFAULT_CHILD_BLOCKED_TOOLS,
        'station-control_update_*',
      ],
      denyApprovals: true,
    });
  });

  test('rejects delegation once the max depth is reached', () => {
    expect(() =>
      createChildDelegationContext({
        agentSlug: 'planner',
        conversationId: 'conv-parent',
        spec: {
          name: 'Planner',
          prompt: 'Plan well',
          delegation: { maxDepth: 2 },
        },
        current: {
          mode: 'isolated-child',
          depth: 2,
          maxDepth: 2,
          parentAgentSlug: agentId('writer'),
          rootAgentSlug: agentId('root'),
        },
      }),
    ).toThrow(/Delegation depth limit reached/);
  });

  test('applies allowlists and blocklists to delegated child tools', () => {
    const toolNameMapping = new Map([
      [
        'github_repo_search',
        {
          original: 'github/repo_search',
          normalized: 'github_repo_search',
          server: 'github',
          tool: 'repo_search',
        },
      ],
    ]);

    const delegation = createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'conv-parent',
      spec: {
        name: 'Planner',
        prompt: 'Plan well',
        delegation: { allowedTools: ['github/*'] },
      },
    });

    expect(
      isDelegatedToolAllowed({
        toolName: 'github_repo_search',
        delegation,
        toolNameMapping,
      }),
    ).toBe(true);
    expect(
      isDelegatedToolAllowed({
        toolName: 'station-control_send_message',
        delegation,
        toolNameMapping,
      }),
    ).toBe(false);
  });

  test.each([
    'connect_ssh_environment',
    'disconnect_ssh_environment',
    'remove_ssh_environment',
    'remove_plugin',
  ])(
    'hard-blocks station-control_%s for an isolated delegated child (station#1136: remove_*/connect_*/disconnect_* glob gap fix)',
    (bareName) => {
      const delegation = createChildDelegationContext({
        agentSlug: 'planner',
        conversationId: 'conv-parent',
      });

      expect(
        isDelegatedToolAllowed({
          toolName: `station-control_${bareName}`,
          delegation,
          toolNameMapping: new Map(),
        }),
      ).toBe(false);
    },
  );

  test('does not block the read-only get_ssh_environment sibling for an isolated delegated child', () => {
    const delegation = createChildDelegationContext({
      agentSlug: 'planner',
      conversationId: 'conv-parent',
    });

    expect(
      isDelegatedToolAllowed({
        toolName: 'station-control_get_ssh_environment',
        delegation,
        toolNameMapping: new Map(),
      }),
    ).toBe(true);
  });

  test('wraps station-control send_message with hidden child metadata', async () => {
    const execute = async (args: Record<string, unknown>) => args;
    const [wrapped] = wrapDelegationAwareTools(
      [
        {
          name: 'station-control_send_message',
          description: 'Send a message',
          parameters: {},
          execute,
        } as any,
      ],
      {
        agentSlug: 'planner',
        toolId: 'station-control',
        spec: {
          name: 'Planner',
          prompt: 'Plan well',
          delegation: { maxDepth: 2 },
        },
      },
    );

    const result = await wrapped.execute?.(
      { agent: 'writer', message: 'Draft this' },
      {
        conversationId: 'conv-parent',
        userId: 'user-1',
      },
    );

    expect(result).toMatchObject({
      agent: 'writer',
      message: 'Draft this',
      _userId: 'user-1',
      _delegation: {
        mode: 'isolated-child',
        depth: 1,
        parentAgentSlug: 'planner',
        parentConversationId: 'conv-parent',
        rootAgentSlug: 'planner',
        rootConversationId: 'conv-parent',
        maxDepth: 2,
      },
    });
  });

  test('#2601: send_message carries an attestation the route verifies; a model-written one never survives', async () => {
    const execute = async (args: Record<string, unknown>) => args;
    const [wrapped] = wrapDelegationAwareTools(
      [
        {
          name: 'station-control_send_message',
          description: 'Send a message',
          parameters: {},
          execute,
        } as any,
      ],
      {
        agentSlug: 'planner',
        toolId: 'station-control',
        spec: {
          name: 'Planner',
          prompt: 'Plan well',
          delegation: { maxDepth: 2 },
        },
      },
    );

    const stamped = (await wrapped.execute?.(
      {
        agent: 'writer',
        message: 'Draft this',
        _delegation: { rootConversationId: 'someone-else' },
        _delegationAttestation: 'model-written',
      },
      { conversationId: 'conv-parent', userId: 'user-1' },
    )) as Record<string, any>;
    expect(stamped._delegation.rootConversationId).toBe('conv-parent');
    expect(
      verifyDelegationContextAttestation(
        stamped._delegation,
        stamped._delegationAttestation,
      ),
    ).toBe(true);

    // Outside a conversation the runtime derives nothing, and vouches for
    // nothing: the model's context arrives unattested, so the route drops it.
    const unstamped = (await wrapped.execute?.(
      {
        agent: 'writer',
        message: 'Draft this',
        _delegation: { rootConversationId: 'someone-else' },
        _delegationAttestation: 'model-written',
      },
      { userId: 'user-1' },
    )) as Record<string, any>;
    expect(unstamped._delegationAttestation).toBeUndefined();
  });

  test('wraps delegate_task as a child while blocking recursive delegation', async () => {
    const execute = async (args: Record<string, unknown>) => args;
    const [wrapped] = wrapDelegationAwareTools(
      [
        {
          name: 'station-control_delegate_task',
          description: 'Delegate a task',
          parameters: {},
          execute,
        } as any,
      ],
      {
        agentSlug: 'planner',
        toolId: 'station-control',
        spec: {
          name: 'Planner',
          prompt: 'Plan well',
          delegation: { maxDepth: 2 },
        },
      },
    );

    const result = await wrapped.execute?.(
      {
        connection: 'codex',
        prompt: 'Implement this',
        parentTaskId: 'spoofed-parent',
      },
      { conversationId: 'conv-parent', userId: 'user-1' },
    );

    expect(result).toMatchObject({
      connection: 'codex',
      prompt: 'Implement this',
      parentTaskId: 'conv-parent',
      _userId: 'user-1',
      _delegation: {
        mode: 'isolated-child',
        depth: 1,
        parentAgentSlug: 'planner',
        blockedTools: expect.arrayContaining(['station-control_delegate_task']),
      },
    });
  });

  test.each([
    'list_delegated_tasks',
    'get_task',
    'get_task_events',
    'continue_task',
    'respond_to_task_request',
    'interrupt_task',
  ])(
    'binds Station user identity to %s without creating another child',
    async (toolName) => {
      const execute = async (args: Record<string, unknown>) => args;
      const [wrapped] = wrapDelegationAwareTools(
        [
          {
            name: `station-control_${toolName}`,
            description: 'Control a delegated task',
            parameters: {},
            execute,
          } as any,
        ],
        {
          agentSlug: 'planner',
          toolId: 'station-control',
          spec: { name: 'Planner', prompt: 'Plan well' },
        },
      );

      await expect(
        wrapped.execute?.(
          { taskId: 'task-1', _userId: 'spoofed-user' },
          { conversationId: 'conv-parent', userId: 'user-1' },
        ),
      ).resolves.toEqual({ taskId: 'task-1', _userId: 'user-1' });
    },
  );

  test('wraps skill updates with hidden agent provenance', async () => {
    const execute = async (args: Record<string, unknown>) => args;
    const [wrapped] = wrapDelegationAwareTools(
      [
        {
          name: 'station-control_update_skill',
          description: 'Update a skill',
          parameters: {},
          execute,
        } as any,
      ],
      {
        agentSlug: 'planner',
        toolId: 'station-control',
        spec: {
          name: 'Planner',
          prompt: 'Plan well',
        },
      },
    );

    const result = await wrapped.execute?.(
      { name: 'research-plan', body: 'Draft the plan' },
      { conversationId: 'conv-parent' },
    );

    expect(result).toMatchObject({
      name: 'research-plan',
      body: 'Draft the plan',
      _sourceContext: {
        kind: 'agent',
        agentSlug: 'planner',
        conversationId: 'conv-parent',
      },
    });
  });

  test.each([
    ['propose_plugin_install', { source: '/tmp/pulse' }, 'install'],
    ['update_plugin', { name: 'pulse' }, 'update'],
    ['remove_plugin', { name: 'pulse' }, 'remove'],
  ] as const)(
    '#2323 S5: %s carries the proposing agent and conversation, overwriting a model-written value',
    async (toolName, toolArgs, kind) => {
      const execute = async (args: Record<string, unknown>) => args;
      const [wrapped] = wrapDelegationAwareTools(
        [
          {
            name: `station-control_${toolName}`,
            description: 'Propose a plugin change',
            parameters: {},
            execute,
          } as any,
        ],
        {
          agentSlug: 'planner',
          toolId: 'station-control',
          spec: { name: 'Planner', prompt: 'Plan well' },
        },
      );

      const result = await wrapped.execute?.(
        {
          ...toolArgs,
          _sourceContext: { agentSlug: 'someone-else', conversationId: 'fake' },
        },
        { conversationId: 'conv-parent' },
      );

      const target = 'source' in toolArgs ? toolArgs.source : toolArgs.name;
      expect(result).toEqual({
        ...toolArgs,
        _sourceContext: {
          agentSlug: 'planner',
          conversationId: 'conv-parent',
          // #2323 S5 review M3: the route verifies this to record the
          // report as Station's own rather than the caller's. Bound to this
          // call's kind and target (delta review).
          attestation: attestProposalSourceContext('planner', 'conv-parent', {
            kind,
            target,
          }),
        },
      });
    },
  );
});
