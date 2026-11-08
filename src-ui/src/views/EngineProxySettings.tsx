import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useModelConnectionsQuery } from '@kontourai/station-sdk';
import { Button } from '../components/Button';

export function EngineProxySettings({
  connection,
  onChange,
  onManageModels,
  managedLocked = false,
  ambientOrigin,
}: {
  connection: AgentConnectionView;
  /**
   * The endpoint the engine inherits from Station's environment when no
   * proxy is chosen: "Your account" alone would not be the whole story.
   */
  ambientOrigin?: string;
  /** #4520: the managed policy owns the launch environment; not applied. */
  managedLocked?: boolean;
  onChange: (config: Record<string, unknown>) => void;
  onManageModels: () => void;
}) {
  const { data: connections = [] } = useModelConnectionsQuery();
  const proxies = connections.filter(
    (item) => item.enabled && item.type === 'openai-compat',
  );
  const selected =
    typeof connection.config.proxyConnectionId === 'string'
      ? connection.config.proxyConnectionId
      : '';
  const custom =
    !selected && Boolean(connection.config.env || connection.config.configHome);
  const proxy = proxies.find((item) => item.id === selected);
  function choose(value: string) {
    const config = { ...connection.config };
    if (value === 'custom') return;
    delete config.env;
    delete config.configHome;
    delete config.proxyConnectionId;
    delete config.defaultModel;
    if (value) config.proxyConnectionId = value;
    onChange(config);
  }
  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor="engine-model-route">
        Connect through
      </label>
      <select
        id="engine-model-route"
        className="editor-input"
        value={selected || (custom ? 'custom' : '')}
        disabled={managedLocked}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">Your account</option>
        {custom && <option value="custom">Custom connection settings</option>}
        {selected && !proxy && (
          <option value={selected}>Saved proxy unavailable</option>
        )}
        {proxies.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <p className="editor-help">
        {proxy
          ? `Uses the address and key saved for ${proxy.name}. Save, then check the connection and choose a model. Tools still run on this Station.`
          : custom
            ? 'Custom CLI settings are active. Choosing your account or a saved proxy replaces those connection settings.'
            : 'Use your existing CLI account, or choose a proxy saved under Models.'}
      </p>
      {!selected && !custom && ambientOrigin && (
        <p className="editor-help">
          {`Station's environment sends this engine to ${ambientOrigin}.`}
        </p>
      )}
      <Button variant="ghost" onClick={onManageModels}>
        Manage proxies in Models
      </Button>
    </div>
  );
}
