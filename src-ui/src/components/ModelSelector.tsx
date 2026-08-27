import { useEffect, useMemo, useRef, useState } from 'react';
import { useModelCapabilities } from '../contexts/ModelCapabilitiesContext';
import { useModels } from '../contexts/ModelsContext';
import { isComposingKeyEvent } from '../lib/isComposingKeyEvent';
import { AutocompleteSelector } from './AutocompleteSelector';

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
  models: Model[];
  currentModel?: string;
  agentDefaultModel?: string | { modelId: string };
  onSelect: (model: Model) => void;
  onClose: () => void;
  maxHeight?: string;
}

export function ModelSelectorAutocomplete({
  query,
  models,
  currentModel,
  agentDefaultModel,
  onSelect,
  onClose,
  maxHeight,
}: ModelSelectorAutocompleteProps) {
  const capabilities = useModelCapabilities();

  const items = useMemo(() => {
    const searchTerm = (query || '').toLowerCase();
    const filtered = (models || []).filter(
      (m) =>
        m.name.toLowerCase().includes(searchTerm) ||
        m.id.toLowerCase().includes(searchTerm) ||
        m.originalId.toLowerCase().includes(searchTerm),
    );

    const normalizeId = (id: any) => {
      if (typeof id !== 'string') return '';
      return id.replace(/^us\./, '');
    };
    const currentModelStr =
      typeof currentModel === 'string' ? currentModel : '';
    const agentDefaultModelStr =
      typeof agentDefaultModel === 'string'
        ? agentDefaultModel
        : typeof agentDefaultModel === 'object' && agentDefaultModel?.modelId
          ? agentDefaultModel.modelId
          : '';

    const mapped = filtered.map((model) => {
      const isActive =
        normalizeId(currentModelStr) === normalizeId(model.id) ||
        currentModelStr === model.id ||
        currentModelStr === model.originalId;

      const isAgentDefault =
        normalizeId(agentDefaultModelStr) === normalizeId(model.id) ||
        agentDefaultModelStr === model.id ||
        agentDefaultModelStr === model.originalId;

      const capability = capabilities.find(
        (c) =>
          c.modelId === model.id ||
          model.id.endsWith(c.modelId) ||
          c.modelId.endsWith(model.id),
      );
      const modalities = [];
      if (capability?.supportsImages) modalities.push('images');
      if (capability?.supportsVideo) modalities.push('video');
      if (capability?.supportsAudio) modalities.push('audio');
      const modalityStr =
        modalities.length > 0 ? ` • ${modalities.join(' ')}` : '';

      return {
        id: model.id,
        title: model.name,
        description: `ID: ${model.id}${modalityStr}`,
        badge: isActive
          ? 'Active'
          : isAgentDefault
            ? 'Agent Default'
            : undefined,
        metadata: model,
        isActive,
        isAgentDefault,
      };
    });

    return mapped.sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.isAgentDefault && !b.isAgentDefault) return -1;
      if (!a.isAgentDefault && b.isAgentDefault) return 1;
      return 0;
    });
  }, [query, models, currentModel, agentDefaultModel, capabilities]);

  return (
    <AutocompleteSelector
      items={items}
      onSelect={(item) => onSelect(item.metadata)}
      onClose={onClose}
      emptyMessage="No models found"
      maxHeight={maxHeight}
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
}

export function ModelSelector({
  value,
  onChange,
  placeholder,
  defaultModel,
  models: providedModels,
  id,
}: ModelSelectorProps) {
  const globalModels = useModels();
  const models = providedModels ?? globalModels;
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
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
    let filtered = models;
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

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) =>
          Math.min(prev + 1, filteredModels.length - 1),
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
        e.preventDefault();
        if (filteredModels[selectedIndex]) {
          onChange(filteredModels[selectedIndex].id);
          setIsOpen(false);
          setSearch('');
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        setSearch('');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, filteredModels, onChange]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={isOpen ? search : displayValue}
        onChange={(e) => setSearch(e.target.value)}
        onFocus={() => {
          setIsOpen(true);
          setSearch('');
          setSelectedIndex(0);
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
      {isOpen && filteredModels.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: '4px',
            maxHeight: '300px',
            overflowY: 'auto',
            zIndex: 1000,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
          }}
        >
          {filteredModels.map((model, idx) => {
            const isActive = model.id === value || (!value && model.id === '');
            const isSelected = idx === selectedIndex;
            const isDefaultOption = model.id === '';

            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only convenience; ArrowUp/ArrowDown/Enter navigate and select via the window-level listener above.
              <div
                key={model.id || 'default'}
                onMouseDown={() => {
                  onChange(model.id);
                  setIsOpen(false);
                  setSearch('');
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  background: isSelected ? 'var(--bg-hover)' : 'transparent',
                  borderLeft: isSelected
                    ? '3px solid var(--accent-primary)'
                    : '3px solid transparent',
                  borderBottom: isDefaultOption
                    ? '1px solid var(--border-primary)'
                    : 'none',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '2px' }}>
                  {model.name}
                  {isActive && !isDefaultOption && (
                    <span
                      style={{
                        marginLeft: '8px',
                        fontSize: '11px',
                        color: 'var(--accent-primary)',
                      }}
                    >
                      (active)
                    </span>
                  )}
                </div>
                {!isDefaultOption && (
                  <div
                    style={{ fontSize: '12px', color: 'var(--text-secondary)' }}
                  >
                    {model.id}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
