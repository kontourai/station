import { agentQueries } from '@kontourai/station-sdk';
import { registerCommand } from './registry';

registerCommand(
  'tools',
  async ({
    agent,
    chatState,
    queryClient,
    addEphemeralMessage,
    sessionId,
    autocomplete,
    updateChat,
    bindingStatus,
  }) => {
    try {
      if (!agent) {
        addEphemeralMessage(sessionId, {
          role: 'system',
          content: 'No agent found.',
        });
        autocomplete.closeAll();
        updateChat(sessionId, { input: '' });
        return;
      }

      if (!bindingStatus?.capabilityState.tool_execution) {
        addEphemeralMessage(sessionId, {
          role: 'system',
          // Two different facts wear the same guard: `bindingStatus` is
          // undefined while Station has not yet read what this chat's agent
          // can do, and `tool_execution` is false once it has and the answer
          // is no. Saying "doesn't run tools" for both asserts a cause
          // nothing derived — the defect station#3969 exists to remove, so it
          // is not one to reproduce here.
          content: bindingStatus
            ? 'This chat’s agent doesn’t run tools, so there are none to list.'
            : 'Station can’t tell yet what this chat’s agent can do. Try again in a moment.',
        });
        autocomplete.closeAll();
        updateChat(sessionId, { input: '' });
        return;
      }

      const tools = await queryClient.fetchQuery(
        agentQueries.tools(agent.slug),
      );

      if (!tools || tools.length === 0) {
        addEphemeralMessage(sessionId, {
          role: 'system',
          content: 'No tools available for this agent.',
        });
        autocomplete.closeAll();
        updateChat(sessionId, { input: '' });
        return;
      }

      const autoApproveList = agent?.toolsConfig?.autoApprove || [];
      const sessionAutoApprove = chatState.sessionAutoApprove || [];

      // Build HTML table
      const byServer = tools.reduce((acc: any, tool: any) => {
        const server = tool.server || 'unknown';
        if (!acc[server]) acc[server] = [];
        acc[server].push(tool);
        return acc;
      }, {});

      let html = `<div><strong>Available Tools (${tools.length}):</strong><br/><br/>`;

      const escapeHtml = (str: string) =>
        str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

      Object.keys(byServer)
        .sort()
        .forEach((server) => {
          html += `<details open style="margin-bottom: 16px;">`;
          html += `<summary style="cursor: pointer; font-weight: 600; padding: 8px; background: var(--bg-secondary); border-radius: 4px; user-select: none;">`;
          html += `${server} (${byServer[server].length} tools)`;
          html += `</summary>`;
          html +=
            '<table style="width: 100%; border-collapse: separate; border-spacing: 0 4px; margin: 8px 0;">';
          html +=
            '<thead><tr style="text-align: left; border-bottom: 1px solid var(--border-primary);">';
          html += '<th style="padding: 8px; width: 25%;">Tool</th>';
          html += '<th style="padding: 8px; width: 45%;">Description</th>';
          html += '<th style="padding: 8px; width: 30%;">Parameters</th>';
          html += '</tr></thead><tbody>';

          byServer[server].forEach((tool: any) => {
            const toolOriginalName = tool.originalName || tool.name;

            const isAutoApproved = autoApproveList.some((pattern: string) => {
              if (pattern.includes('*')) {
                const escaped = pattern
                  .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                  .replace(/\*/g, '.*');
                const regex = new RegExp(`^${escaped}$`);
                return regex.test(toolOriginalName);
              }
              return pattern === toolOriginalName;
            });

            const isSessionTrusted =
              sessionAutoApprove.includes(toolOriginalName);
            const trustBadge = isAutoApproved
              ? ' (auto-approved)'
              : isSessionTrusted
                ? ' ⏱'
                : '';

            const toolName = escapeHtml(
              `${tool.toolName || tool.name}${trustBadge}`,
            );
            const rawDescription = tool.description || '-';
            const truncated =
              rawDescription.length > 120
                ? `${rawDescription.substring(0, 117)}...`
                : rawDescription;
            const description = escapeHtml(truncated);

            const schema = tool.parameters || {};
            const required = schema.required || [];
            const properties = schema.properties || {};
            const params = escapeHtml(
              Object.keys(properties)
                .map((key) => {
                  const isRequired = required.includes(key);
                  return `${key}${isRequired ? '*' : ''}`;
                })
                .join(', ') || '-',
            );

            html += `<tr style="border-bottom: 1px solid var(--border-secondary);">`;
            html += `<td style="padding: 8px; vertical-align: top; border-bottom: 1px solid var(--border-secondary);">${toolName}</td>`;
            html += `<td style="padding: 8px; vertical-align: top; border-bottom: 1px solid var(--border-secondary);">${description}</td>`;
            html += `<td style="padding: 8px; vertical-align: top; border-bottom: 1px solid var(--border-secondary);">${params}</td>`;
            html += '</tr>';
          });

          html += '</tbody></table>';
          html += '</details>';
        });

      html +=
        '<br/><small>Auto-approved | Trusted this session | * = Required parameter</small></div>';

      addEphemeralMessage(sessionId, {
        role: 'system',
        content: html,
        contentType: 'html',
      });
    } catch (error) {
      addEphemeralMessage(sessionId, {
        role: 'system',
        content: `Error: ${error}`,
      });
    }
  },
);
