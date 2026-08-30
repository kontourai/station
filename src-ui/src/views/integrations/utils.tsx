import type { IntegrationViewModel } from '@kontourai/station-sdk';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';

export function filterIntegrationItems(
  integrations: IntegrationViewModel[],
  search: string,
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
    .map((integration) => ({
      id: integration.id,
      name: integration.displayName || integration.id,
      subtitle: [
        integration.enabled === false
          ? 'Disabled'
          : integration.probe
            ? integration.probe.ok
              ? `Connected · ${integration.probe.toolCount} ${integration.probe.toolCount === 1 ? 'tool' : 'tools'}`
              : `Needs attention · ${integration.probe.error}`
            : 'Not checked yet',
        integration.description,
      ]
        .filter(Boolean)
        .join(' · '),
      // The glyph replaces the bare status dot as the list icon, but
      // connectivity stays visible: the dot moves alongside the glyph as a
      // small corner badge rather than being dropped.
      icon: (
        <span className="integration-list-icon">
          <IntegrationGlyph
            id={integration.id}
            displayName={integration.displayName}
            icon={integration.icon}
            iconUrl={integration.iconUrl}
          />
          <span
            className={`status-dot status-dot--${integration.enabled === false ? 'disabled' : integration.probe?.ok ? 'connected' : 'disconnected'} integration-list-icon__status`}
            title={
              integration.enabled === false
                ? 'Disabled'
                : integration.probe?.ok
                  ? 'Connected'
                  : integration.probe
                    ? 'Needs attention'
                    : 'Not checked yet'
            }
          />
        </span>
      ),
    }));
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
