import {
  useIntegrationsQuery,
  useKnowledgeRootsQuery,
} from '@kontourai/station-sdk';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { Button } from '../../components/Button';
import { Checkbox } from '../../components/Checkbox';
import { Dialog } from '../../components/Dialog';
import { InfoTip } from '../../components/InfoTip';
import { IntegrationGlyph } from '../../components/icons/IntegrationGlyph';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import { ErrorState, Skeleton } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import './ToolsSection.css';
import type { ProjectForm } from './types';

export function ToolsSection({
  slug,
  form,
  setForm,
}: {
  slug: string;
  form: ProjectForm;
  setForm: Dispatch<SetStateAction<ProjectForm | null>>;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const integrations = useIntegrationsQuery();
  const roots = useKnowledgeRootsQuery();
  const projectStores =
    roots.data?.filter(
      (root) =>
        root.scope.kind === 'project' && root.scope.projectSlug === slug,
    ) ?? [];
  const selected = new Set(form.toolDefaults?.mcpServers ?? []);
  const catalog = [
    ...(integrations.data ?? []),
    ...[...selected]
      .filter((id) => !integrations.data?.some((item) => item.id === id))
      .map((id) => ({
        id,
        displayName: id,
        description: 'This configured integration is unavailable.',
        enabled: false,
      })),
  ].filter((item) => item.id !== 'station-knowledge');
  const setServers = (id: string, enabled: boolean) =>
    setForm((current) => {
      if (!current) return current;
      const ids = new Set(current.toolDefaults?.mcpServers ?? []);
      if (enabled) ids.add(id);
      else ids.delete(id);
      return {
        ...current,
        toolDefaults: { ...current.toolDefaults, mcpServers: [...ids] },
      };
    });
  const renderIntegration = (integration: (typeof catalog)[number]) => (
    <PageRow
      className="project-tools__row"
      key={integration.id}
      label={
        <>
          <IntegrationGlyph id={integration.id} size={18} />{' '}
          <span className="project-tools__name">
            {integration.displayName || integration.id}
          </span>{' '}
          {integration.description && (
            <InfoTip label={integration.displayName || integration.id}>
              {integration.description}
            </InfoTip>
          )}
        </>
      }
      control={
        <Checkbox
          checked={selected.has(integration.id)}
          disabled={
            !selected.has(integration.id) &&
            (integration.enabled === false || selected.size >= 32)
          }
          onChange={(checked) => setServers(integration.id, checked)}
        >
          <span className="sr-only">
            Add {integration.displayName || integration.id} to Project agents
          </span>
        </Checkbox>
      }
    />
  );
  return (
    <PageSection
      id="section-tools"
      className="project-settings__section project-tools"
      title={
        <>
          Tools{' '}
          <InfoTip label="Project tools">
            Adds tools to agents working in this Project. Agent restrictions,
            disabled tools, and approvals still apply. Start a new
            external-engine chat to pick up changes. Native chats pick them up
            on the next turn.
          </InfoTip>
        </>
      }
      actions={
        <Button
          size="sm"
          onClick={() => setAdding(true)}
          disabled={integrations.isLoading || integrations.isError}
        >
          Add tools
        </Button>
      }
    >
      <PageRow
        className="project-tools__row"
        label={
          <>
            Use Knowledge{' '}
            <InfoTip label="Use Knowledge">
              Registered Project stores are detected automatically. Adds Station
              Knowledge when a store exists; records are read when needed.
            </InfoTip>
          </>
        }
        control={
          <Toggle
            label="Use Project Knowledge tools"
            checked={form.toolDefaults?.knowledge !== false}
            onChange={(knowledge) =>
              setForm((current) =>
                current
                  ? {
                      ...current,
                      toolDefaults: { ...current.toolDefaults, knowledge },
                    }
                  : current,
              )
            }
          />
        }
        description={
          <span className="editor-hint">
            {roots.isError
              ? 'Store status unavailable'
              : roots.isLoading
                ? 'Checking stores…'
                : projectStores.length
                  ? `${projectStores.length} store${projectStores.length === 1 ? '' : 's'}`
                  : 'No store yet'}
          </span>
        }
      />
      {integrations.isLoading ? (
        <Skeleton variant="line" />
      ) : integrations.isError ? (
        <ErrorState
          title="Could not load tools"
          action={
            <Button onClick={() => void integrations.refetch()}>Retry</Button>
          }
        />
      ) : (
        catalog.filter((item) => selected.has(item.id)).map(renderIntegration)
      )}
      {adding && (
        <Dialog
          title="Project tools"
          closeLabel="Close Project tools"
          onClose={() => setAdding(false)}
          footer={<Button onClick={() => setAdding(false)}>Done</Button>}
        >
          <input
            className="editor-input"
            aria-label="Find Project tools"
            placeholder="Find tools"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {catalog
            .filter((item) =>
              `${item.displayName ?? item.id} ${item.description ?? ''}`
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .map(renderIntegration)}
        </Dialog>
      )}
    </PageSection>
  );
}
