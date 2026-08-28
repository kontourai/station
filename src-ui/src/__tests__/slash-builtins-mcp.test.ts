import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', () => ({
  agentQueries: {
    tools: (slug: string) => ({ queryKey: ['agent-tools', slug] }),
    stats: (slug: string, conversationId: string) => ({
      queryKey: ['stats', slug, conversationId],
    }),
  },
}));

describe('default-agent slash commands', () => {
  beforeEach(async () => {
    vi.resetModules();
    await import('../slashCommands/builtins');
    await import('../slashCommands/tools');
  });

  function baseContext(overrides: Record<string, unknown> = {}) {
    return {
      sessionId: 's1',
      chatState: { agentSlug: 'station' },
      bindingStatus: {
        catalogSource: 'live',
        catalogReason: null,
        bindingReadiness: 'ready',
        capabilityState: {
          system_prompt: true,
          mcp: true,
          tool_execution: true,
          model_catalog: true,
          model_selection: true,
        },
        visibleModels: [
          { id: 'model-a', name: 'Model A', originalId: 'model-a' },
        ],
      },
      agent: {
        slug: 'station',
        name: 'Station',
        toolsConfig: { mcpServers: ['station-control'], autoApprove: [] },
      },
      args: [],
      apiBase: 'http://localhost:3141',
      updateChat: vi.fn(),
      addEphemeralMessage: vi.fn(),
      queryClient: {
        fetchQuery: vi.fn(),
        getQueryData: vi.fn(() => []),
      } as any,
      sendMessage: vi.fn(),
      autocomplete: {
        openModel: vi.fn(),
        openNewChat: vi.fn(),
        closeCommand: vi.fn(),
        closeAll: vi.fn(),
      },
      ...overrides,
    } as any;
  }

  test('lists MCP servers from the agent tools query', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('mcp');
    expect(handler).toBeDefined();

    const fetchQuery = vi.fn(async () => [
      { originalName: 'station-control_list_agents' },
      { originalName: 'github_search' },
      { originalName: 'station-control_get_project' },
    ]);
    const context = baseContext({
      addEphemeralMessage: vi.fn(),
      queryClient: { fetchQuery } as any,
    });

    await handler!(context);

    expect(fetchQuery).toHaveBeenCalledWith({
      queryKey: ['agent-tools', 'station'],
    });
    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        role: 'system',
        content: expect.stringContaining('station-control'),
      }),
    );
    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: expect.stringContaining('github'),
      }),
    );
  });

  test('/tools renders an HTML summary grouped by MCP server', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('tools');
    const context = baseContext({
      agent: {
        slug: 'station',
        name: 'Station',
        toolsConfig: {
          mcpServers: ['station-control'],
          autoApprove: ['station-control_*'],
        },
      },
      chatState: {
        agentSlug: 'station',
        sessionAutoApprove: ['github_search'],
      },
      queryClient: {
        fetchQuery: vi.fn(async () => [
          {
            server: 'station-control',
            toolName: 'list_agents',
            originalName: 'station-control_list_agents',
            description: 'List all configured agents',
            parameters: { properties: {} },
          },
          {
            server: 'github',
            toolName: 'search',
            originalName: 'github_search',
            description: 'Search GitHub',
            parameters: { properties: { q: { type: 'string' } } },
          },
        ]),
      } as any,
    });

    await handler!(context);

    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        contentType: 'html',
        content: expect.stringContaining('station-control (1 tools)'),
      }),
    );
    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: expect.stringContaining('github (1 tools)'),
      }),
    );
  });

  test('/tools reports unsupported bindings for provider-managed chats', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('tools');
    const context = baseContext({
      chatState: {
        agentSlug: 'station',
        executionMode: 'station',
      },
      bindingStatus: {
        catalogSource: 'none',
        catalogReason: null,
        bindingReadiness: 'ready',
        capabilityState: {
          system_prompt: true,
          mcp: false,
          tool_execution: false,
          model_catalog: false,
          model_selection: false,
        },
        visibleModels: [],
      },
      queryClient: {
        fetchQuery: vi.fn(),
      } as any,
    });

    await handler!(context);

    // archive#3969: `bindingStatus` is PRESENT here and `tool_execution` is
    // false, so this is the known-false branch — Station has read what this
    // agent can do and the answer is no. The unknown branch (no
    // `bindingStatus` at all) says something different on purpose, and is
    // covered below.
    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: expect.stringContaining('doesn’t run tools'),
      }),
    );
  });

  test('/tools does not claim an agent lacks tools when Station has not read its capabilities', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('tools');
    const context = baseContext({
      chatState: { agentSlug: 'station', executionMode: 'station' },
      // Explicitly undefined, not merely omitted: `baseContext` supplies a
      // ready `bindingStatus` by default, so omitting the key leaves the
      // capability KNOWN and this test would drive the wrong branch (it did,
      // first time — it reached "No tools available for this agent").
      bindingStatus: undefined,
      queryClient: { fetchQuery: vi.fn() } as any,
    });

    await handler!(context);

    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: expect.stringContaining('can’t tell yet'),
      }),
    );
    expect(context.addEphemeralMessage).not.toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: expect.stringContaining('doesn’t run tools'),
      }),
    );
  });

  test('/model reports unavailable model selection when no model catalog exists', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('model');
    const context = baseContext({
      queryClient: {
        getQueryData: vi.fn(() => []),
      } as any,
      bindingStatus: {
        catalogSource: 'none',
        catalogReason:
          'No runtime model catalog is available for this connection.',
        bindingReadiness: 'needs_configuration',
        capabilityState: {
          system_prompt: true,
          mcp: true,
          tool_execution: true,
          model_catalog: false,
          model_selection: false,
        },
        visibleModels: [],
      },
      autocomplete: {
        openModel: vi.fn(),
        openNewChat: vi.fn(),
        closeCommand: vi.fn(),
        closeAll: vi.fn(),
      },
    });

    await handler!(context);

    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: expect.stringContaining('Model selection is unavailable'),
      }),
    );
    expect(context.autocomplete.openModel).not.toHaveBeenCalled();
  });

  test('/model stays unavailable for connected runtime chats when only a global catalog exists', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('model');
    const context = baseContext({
      agent: {
        slug: 'claude',
        name: 'Claude Runtime',
        toolsConfig: {},
        execution: { agentConnectionId: 'claude-runtime' },
      },
      chatState: {
        agentSlug: 'claude',
        executionMode: 'external',
        agentConnectionId: 'claude-runtime',
      },
      bindingStatus: {
        catalogSource: 'none',
        catalogReason:
          'No runtime model catalog is available for this connection.',
        bindingReadiness: 'needs_configuration',
        capabilityState: {
          system_prompt: true,
          mcp: false,
          tool_execution: false,
          model_catalog: false,
          model_selection: false,
        },
        visibleModels: [],
      },
      autocomplete: {
        openModel: vi.fn(),
        openNewChat: vi.fn(),
        closeCommand: vi.fn(),
        closeAll: vi.fn(),
      },
    });

    await handler!(context);

    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: expect.stringContaining('Model selection is unavailable'),
      }),
    );
    expect(context.autocomplete.openModel).not.toHaveBeenCalled();
  });

  test('/model opens for connected runtime chats using the built-in catalog source and label', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('model');
    const context = baseContext({
      agent: {
        slug: 'claude',
        name: 'Claude Runtime',
        toolsConfig: {},
        execution: { agentConnectionId: 'claude-runtime' },
      },
      chatState: {
        agentSlug: 'claude',
        executionMode: 'external',
        agentConnectionId: 'claude-runtime',
      },
      bindingStatus: {
        catalogSource: 'built-in',
        catalogReason: 'Using built-in models.',
        bindingReadiness: 'degraded',
        capabilityState: {
          system_prompt: true,
          mcp: false,
          tool_execution: false,
          model_catalog: true,
          model_selection: true,
        },
        visibleModels: [
          {
            id: 'claude-sonnet',
            name: 'Claude Sonnet',
            originalId: 'claude-sonnet',
          },
        ],
      },
      autocomplete: {
        openModel: vi.fn(),
        openNewChat: vi.fn(),
        closeCommand: vi.fn(),
        closeAll: vi.fn(),
      },
    });

    await handler!(context);

    const { runtimeCatalogSourceLabel } = await import('../utils/execution');
    expect(runtimeCatalogSourceLabel('built-in')).toBe('Built-in');
    expect(context.autocomplete.closeCommand).toHaveBeenCalled();
    expect(context.autocomplete.openModel).toHaveBeenCalled();
  });

  test('/commands lists the command skills available in this chat', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('commands');
    const context = baseContext({
      queryClient: {
        fetchQuery: vi.fn(),
        getQueryData: vi.fn().mockImplementation((key) =>
          JSON.stringify(key) === JSON.stringify(['skills', 'local'])
            ? [
                {
                  name: 'create-agent',
                  description: 'Make one',
                  command: { enabled: true, global: true },
                },
                // Not a command: it must not be listed as one.
                { name: 'plain-skill', description: 'Just a skill' },
              ]
            : [],
        ),
      } as any,
    });

    await handler!(context);

    const [, message] = (context.addEphemeralMessage as any).mock.calls[0];
    expect(message.content).toContain('/create-agent');
    expect(message.content).not.toContain('plain-skill');
  });

  test('/clear and /new both clear the conversation with ephemeral confirmation', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    for (const cmd of ['clear', 'new']) {
      const handler = getCommand(cmd);
      const context = baseContext();

      await handler!(context);

      expect(context.updateChat).toHaveBeenCalledWith('s1', { messages: [] });
      expect(context.addEphemeralMessage).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ content: 'Conversation cleared' }),
      );
    }
  });

  test('/resume and /chat open the conversation picker', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    for (const cmd of ['resume', 'chat']) {
      const handler = getCommand(cmd);
      const context = baseContext();

      await handler!(context);

      expect(context.autocomplete.openNewChat).toHaveBeenCalled();
    }
  });

  test('/stats without a conversation id reports the problem ephemerally', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('stats');
    const context = baseContext({
      chatState: { agentSlug: 'station' },
    });

    await handler!(context);

    expect(context.addEphemeralMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ content: 'No conversation ID available.' }),
    );
  });

  test('/stats omits context-window usage when the percentage is unresolved', async () => {
    const { getCommand } = await import('../slashCommands/registry');
    const handler = getCommand('stats');
    const context = baseContext({
      chatState: { agentSlug: 'station', conversationId: 'c1' },
      queryClient: {
        fetchQuery: vi.fn().mockResolvedValue({
          contextTokens: 50_000,
          contextWindowPercentage: undefined,
        }),
      },
    });

    await handler!(context);

    const message = (context.addEphemeralMessage as ReturnType<typeof vi.fn>)
      .mock.calls[0][1];
    expect(message.content).toContain('Conversation Statistics');
    expect(message.content).not.toContain('Context Window Usage');
    expect(message.content).not.toContain('0.0%');
  });
});
