import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useState } from 'react';
import { DetailHeader } from '../../components/DetailHeader';
import { BrandIcon } from '../../components/icons/BrandIcon';
import { Empty } from '../../components/state';
import type { ACPConnectionRegistryEntry } from '../../hooks/useACPConnections';
import {
  PROVIDER_PRESETS,
  PROVIDER_TYPES,
  resolveProviderChoicePresentation,
} from './providerCatalog';
import { filterProviderChoices } from './providerChoiceSearch';

export function ProviderTypePicker({
  onAdd,
  onCancel,
  agentChoices = [],
  commandChoices = [],
  onChooseAgent,
  onChooseCommand,
}: {
  onAdd: (type: string, name: string, config?: Record<string, string>) => void;
  onCancel: () => void;
  agentChoices?: AgentConnectionView[];
  commandChoices?: ACPConnectionRegistryEntry[];
  onChooseAgent?: (connection: AgentConnectionView) => void;
  onChooseCommand?: (entry: ACPConnectionRegistryEntry | 'custom') => void;
}) {
  const [query, setQuery] = useState('');
  const presets = filterProviderChoices(query, PROVIDER_PRESETS, (preset) => [
    preset.name,
    preset.desc,
  ]);
  const types = filterProviderChoices(query, PROVIDER_TYPES, (option) => [
    option.name,
    option.desc,
  ]);
  const agents = filterProviderChoices(query, agentChoices, (choice) => [
    choice.name,
  ]);
  const commands = filterProviderChoices(query, commandChoices, (choice) => [
    choice.name,
    choice.description,
  ]);
  return (
    <div className="provider-picker-modal">
      <DetailHeader title="Add model connection">
        <button type="button" className="editor-btn" onClick={onCancel}>
          Cancel
        </button>
      </DetailHeader>
      <div className="provider-picker-modal__body">
        <p className="provider-picker-modal__desc">
          Pick the name you recognize. Station will show only the setup it
          needs.
        </p>
        <input
          type="search"
          className="list-filter-input provider-picker-modal__search"
          placeholder="Search providers…"
          aria-label="Search providers"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {presets.length > 0 && (
          <>
            <div className="provider-overview__group-label">Popular</div>
            <div className="provider-overview__quickstart-options">
              {presets.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className="provider-overview__quickstart-btn"
                  onClick={() => onAdd(preset.type, preset.name, preset.config)}
                >
                  <span className="provider-overview__quickstart-icon">
                    <BrandIcon
                      name={preset.name}
                      id={preset.id}
                      identiconSeed={`provider:${preset.id}`}
                      size={22}
                    />
                  </span>
                  <div>
                    <div className="provider-overview__quickstart-name">
                      {preset.name}
                    </div>
                    <div className="provider-overview__quickstart-meta">
                      {preset.desc}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        {types.length > 0 && (
          <>
            <div className="provider-overview__group-label">More</div>
            <div className="provider-overview__quickstart-options">
              {types.map((option) => (
                <button
                  type="button"
                  key={option.type}
                  className="provider-overview__quickstart-btn"
                  onClick={() => onAdd(option.type, option.name)}
                >
                  <span className="provider-overview__quickstart-icon">
                    {option.icon}
                  </span>
                  <div>
                    <div className="provider-overview__quickstart-name">
                      {option.name}
                    </div>
                    <div className="provider-overview__quickstart-meta">
                      {option.desc}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        {(agents.length > 0 || commands.length > 0 || onChooseCommand) && (
          <>
            {/*
              #592 slice 2: the picker's cross-reference to the Engines tab
              used to be two groups with different chrome (a native-app list
              here, the ACP registry there) for what the Engines tab itself
              now treats as one catalogue. One group, one noun, routing every
              choice into that same Add-engine flow.
            */}
            <div className="provider-overview__group-label">Engines</div>
            <div className="provider-overview__quickstart-options">
              {agents.map((connection) => {
                const presentation = resolveProviderChoicePresentation({
                  id: connection.id,
                  kind: 'agent',
                  type: connection.type,
                  name: connection.name,
                  enabled: connection.enabled,
                  status: connection.status,
                  prerequisites: connection.prerequisites,
                  setup: connection.setup,
                  href: '',
                });
                return (
                  <button
                    type="button"
                    key={connection.id}
                    className="provider-overview__quickstart-btn"
                    onClick={() => onChooseAgent?.(connection)}
                  >
                    <div>
                      <div className="provider-overview__quickstart-name">
                        {connection.name}
                      </div>
                      <div className="provider-overview__quickstart-meta">
                        {presentation.detail}
                      </div>
                    </div>
                    <span className="add-provider-modal__choice-badge">
                      {presentation.badge}
                    </span>
                  </button>
                );
              })}
              {commands.map((entry) => {
                const presentation = resolveProviderChoicePresentation({
                  id: entry.id,
                  kind: 'command',
                  type: 'acp',
                  name: entry.name,
                  enabled: true,
                  status: 'unknown',
                  setup: null,
                  discovery: entry.detected
                    ? 'detected-unconfigured'
                    : undefined,
                  description: entry.description,
                  href: '',
                });
                return (
                  <button
                    type="button"
                    key={entry.id}
                    className="provider-overview__quickstart-btn"
                    onClick={() => onChooseCommand?.(entry)}
                  >
                    <div>
                      <div className="provider-overview__quickstart-name">
                        {entry.name}
                      </div>
                      <div className="provider-overview__quickstart-meta">
                        {presentation.detail}
                      </div>
                    </div>
                    <span className="add-provider-modal__choice-badge">
                      {presentation.badge}
                    </span>
                  </button>
                );
              })}
              {/*
                What this creates: an ACP engine connection
                (`onChooseCommand('custom')` routes into the same
                `connections-acp-new` custom setup stage every other command
                choice above does) — never the OpenAI-compatible custom MODEL
                connection, which lives under "More" and stays a model
                connection.
              */}
              <button
                type="button"
                className="provider-overview__quickstart-btn"
                onClick={() => onChooseCommand?.('custom')}
              >
                <div>
                  <div className="provider-overview__quickstart-name">
                    Custom engine
                  </div>
                  <div className="provider-overview__quickstart-meta">
                    Connect an engine that runs from a local command
                  </div>
                </div>
              </button>
            </div>
          </>
        )}
        {presets.length === 0 &&
          types.length === 0 &&
          agents.length === 0 &&
          commands.length === 0 && (
            <Empty
              variant="compact"
              label="Nothing matches your search"
              description="Try a shorter search — Station can connect any OpenAI-compatible endpoint."
            />
          )}
      </div>
    </div>
  );
}
