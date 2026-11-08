import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { Field, Input, Select } from '@kontourai/ui/react';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Empty, FilteredEmpty } from '../../components/state';
import {
  runtimeCatalogSourceLabel,
  runtimeCatalogVisibleModels,
} from '../../utils/execution';
import { engineModelRouteLabel } from './engine-facts';
import './engine-detail.css';

/**
 * Where this engine's model list comes from: the engine's own answer, its
 * cached or built-in list, or the saved proxy it routes through.
 */
export function engineCatalogSourceLabel(
  connection: AgentConnectionView,
): string {
  const via = engineModelRouteLabel(connection);
  if (via) return `via ${via}`;
  return runtimeCatalogSourceLabel(connection.runtimeCatalog?.source ?? 'none');
}

/**
 * The engine's models, searchable, with the default the draft holds. The
 * default is an edit like any other: it is saved with the Settings save.
 */
export function EngineModelsTab({
  connection,
  defaultModel,
  onDefaultModelChange,
  refreshDisabled,
  refreshing,
  onRefresh,
}: {
  connection: AgentConnectionView;
  defaultModel: string;
  onDefaultModelChange: (id: string) => void;
  /** Refresh reads the saved settings, so it waits for a save. */
  refreshDisabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState('');
  const models = runtimeCatalogVisibleModels(connection);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? models.filter(
        (model) =>
          model.name.toLowerCase().includes(needle) ||
          model.id.toLowerCase().includes(needle),
      )
    : models;
  const unlisted =
    !!defaultModel && !models.some((model) => model.id === defaultModel);
  return (
    <section className="engine-models" aria-label="Models">
      <div className="engine-models__toolbar">
        <Field label="Default model" htmlFor="agent-default-model">
          <Select
            id="agent-default-model"
            value={defaultModel}
            onChange={(event) => onDefaultModelChange(event.target.value)}
          >
            <option value="">Let the engine choose</option>
            {unlisted && (
              <option value={defaultModel}>
                {defaultModel} (not currently listed)
              </option>
            )}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          onClick={onRefresh}
          disabled={refreshDisabled || refreshing}
          title={
            refreshDisabled ? 'Save changes before refreshing.' : undefined
          }
        >
          {refreshing ? 'Refreshing…' : 'Refresh models'}
        </Button>
      </div>
      <p className="engine-models__source">
        {`${models.length} ${models.length === 1 ? 'model' : 'models'} · ${engineCatalogSourceLabel(connection)}`}
        {connection.runtimeCatalog?.reason
          ? ` · ${connection.runtimeCatalog.reason}`
          : ''}
      </p>
      {models.length === 0 ? (
        <Empty
          variant="compact"
          label="The engine has not listed its models"
          description="It chooses its own model until it does."
        />
      ) : (
        <>
          <Field label="Search models" htmlFor="engine-model-search">
            <Input
              id="engine-model-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          {shown.length === 0 ? (
            <FilteredEmpty
              query={query}
              noun="models"
              variant="compact"
              onClear={() => setQuery('')}
            />
          ) : (
            <div className="engine-models__table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">ID</th>
                    <th scope="col">Default</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((model) => (
                    <tr key={model.id}>
                      <td>{model.name}</td>
                      <td>
                        <code>{model.id}</code>
                      </td>
                      <td>
                        {model.id === defaultModel ? (
                          <>
                            <span aria-hidden="true">★</span>
                            <span className="sr-only">Default</span>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
