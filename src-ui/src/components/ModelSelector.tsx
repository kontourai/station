import { type RefObject, useMemo, useRef, useState } from 'react';
import { useModels } from '../contexts/ModelsContext';
import { useModelPickerPreferences } from '../settings/modelPickerPreferences';
import {
  chooseModelRoute,
  visibleModelChoices,
} from '../settings/modelPickerSelection';
import type { SelectableModel } from '../utils/modelCapabilities';
import { AutocompleteSelector } from './AutocompleteSelector';
import { ModelIcon } from './icons/ModelIcon';

export interface Model {
  id: string;
  name: string;
  originalId: string;
}

function normalizeModelLookupId(id: string | undefined): string {
  if (!id) return '';
  return id.trim().replace(/^(us|eu|ap|sa|ca|af|me)\./, '');
}

function findModelById(
  models: Model[],
  value: string | undefined,
): Model | null {
  if (!value) return null;
  const normalized = normalizeModelLookupId(value);
  return (
    models.find(
      (model) =>
        model.id === value ||
        model.originalId === value ||
        normalizeModelLookupId(model.id) === normalized ||
        normalizeModelLookupId(model.originalId) === normalized,
    ) ?? null
  );
}

// Autocomplete version for chat interface
interface ModelSelectorAutocompleteProps {
  query: string;
  models: SelectableModel[];
  currentModel?: string;
  agentDefaultModel?: string | { modelId: string };
  onSelect: (model: SelectableModel) => void;
  onClose: () => void;
  maxHeight?: string;
  anchorRef?: RefObject<HTMLElement | null>;
}

export function ModelSelectorAutocomplete({
  query,
  models,
  currentModel,
  agentDefaultModel,
  onSelect,
  onClose,
  maxHeight,
  anchorRef,
}: ModelSelectorAutocompleteProps) {
  const preferences = useModelPickerPreferences();
  const items = useMemo(
    () =>
      visibleModelChoices(models, preferences, query).map((model) => ({
        id: `${model.providerId ?? 'current'}:${model.id}`,
        title: model.name,
        description: [
          model.engineName,
          model.providerName,
          model.stationName,
          model.unavailableReason,
        ]
          .filter(Boolean)
          .join(' · '),
        badge:
          model.id === currentModel
            ? 'Active'
            : model.id ===
                (typeof agentDefaultModel === 'string'
                  ? agentDefaultModel
                  : agentDefaultModel?.modelId)
              ? 'Agent default'
              : undefined,
        metadata: model,
        disabled: model.available === false,
        leading: <ModelIcon model={model} />,
      })),
    [query, models, currentModel, agentDefaultModel, preferences],
  );

  return (
    <AutocompleteSelector
      items={items}
      onSelect={(item) => chooseModelRoute(item.metadata, onSelect)}
      onClose={onClose}
      emptyMessage="No models found"
      maxHeight={maxHeight}
      anchorRef={anchorRef}
    />
  );
}

// Form input version with dropdown
interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
  placeholder?: string;
  defaultModel?: string; // Global default model to show as option
  models?: Model[];
  id?: string; // associate a <label htmlFor> with the input (a11y + testing)
  /** Refuse edits while a prerequisite selection is missing. */
  disabled?: boolean;
}

export function ModelSelector({
  value,
  onChange,
  placeholder,
  defaultModel,
  models: providedModels,
  id,
  disabled = false,
}: ModelSelectorProps) {
  const globalModels = useModels();
  const models = providedModels ?? globalModels;
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedModel = findModelById(models, value);
  const defaultModelInfo = findModelById(models, defaultModel);

  // Display value: show default model info if no value, otherwise show selected model
  const displayValue = value
    ? selectedModel?.name || value
    : defaultModelInfo
      ? `${defaultModelInfo.name} (default)`
      : placeholder || 'Select a model...';

  const filteredModels = useMemo(() => {
    let filtered = [...models];
    if (search) {
      const term = search.toLowerCase();
      filtered = models.filter(
        (m) =>
          m.name.toLowerCase().includes(term) ||
          m.id.toLowerCase().includes(term),
      );
    }

    // Add default option at the top if we have a default model
    const options =
      defaultModel && defaultModelInfo
        ? [
            {
              ...defaultModelInfo,
              id: '',
              name: `${defaultModelInfo.name} (default)`,
              originalId: '',
            },
          ]
        : [];

    // Sort: selected model first (if not empty), then alphabetically
    const sorted = filtered.sort((a, b) => {
      if (value && a.id === value) return -1;
      if (value && b.id === value) return 1;
      return a.name.localeCompare(b.name);
    });

    // Allow committing an off-catalog model id the user types (e.g. a brand-new
    // model not yet in a connection's catalog). Keeps this single picker usable
    // for both Station and External agents without a separate free-text field.
    const hasExactMatch = models.some(
      (m) => m.id === search || m.name === search,
    );
    const custom =
      search && !hasExactMatch
        ? [{ id: search, name: `Use “${search}”`, originalId: search }]
        : [];

    return [...options, ...sorted, ...custom];
  }, [models, search, value, defaultModel, defaultModelInfo]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={isOpen ? search : displayValue}
        onChange={(e) => setSearch(e.target.value)}
        disabled={disabled}
        onFocus={() => {
          if (disabled) return;
          setIsOpen(true);
          setSearch('');
        }}
        onBlur={() => {
          setTimeout(() => {
            setIsOpen(false);
            setSearch('');
          }, 200);
        }}
        placeholder={placeholder || 'Select a model...'}
        className="editor-input"
        style={{ width: '100%' }}
      />
      {isOpen && (
        <AutocompleteSelector
          anchorRef={inputRef}
          items={filteredModels.map((model) => ({
            id: model.id || 'default',
            title: model.name,
            metadata: model,
          }))}
          onSelect={(item) => {
            onChange(item.metadata.id);
            setIsOpen(false);
            setSearch('');
          }}
          onClose={() => {
            setIsOpen(false);
            setSearch('');
          }}
        />
      )}
    </div>
  );
}
