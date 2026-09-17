import type { PluginVisibilityPrincipal } from '@kontourai/station-contracts/plugin-visibility';
import {
  isPluginVisibilityForbidden,
  usePluginsQuery,
  usePluginVisibilityQuery,
  useSetPluginVisibilityMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Empty, ErrorState, Skeleton } from '../../components/state';
import { errorText } from '../../utils/errorText';
import './PluginVisibilitySection.css';
import { SettingsSection } from './SettingsSection';
import { settingsRow } from './settings-catalog';

/**
 * Plugin visibility (#2067) — the operator's grant surface, under Settings
 * rather than in the plugin panel.
 *
 * Installation stays instance-wide: nothing here installs, removes, or
 * permits anything. It edits ONE fact — which installed plugins a person can
 * see and compose a Board from — and the server derives every projection from
 * that fact. A person's own list is never assembled here; it is
 * `GET /api/plugins`, filtered before it leaves the Station.
 *
 * Operator-only, and gated by the SERVER: the directory route re-resolves the
 * request's principal and answers 403 to anybody else. This component reads
 * that refusal and renders nothing — the posture the SDK domain documents,
 * and the same one `useAnswerSharesQuery` callers take. It deliberately does
 * not ask "am I the operator" first and decide for itself; that would be a
 * second derivation of an authority the server already owns.
 */

/** The toggle for one principal/plugin pair. */
function VisibilityToggle({
  principal,
  plugin,
  displayName,
  busy,
  onChange,
}: {
  principal: PluginVisibilityPrincipal;
  plugin: string;
  displayName: string;
  busy: boolean;
  onChange: (grant: boolean) => void;
}) {
  const granted = principal.plugins.includes(plugin);
  return (
    <label className="plugin-visibility__toggle">
      <input
        type="checkbox"
        checked={granted}
        disabled={busy}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={`Share ${displayName} with ${principal.display}`}
      />
      <span>{displayName}</span>
    </label>
  );
}

function PrincipalRow({
  principal,
  plugins,
  busyKey,
  onChange,
}: {
  principal: PluginVisibilityPrincipal;
  plugins: Array<{ name: string; displayName: string }>;
  busyKey: string | null;
  onChange: (plugin: string, grant: boolean) => void;
}) {
  return (
    <div className="plugin-visibility__principal">
      <div className="plugin-visibility__name">{principal.display}</div>
      <div className="plugin-visibility__meta">
        {principal.id}
        {principal.revoked ? ' · access revoked' : ''}
      </div>
      {principal.revoked && (
        <div className="plugin-visibility__meta">
          This person no longer reaches this Station. Their grants are still
          listed so you can remove them.
        </div>
      )}
      <div className="plugin-visibility__toggles">
        {plugins.map((plugin) => (
          <VisibilityToggle
            key={plugin.name}
            principal={principal}
            plugin={plugin.name}
            displayName={plugin.displayName}
            busy={busyKey === `${principal.id} ${plugin.name}`}
            onChange={(grant) => onChange(plugin.name, grant)}
          />
        ))}
      </div>
    </div>
  );
}

export function PluginVisibilitySection() {
  const directory = usePluginVisibilityQuery();
  const installed = usePluginsQuery();
  const setVisibility = useSetPluginVisibilityMutation();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // The server's refusal, honoured as a refusal: this caller is not the
  // operator, and there is no grant surface for them to see.
  if (isPluginVisibilityForbidden(directory.error)) return null;
  // ...and nothing before it resolves either. Rendering the heading and the
  // intro while the request is in flight shows a non-operator a section
  // describing a capability they do not have, and then takes it away — the
  // chrome is a claim about the caller, so it waits for the answer. No plugin
  // data is involved either way; this is about not asserting something the
  // next tick retracts.
  if (directory.isLoading || directory.isPending) return null;

  const plugins = (installed.data ?? [])
    .filter((plugin) => typeof plugin.name === 'string')
    .map((plugin) => ({
      name: plugin.name,
      displayName: plugin.displayName || plugin.name,
    }));
  // The operator's row carries no grants to edit — they see every installed
  // plugin because the projection derives it, not because a record says so.
  const people = (directory.data?.principals ?? []).filter(
    (principal) => !principal.operator,
  );

  return (
    <SettingsSection
      icon="◇"
      title="Plugin visibility"
      id="section-plugin-visibility"
    >
      <div {...settingsRow('plugin-visibility')} tabIndex={-1}>
        <p className="plugin-visibility__intro">
          Plugins are installed once for this Station. Choose which of them each
          person who has paired with it can see and build a Board from. Someone
          who cannot see a plugin never receives it in their plugin list, and a
          Board pane from it tells them it has not been shared.
        </p>

        {installed.isLoading && <Skeleton variant="line" />}

        {directory.isError && (
          <ErrorState
            variant="compact"
            title="Plugin visibility could not be listed"
            description={errorText(directory.error)}
            action={
              <button
                type="button"
                className="button"
                onClick={() => directory.refetch()}
              >
                Retry
              </button>
            }
          />
        )}

        {setVisibility.isError && (
          <ErrorState
            variant="compact"
            title="That change was not saved"
            description={errorText(setVisibility.error)}
          />
        )}

        {directory.data && people.length === 0 && (
          <Empty
            variant="compact"
            label="Nothing here yet"
            description="Pair a device with this Station and the person using it will appear here."
          />
        )}

        {directory.data && people.length > 0 && plugins.length === 0 && (
          <Empty
            variant="compact"
            label="Nothing here yet"
            description="Install a plugin on this Station and it will appear here to share."
          />
        )}

        {people.map((principal) => (
          <PrincipalRow
            key={principal.id}
            principal={principal}
            plugins={plugins}
            busyKey={busyKey}
            onChange={(plugin, grant) => {
              setBusyKey(`${principal.id} ${plugin}`);
              setVisibility.mutate(
                { principalId: principal.id, plugin, grant },
                { onSettled: () => setBusyKey(null) },
              );
            }}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
