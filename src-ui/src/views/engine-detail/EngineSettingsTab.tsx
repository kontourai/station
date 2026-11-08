import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { Field, Input } from '@kontourai/ui/react';
import type { ReactNode } from 'react';
import { ActionRow } from '../../components/ActionRow';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { FactList } from '../../components/resource-hub/FactList';
import {
  capabilityLabel,
  connectionEngineId,
  prerequisiteCategoryLabel,
  prerequisiteStatusLabel,
} from '../../utils/execution';
import { continuityFacts } from './engine-facts';
import './engine-detail.css';

/** The engine's own declarations: read-only, so facts, never inputs. */
function AboutEngine({ connection }: { connection: AgentConnectionView }) {
  const inventory = connection.capabilityInventory;
  const commands = inventory?.slashCommands ?? [];
  const backend =
    typeof connection.config.providerLabel === 'string' &&
    connection.config.providerLabel.trim()
      ? connection.config.providerLabel
      : undefined;
  return (
    <section className="engine-settings__about" aria-label="About this engine">
      <h3>About this engine</h3>
      <FactList
        facts={[
          {
            label: 'Type',
            value:
              engineDisplayLabel(
                connectionEngineId(connection) ?? connection.type,
              ) ?? connection.type,
          },
          backend !== undefined && { label: 'Model backend', value: backend },
          {
            label: 'Capabilities',
            value: connection.capabilities.map(capabilityLabel).join(', '),
          },
          {
            label: 'Continuity',
            value: continuityFacts(connection.continuity).join(' '),
          },
          {
            label: 'Description',
            value: connection.description || undefined,
          },
          inventory && {
            label: 'Inventory',
            value: [
              inventory.displayName,
              `${inventory.freshness} inventory`,
              inventory.status,
            ].join(' · '),
          },
          !!inventory?.message && {
            label: 'Inventory note',
            value: inventory.message,
          },
        ]}
      />
      {!!inventory?.models.length && (
        <details className="engine-settings__disclosure">
          <summary>{`Inventory models (${inventory.models.length})`}</summary>
          <ul className="engine-settings__commands">
            {inventory.models.map((model) => (
              <li key={model.id}>{model.name}</li>
            ))}
          </ul>
        </details>
      )}
      {commands.length > 0 && (
        <details className="engine-settings__disclosure">
          <summary>{`Native commands (${commands.length})`}</summary>
          <ul className="engine-settings__commands">
            {commands.map((command) => (
              <li key={command.id}>
                <code>{command.name}</code>
                {command.description ? ` — ${command.description}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      <EnginePrerequisites connection={connection} />
    </section>
  );
}

function EnginePrerequisites({
  connection,
}: {
  connection: AgentConnectionView;
}) {
  if (connection.prerequisites.length === 0)
    return <p className="editor-help">No prerequisites reported.</p>;
  return (
    <details className="engine-settings__disclosure" open>
      <summary>{`Prerequisites (${connection.prerequisites.length})`}</summary>
      <ul className="engine-settings__prerequisites">
        {connection.prerequisites.map((item) => (
          <li key={item.id}>
            <div className="engine-settings__prerequisite-name">
              <span>{item.name}</span>
              <span className="plugins__cap plugins__cap--ref">
                {prerequisiteCategoryLabel(item.category)}
              </span>
              <span
                className={`plugins__cap plugins__cap--ref ${item.status === 'installed' ? 'plugins__cap--ok' : 'plugins__cap--error'}`}
              >
                {prerequisiteStatusLabel(item.status)}
              </span>
            </div>
            {item.description && (
              <p className="editor-help">{item.description}</p>
            )}
            {item.installGuide && (
              <>
                <ol className="engine-settings__steps">
                  {item.installGuide.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                {item.installGuide.links?.map((link) => (
                  <a
                    key={link}
                    className="engine-settings__guide"
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Documentation →
                  </a>
                ))}
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * What the reader can change about an engine, then what it declares, then
 * Reset. The detail's unsaved-changes bar saves the edits; Check connection
 * runs on saved settings, and its result shows under the page header.
 */
export function EngineSettingsTab({
  draft,
  dirty,
  onNameChange,
  onEnabledChange,
  routing,
  appHome,
  skills,
  connectionDetails,
  saving,
  checking,
  onCheck,
  resetting,
  onReset,
}: {
  draft: AgentConnectionView;
  dirty: boolean;
  onNameChange: (name: string) => void;
  onEnabledChange: (enabled: boolean) => void;
  routing?: ReactNode;
  appHome?: ReactNode;
  skills?: ReactNode;
  connectionDetails?: ReactNode;
  saving: boolean;
  checking: boolean;
  onCheck: () => void;
  resetting: boolean;
  onReset: () => void;
}) {
  return (
    <>
      <section className="engine-settings__form" aria-label="Engine settings">
        <Field label="Name" htmlFor="agent-provider-name">
          <Input
            id="agent-provider-name"
            value={draft.name}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </Field>
        <Checkbox
          id="runtime-enabled"
          checked={draft.enabled}
          onChange={onEnabledChange}
        >
          Expose this engine in Connections and agent setup
        </Checkbox>
        {routing}
        {skills}
        {appHome}
      </section>
      <div className="engine-settings__actions">
        <ActionRow
          label="Engine settings actions"
          overflowLabel="More engine actions"
          primary={
            <Button onClick={onCheck} disabled={checking || dirty}>
              {checking ? 'Checking…' : 'Check connection'}
            </Button>
          }
        />
        <p className="editor-help">
          {dirty
            ? 'Save changes before checking. A check sends one short message.'
            : 'Check connection sends one short message (uses a little model allowance).'}
        </p>
      </div>
      <AboutEngine connection={draft} />
      {connectionDetails}
      <section className="engine-settings__danger" aria-label="Reset">
        <h3>Reset</h3>
        <p className="editor-help">
          Removes this engine's saved settings and disconnects it.
        </p>
        <Button
          variant="danger-outline"
          onClick={onReset}
          disabled={saving || resetting}
        >
          {resetting ? 'Resetting…' : 'Reset to defaults'}
        </Button>
      </section>
    </>
  );
}
