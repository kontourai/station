import { useState } from 'react';
import type { Tool } from '../../types';
import { AgentToolAccount } from './AgentToolAccount';

export function AgentToolDetails({
  integration,
  projectSlug,
}: {
  integration: Tool;
  projectSlug?: string;
}) {
  const [open, setOpen] = useState(false);
  const origin = integration.origin;
  const label =
    origin?.kind === 'station'
      ? 'Built into Station'
      : origin?.kind === 'manual'
        ? 'Manually connected'
        : origin?.registryName ||
          (origin?.kind === 'plugin' ? 'Plugin' : 'Origin unavailable');
  return (
    <details
      className="agent-tool-picker__details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Details · {label}</summary>
      {integration.description && <p>{integration.description}</p>}
      <dl>
        <dt>From</dt>
        <dd>{label}</dd>
        {origin?.pluginName && (
          <>
            <dt>Plugin</dt>
            <dd>{origin.pluginName}</dd>
          </>
        )}
        {origin?.version && (
          <>
            <dt>Version</dt>
            <dd>{origin.version}</dd>
          </>
        )}
        {origin?.location && (
          <>
            <dt>Location</dt>
            <dd>{origin.location}</dd>
          </>
        )}
        <dt>Server</dt>
        <dd>
          <code>{integration.id}</code>
        </dd>
      </dl>
      {open &&
        (integration.transport === 'sse' ||
          integration.transport === 'streamable-http') && (
          <AgentToolAccount id={integration.id} projectSlug={projectSlug} />
        )}
    </details>
  );
}
