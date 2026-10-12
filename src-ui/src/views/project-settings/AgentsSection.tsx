import {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';
import { useAgentsQuery } from '@kontourai/station-sdk';
import type { Dispatch, SetStateAction } from 'react';
import { Checkbox } from '../../components/Checkbox';
import { AgentIcon } from '../../components/icons/AgentIcon';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import type { ProjectForm } from './types';
import { globalAgentsOnly } from './utils';

export function AgentsSection({
  form,
  setForm,
  projectSlug,
}: {
  form: ProjectForm;
  projectSlug?: string;
  setForm: Dispatch<SetStateAction<ProjectForm | null>>;
}) {
  const { data: fetchedAgents = [] } = useAgentsQuery() as {
    data?: Array<{
      slug: AgentId;
      name: string;
      icon?: string;
      project?: string;
    }>;
  };
  // §3.3: the availability filter selects among GLOBAL agents only — a
  // project-owned agent is implicitly available in its own project and
  // never subject to this opt-in filter.
  const allAgents = globalAgentsOnly(fetchedAgents);
  const selected = new Set(form.agents ?? []);
  const allSelected = form.agents === undefined;
  const defaultAgents = fetchedAgents.filter(
    (agent) =>
      agent.project === projectSlug ||
      (agent.project === undefined &&
        (allSelected || selected.has(agent.slug))),
  );

  function toggle(slug: AgentId) {
    setForm((currentForm) => {
      if (!currentForm) return currentForm;
      if (currentForm.agents === undefined) {
        return {
          ...currentForm,
          agents: allAgents
            .map((agent) => agent.slug)
            .filter((agentSlug) => agentSlug !== slug),
        };
      }
      const current = new Set(currentForm.agents ?? []);
      if (current.has(slug)) current.delete(slug);
      else current.add(slug);
      return { ...currentForm, agents: [...current] };
    });
  }

  return (
    <PageSection
      id="section-agents"
      className="project-settings__section"
      eyebrow="Availability"
      title="Agents"
      description="Choose which agents are offered when a conversation starts in this project."
    >
      <PageRow
        title="Default agent"
        description="Used when you haven’t started a chat in this project yet. Your last choice takes precedence."
      >
        <select
          className="editor-select"
          aria-label="Default agent"
          value={form.defaultAgent ?? ''}
          onChange={(event) =>
            setForm((current) =>
              current
                ? {
                    ...current,
                    defaultAgent: event.target.value
                      ? agentId(event.target.value)
                      : undefined,
                  }
                : current,
            )
          }
        >
          <option value="">Use the Station suggestion</option>
          {defaultAgents.map((agent) => (
            <option key={agent.slug} value={agent.slug}>
              {agent.name}
            </option>
          ))}
          {form.defaultAgent &&
            !defaultAgents.some(
              (agent) => agent.slug === form.defaultAgent,
            ) && (
              <option value={form.defaultAgent}>
                {form.defaultAgent} (unavailable)
              </option>
            )}
        </select>
      </PageRow>
      <span className="editor-hint">
        {allSelected
          ? 'All agents are available (no filter set).'
          : `${selected.size} agent${selected.size !== 1 ? 's' : ''} selected.`}
      </span>
      {!allSelected && (
        <button
          className="secondary-btn small"
          type="button"
          onClick={() =>
            setForm((currentForm) =>
              currentForm ? { ...currentForm, agents: undefined } : currentForm,
            )
          }
        >
          Use all agents
        </button>
      )}
      <div className="editor__tools-server">
        <div className="editor__tools-list">
          {allAgents.map((agent) => (
            <div
              key={agent.slug}
              className={`editor__tool-item${allSelected || selected.has(agent.slug) ? ' editor__tool-item--active' : ''}`}
            >
              <Checkbox
                checked={allSelected || selected.has(agent.slug)}
                onChange={() => toggle(agent.slug)}
              />
              <div className="editor__tool-info">
                <div className="editor__tool-name">
                  <AgentIcon
                    agent={agent}
                    size="small"
                    className="editor-icon-preview"
                  />{' '}
                  {agent.name}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageSection>
  );
}
