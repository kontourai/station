import type { IntegrationViewModel } from '@kontourai/station-sdk';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';
import { resourceRow } from '../../components/resource-hub/resource-row';
import { toolServerProbeFact, toolServerStatus } from './tool-server-status';

/**
 * Tool server rows: the status as a badge, then what the last probe saw and
 * how many Agents and Projects select the server. `usedByCount` answers
 * `null` while that is unknown, so a row never claims nobody uses it.
 */
export function filterIntegrationItems(
  integrations: IntegrationViewModel[],
  search: string,
  usedByCount: (id: string) => number | null = () => null,
) {
  return integrations
    .filter((integration) => {
      if (!search) return true;
      const query = search.toLowerCase();
      return (
        (integration.displayName || integration.id)
          .toLowerCase()
          .includes(query) ||
        integration.description?.toLowerCase().includes(query)
      );
    })
    .map((integration) => {
      const count = usedByCount(integration.id);
      return resourceRow({
        id: integration.id,
        name: integration.displayName || integration.id,
        status: toolServerStatus(integration),
        facts: [
          toolServerProbeFact(integration),
          count === null
            ? null
            : count === 0
              ? 'Not used yet'
              : `Used by ${count}`,
        ],
        icon: (
          <span className="integration-list-icon">
            <IntegrationGlyph
              id={integration.id}
              displayName={integration.displayName}
              icon={integration.icon}
              iconUrl={integration.iconUrl}
            />
          </span>
        ),
      });
    });
}

export function formToMcpJson(form: IntegrationViewModel): string {
  const server: Record<string, any> = {};
  if (form.transport === 'stdio' || !form.transport) {
    if (form.command) server.command = form.command;
    if (form.args?.length) server.args = form.args;
  } else {
    if (form.endpoint) server.url = form.endpoint;
    server.transport = form.transport;
  }
  if (form.env && Object.keys(form.env).length > 0) {
    server.env = form.env;
  }

  const name = form.id || 'my-server';
  return JSON.stringify({ mcpServers: { [name]: server } }, null, 2);
}

export function parseMcpJson(
  json: string,
  editForm: IntegrationViewModel | null,
): {
  form: IntegrationViewModel | null;
  error: string | null;
} {
  try {
    const parsed = JSON.parse(json);
    let id: string;
    let server: any;

    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      const keys = Object.keys(parsed.mcpServers);
      if (keys.length === 0) {
        return { form: null, error: 'No servers found in mcpServers' };
      }
      id = keys[0];
      server = parsed.mcpServers[id];
    } else if (parsed.command || parsed.url || parsed.endpoint) {
      id = editForm?.id || '';
      server = parsed;
    } else {
      return {
        form: null,
        error:
          'Unrecognized format. Expected { mcpServers: { ... } } or { command, args }',
      };
    }

    const transport = server.transport || (server.url ? 'sse' : 'stdio');
    return {
      form: {
        id,
        kind: 'mcp',
        transport,
        command: server.command || '',
        args: server.args || [],
        endpoint: server.url || server.endpoint || '',
        displayName: editForm?.displayName || id,
        description: editForm?.description || '',
        ...(Object.hasOwn(server, 'env') ? { env: server.env } : {}),
      },
      error: null,
    };
  } catch (error: any) {
    return {
      form: null,
      error: error.message,
    };
  }
}
export function formForSelectedIntegration(
  selectedId: string | null,
  editForm: IntegrationViewModel | null,
): IntegrationViewModel | null {
  return selectedId === 'new' || editForm?.id === selectedId ? editForm : null;
}
