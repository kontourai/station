import type { Skill } from '@kontourai/station-contracts/catalog';
import { resolveSkillCommandName } from '@kontourai/station-contracts/skill-command';
import { agentQueries } from '@kontourai/station-sdk';
import { runtimeCatalogSourceLabel } from '../utils/execution';
import { agentCommandSkills } from '../utils/skill-commands';
import { registerCommand } from './registry';

// MCP command
registerCommand(
  'mcp',
  async ({
    chatState,
    queryClient,
    addEphemeralMessage,
    sessionId,
    agent,
    bindingStatus,
  }) => {
    try {
      const support = bindingStatus?.capabilityState;

      if (!support?.mcp) {
        addEphemeralMessage(sessionId, {
          role: 'system',
          // Same guard, two facts — see the note in `tools.ts`.
          content: support
            ? 'This chat’s agent doesn’t support MCP servers, so there are none to show.'
            : 'Station can’t tell yet what this chat’s agent can do. Try again in a moment.',
        });
        return;
      }

      const tools = await queryClient.fetchQuery(
        agentQueries.tools(agent?.slug || chatState.agentSlug),
      );

      const mcpServers = (
        [
          ...new Set(
            tools
              .map((t: any): string | null => {
                if (typeof t !== 'string' && typeof t.server === 'string') {
                  return t.server;
                }
                const name =
                  typeof t === 'string'
                    ? t
                    : t.originalName || t.name || t.id || '';
                return name.includes('_') ? name.split('_')[0] : null;
              })
              .filter((s: any): s is string => s !== null),
          ),
        ] as string[]
      ).sort();

      const content =
        mcpServers.length > 0
          ? `**MCP Servers (${mcpServers.length}):**\n\n${mcpServers.map((s: string) => `- ${s}`).join('\n')}`
          : 'No MCP servers loaded for this agent.';

      addEphemeralMessage(sessionId, { role: 'system', content });
    } catch (error) {
      addEphemeralMessage(sessionId, {
        role: 'system',
        content: `Error: ${error}`,
      });
    }
  },
);

// The command that lists the commands. `/prompts` stays as an alias in the
// catalog's own row; this is the handler both words reach.
registerCommand(
  'commands',
  async ({ agent, addEphemeralMessage, sessionId, queryClient }) => {
    const sections: string[] = [];

    // Agent custom commands
    if (agent?.commands && Object.keys(agent.commands).length > 0) {
      const commandList = Object.values(agent.commands)
        .map((cmd: any) => {
          const params =
            cmd.params
              ?.map((p: any) => `${p.name}${p.required === false ? '?' : ''}`)
              .join(' ') || '';
          return `• **/${cmd.name}** ${params ? `\`${params}\`` : ''}\n  ${cmd.description || 'No description'}`;
        })
        .join('\n\n');
      sections.push(
        `**Custom Commands (${Object.keys(agent.commands).length})**\n\n${commandList}`,
      );
    }

    // The SAME derivation the composer's catalog uses, so this listing cannot
    // advertise a command the composer does not offer.
    const commandSkills = agentCommandSkills(
      queryClient.getQueryData<Skill[]>(['skills', 'local']),
      agent,
    );
    if (commandSkills.length > 0) {
      const list = commandSkills
        .map(
          (skill) =>
            `• **/${resolveSkillCommandName(skill)}** — ${skill.description || skill.name}`,
        )
        .join('\n');
      sections.push(`**Command Skills (${commandSkills.length})**\n\n${list}`);
    }

    addEphemeralMessage(sessionId, {
      role: 'system',
      content:
        sections.length > 0
          ? sections.join('\n\n---\n\n')
          : 'No commands defined.',
    });
  },
);

// Model command - override default by setting input and opening model selector
registerCommand(
  'model',
  async ({
    updateChat,
    sessionId,
    autocomplete,
    addEphemeralMessage,
    bindingStatus,
  }) => {
    const support = bindingStatus?.capabilityState;

    if (!support?.model_selection) {
      addEphemeralMessage(sessionId, {
        role: 'system',
        content: `Model selection is unavailable for this binding. Readiness: ${bindingStatus?.bindingReadiness ?? 'needs_configuration'}. Catalog: ${runtimeCatalogSourceLabel(bindingStatus?.catalogSource ?? 'none')}${bindingStatus?.catalogReason ? ` — ${bindingStatus.catalogReason}` : ''}`,
      });
      autocomplete.closeAll();
      updateChat(sessionId, { input: '' });
      return;
    }

    autocomplete.closeCommand();
    updateChat(sessionId, { input: '/model ' });
    autocomplete.openModel();
  },
);

// Stats command
registerCommand(
  'stats',
  async ({ sessionId, chatState, queryClient, addEphemeralMessage }) => {
    try {
      if (!chatState.conversationId) {
        addEphemeralMessage(sessionId, {
          role: 'system',
          content: 'No conversation ID available.',
        });
        return;
      }

      const stats = await queryClient.fetchQuery(
        agentQueries.stats(chatState.agentSlug, chatState.conversationId),
      );

      // Cache honesty (station#4196): this section renders the SAME wire
      // payload ConversationStatsModal renders, so it goes through the same
      // shared derivations — a summed or "(uncached)" figure appears only
      // when the provider's declared inclusivity backs it, cache rows render
      // only when reported, and an absent figure renders as a dash, never an
      // invented zero (station#3201). Dynamically imported to keep the
      // shared usage modules out of the eager entry bundle.
      const [
        {
          cacheInclusivePromptTokens,
          cacheInclusiveTotalTokens,
          providerPromptCacheInclusivity,
        },
        { formatMeasuredTokens },
      ] = await Promise.all([
        import('@kontourai/station-shared/usage-fold'),
        import('@kontourai/station-shared/usage-measurement'),
      ]);
      const usageProvider =
        stats.measurement?.source === 'engine-events'
          ? stats.measurement.provider
          : undefined;
      const consumptionInLabel =
        providerPromptCacheInclusivity(usageProvider) === 'disjoint'
          ? 'In (uncached)'
          : 'In';
      const promptSideTotal = cacheInclusivePromptTokens(usageProvider, stats);
      const cacheInclusiveTotal = cacheInclusiveTotalTokens(
        usageProvider,
        stats,
      );
      const consumptionRows = [
        `${consumptionInLabel}: <strong>${formatMeasuredTokens(stats.inputTokens)}</strong>`,
        ...(stats.cacheReadTokens !== undefined
          ? [
              `Cache read: <strong>${formatMeasuredTokens(stats.cacheReadTokens)}</strong>`,
            ]
          : []),
        ...(stats.cacheWriteTokens !== undefined
          ? [
              `Cache write: <strong>${formatMeasuredTokens(stats.cacheWriteTokens)}</strong>`,
            ]
          : []),
        ...(promptSideTotal !== undefined
          ? [
              `Prompt total: <strong>${promptSideTotal.toLocaleString()}</strong>`,
            ]
          : []),
        `Out: <strong>${formatMeasuredTokens(stats.outputTokens)}</strong>`,
        `Total: <strong>${formatMeasuredTokens(cacheInclusiveTotal ?? stats.totalTokens)}</strong>`,
      ].join('<br/>\n              ');

      const html = `
      <div style="font-family: system-ui, -apple-system, sans-serif; font-size: 14px;">
        <strong style="font-size: 16px;">Conversation Statistics</strong><br/><br/>
        
        ${
          stats.contextWindowPercentage !== undefined
            ? `
        <details open style="margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; padding: 8px; background: var(--bg-secondary); border-radius: 4px; user-select: none;">
            Context Window Usage
          </summary>
          <div style="padding: 12px 8px;">
            <span style="color: var(--text-muted);">${stats.contextTokens?.toLocaleString() || 0} tokens (all messages + system prompt + tools)</span><br/>
            <div style="background: var(--bg-tertiary); height: 8px; border-radius: 4px; margin-top: 8px; overflow: hidden;">
              <div style="background: #10b981; height: 100%; width: ${stats.contextWindowPercentage}%;"></div>
            </div>
            <span style="font-weight: 600; margin-top: 4px; display: inline-block;">${stats.contextWindowPercentage.toFixed(1)}%</span>
          </div>
        </details>
        `
            : ''
        }
        
        <details open style="margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; padding: 8px; background: var(--bg-secondary); border-radius: 4px; user-select: none;">
            Context Breakdown
          </summary>
          <div style="padding: 12px 8px;">
            <table style="width: 100%;">
              <tr><td>System Prompt:</td><td style="text-align: right;">${stats.systemPromptTokens?.toLocaleString() || 0}</td></tr>
              <tr><td>MCP Tools:</td><td style="text-align: right;">${stats.mcpServerTokens?.toLocaleString() || 0}</td></tr>
              <tr><td>User Messages:</td><td style="text-align: right;">${stats.userMessageTokens?.toLocaleString() || 0}</td></tr>
              <tr><td>Assistant Messages:</td><td style="text-align: right;">${stats.assistantMessageTokens?.toLocaleString() || 0}</td></tr>
            </table>
          </div>
        </details>
        
        <details open style="margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; padding: 8px; background: var(--bg-secondary); border-radius: 4px; user-select: none;">
            Total LLM Consumption
          </summary>
          <div style="padding: 12px 8px;">
            <span style="color: var(--text-muted); font-size: 12px;">Tokens sent/received across all API calls</span><br/>
            <div style="margin-top: 8px;">
              ${consumptionRows}
            </div>
          </div>
        </details>
        
        <details style="margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; padding: 8px; background: var(--bg-secondary); border-radius: 4px; user-select: none;">
            Activity & Cost
          </summary>
          <div style="padding: 12px 8px;">
            <div style="margin-bottom: 12px;">
              <strong>Activity</strong><br/>
              Turns: <strong>${stats.turns || 0}</strong><br/>
              Tool Calls: <strong>${stats.toolCalls || 0}</strong>
            </div>
            <div>
              <strong>Cost</strong><br/>
              Total: <strong>$${(stats.estimatedCost || 0).toFixed(4)}</strong><br/>
              Per Turn: <strong>$${((stats.estimatedCost || 0) / (stats.turns || 1)).toFixed(4)}</strong>
            </div>
          </div>
        </details>
        
        ${
          stats.modelStats && Object.keys(stats.modelStats).length > 0
            ? `
          <details style="margin-bottom: 12px;">
            <summary style="cursor: pointer; font-weight: 600; padding: 8px; background: var(--bg-secondary); border-radius: 4px; user-select: none;">
              Per-Model Breakdown
            </summary>
            <div style="padding: 12px 8px;">
              ${Object.entries(stats.modelStats)
                .map(
                  ([modelId, modelData]: [string, any]) => `
                <div style="margin-bottom: 12px; padding: 8px; background: var(--bg-tertiary); border-radius: 4px;">
                  <div style="font-family: monospace; font-size: 12px; margin-bottom: 8px;">${modelId}</div>
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 13px;">
                    <div>
                      <strong>Consumed</strong><br/>
                      In: ${modelData.inputTokens?.toLocaleString() || 0}<br/>
                      Out: ${modelData.outputTokens?.toLocaleString() || 0}<br/>
                      Total: ${modelData.totalTokens?.toLocaleString() || 0}
                    </div>
                    <div>
                      <strong>Stats</strong><br/>
                      Turns: ${modelData.turns || 0}<br/>
                      Tool Calls: ${modelData.toolCalls || 0}<br/>
                      Cost: $${(modelData.estimatedCost || 0).toFixed(4)}
                    </div>
                  </div>
                </div>
              `,
                )
                .join('')}
            </div>
          </details>
        `
            : ''
        }
      </div>
    `;

      addEphemeralMessage(sessionId, {
        role: 'system',
        content: html,
        contentType: 'html',
      });
    } catch (error) {
      addEphemeralMessage(sessionId, {
        role: 'system',
        content: `Error fetching stats: ${error}`,
      });
    }
  },
);

// Clear/New command
registerCommand(
  'clear',
  async ({ updateChat, sessionId, addEphemeralMessage }) => {
    updateChat(sessionId, { messages: [] });
    addEphemeralMessage(sessionId, {
      role: 'system',
      content: 'Conversation cleared',
    });
  },
);

registerCommand(
  'new',
  async ({ updateChat, sessionId, addEphemeralMessage }) => {
    updateChat(sessionId, { messages: [] });
    addEphemeralMessage(sessionId, {
      role: 'system',
      content: 'Conversation cleared',
    });
  },
);

// Resume/Chat command — opens the "Open chat" modal
registerCommand('resume', async ({ autocomplete }) => {
  autocomplete.closeAll();
  autocomplete.openNewChat();
});

registerCommand('chat', async ({ autocomplete }) => {
  autocomplete.closeAll();
  autocomplete.openNewChat();
});

// Help command - list all available commands
registerCommand('help', async ({ addEphemeralMessage, sessionId }) => {
  const { getAllCommands } = await import('./registry');
  const names = getAllCommands();
  const list = names
    .sort()
    .map((name) => `• **/${name}**`)
    .join('\n');
  addEphemeralMessage(sessionId, {
    role: 'system',
    content: `**Available Commands:**\n\n${list}\n\n_Use the slash menu for descriptions and runtime-specific commands._`,
  });
});
