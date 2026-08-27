import { deriveAgentEditorTabs } from '@kontourai/station-contracts/agent-capability-profile';
import {
  type AuthoredCapabilityFlags,
  agentEngineValidationFindings,
} from '@kontourai/station-contracts/agent-validation';
import { resolveEngineCapabilityMatrix } from '@kontourai/station-contracts/engine-capability-matrix';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useAgentConnectionsQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import {
  agentConnectionLabel,
  runtimeCatalogVisibleModels,
} from '../utils/execution';
import { AgentDelegationDenialCatalog } from './agent-editor/AgentDelegationDenialCatalog';
import { AgentEditorBasicTab } from './agent-editor/AgentEditorBasicTab';
import { AgentEditorCommandsTab } from './agent-editor/AgentEditorCommandsTab';
import { AgentEditorCredentialProfile } from './agent-editor/AgentEditorCredentialProfile';
import { AgentEditorEngineSelection } from './agent-editor/AgentEditorEngineSelection';
import {
  AgentEditorModelOptionsSection,
  deliversModelOptions,
} from './agent-editor/AgentEditorModelOptionsSection';
import { AgentEditorModelSection } from './agent-editor/AgentEditorModelSection';
import { AgentEditorPromptTab } from './agent-editor/AgentEditorPromptTab';
import { AgentEditorSkillsTab } from './agent-editor/AgentEditorSkillsTab';
import { AgentEditorToolsTab } from './agent-editor/AgentEditorToolsTab';
import type { AgentEditorFormProps } from './agent-editor/types';
import './editor-layout.css';

export type { AgentFormData } from './agent-editor/types';

/**
 * DESIGN.md §3 — ONE scrolling page. The tabs are gone (§8): they hid the
 * engine question behind a tab strip while the answer decided what every
 * other tab could even contain.
 *
 * Section order is the dependency order (P1): Basics, Engine, then whatever
 * that engine makes true — §3.3 Model for Station's own engine, §3.4 Model
 * options for an installed CLI — then the agent-owned sections.
 */
export function AgentEditorForm(props: AgentEditorFormProps) {
  const {
    form,
    availableTools,
    availableSkills,
    integrationTools,
    onNavigate,
    onOpenAddModal,
    authoredCommands,
    engineKind,
    onEngineKindChange,
    stationConnectionId,
  } = props;

  const { data: engineConnections = [] } = useAgentConnectionsQuery() as {
    data?: AgentConnectionView[];
  };
  const [expandedIntegrations, setExpandedIntegrations] = useState<
    Record<string, boolean>
  >({});

  const boundConnection = engineConnections.find(
    (connection) => connection.id === form.execution.agentConnectionId,
  );
  const matrix = resolveEngineCapabilityMatrix(
    form.execution.agentConnectionId,
    boundConnection,
  );
  const authored: AuthoredCapabilityFlags = {
    prompt: !!form.prompt.trim(),
    skills: form.skills.length > 0,
    tools: form.tools.mcpServers.length > 0,
    commands: !!authoredCommands && Object.keys(authoredCommands).length > 0,
  };
  const sections = deriveAgentEditorTabs(matrix, authored);

  const engineDisplayName =
    boundConnection?.name ||
    agentConnectionLabel(form.execution.agentConnectionId) ||
    'Station';
  const findings = agentEngineValidationFindings(
    matrix,
    authored,
    engineDisplayName,
  );
  const findingFor = (capability: 'prompt' | 'skills' | 'tools' | 'commands') =>
    findings.find((finding) => finding.capability === capability);

  const toolsSupported = matrix.toolServers.state !== 'unsupported';
  const engineDefaultToolsHint = toolsSupported
    ? ((
        boundConnection?.config as { provideToolServers?: string[] } | undefined
      )?.provideToolServers?.length ?? undefined)
    : undefined;
  const skillsSupported = matrix.skills.state !== 'unsupported';
  const engineDefaultSkillsHint = skillsSupported
    ? ((boundConnection?.config as { provideSkills?: string[] } | undefined)
        ?.provideSkills?.length ?? undefined)
    : undefined;

  // §3.3 vs §3.4 — the two are mutually exclusive by construction, which is
  // what makes Y2 structural rather than a rule someone has to remember: a
  // CLI agent's page has no branch that can mention a model connection.
  const stationEngine = engineKind === 'model' && matrix.engineId === 'station';
  const cliModels = runtimeCatalogVisibleModels(boundConnection);
  const modelSelectable = matrix.modelSelection.state !== 'unsupported';
  const showModelOptions =
    engineKind === 'cli' &&
    !!boundConnection &&
    deliversModelOptions({
      modelSelectable,
      models: cliModels,
      selectedModelId: form.modelId,
    });

  return (
    <>
      <section className="agent-editor__section" aria-labelledby="agent-basics">
        <h3 id="agent-basics" className="agent-editor__section-title">
          Basics
        </h3>
        <AgentEditorBasicTab {...props} />
      </section>

      <section className="agent-editor__section" aria-labelledby="agent-engine">
        <h3 id="agent-engine" className="agent-editor__section-title">
          Engine
        </h3>
        <AgentEditorEngineSelection
          form={form}
          setForm={props.setForm}
          locked={props.locked}
          agentConnections={engineConnections}
          engineKind={engineKind}
          onEngineKindChange={onEngineKindChange}
          stationConnectionId={stationConnectionId}
        />
        {/* station#3551: which ACCOUNT of the bound engine. Renders nothing
            for engines with no app-home channel — see its docblock. */}
        <AgentEditorCredentialProfile
          form={form}
          setForm={props.setForm}
          locked={props.locked}
        />
      </section>

      {stationEngine && (
        <section
          className="agent-editor__section"
          aria-labelledby="agent-model"
        >
          <h3 id="agent-model" className="agent-editor__section-title">
            Model
          </h3>
          <p className="agent-editor__section-desc">
            What Station’s engine runs this agent on.
          </p>
          <AgentEditorModelSection
            form={form}
            setForm={props.setForm}
            appConfig={props.appConfig}
            locked={props.locked}
            isPlugin={props.isPlugin}
            isLocked={props.isLocked}
            modelChoices={runtimeCatalogVisibleModels(boundConnection)}
          />
        </section>
      )}

      {showModelOptions && (
        <section
          className="agent-editor__section"
          aria-labelledby="agent-model-options"
        >
          <h3 id="agent-model-options" className="agent-editor__section-title">
            Model options
          </h3>
          <p className="agent-editor__section-desc">
            What {engineDisplayName} lets Station set.
          </p>
          <AgentEditorModelOptionsSection
            form={form}
            setForm={props.setForm}
            locked={props.locked}
            modelSelectable={modelSelectable}
            models={cliModels}
          />
        </section>
      )}

      <section
        className="agent-editor__section"
        aria-labelledby="agent-instructions"
      >
        <h3 id="agent-instructions" className="agent-editor__section-title">
          Instructions
        </h3>
        <AgentEditorPromptTab {...props} finding={findingFor('prompt')} />
      </section>

      {(sections.some((section) => section.key === 'tools') ||
        sections.some((section) => section.key === 'skills')) && (
        <section
          className="agent-editor__section"
          aria-labelledby="agent-skills-tools"
        >
          <h3 id="agent-skills-tools" className="agent-editor__section-title">
            Skills and tools
          </h3>
          {sections.some((section) => section.key === 'skills') && (
            <AgentEditorSkillsTab
              form={form}
              setForm={props.setForm}
              locked={props.locked}
              availableSkills={availableSkills}
              onNavigate={onNavigate}
              onOpenAddModal={onOpenAddModal}
              finding={findingFor('skills')}
              engineDefaultSkillsHint={engineDefaultSkillsHint}
            />
          )}
          {sections.some((section) => section.key === 'tools') && (
            <AgentEditorToolsTab
              form={form}
              setForm={props.setForm}
              locked={props.locked}
              availableTools={availableTools}
              integrationTools={integrationTools}
              expandedIntegrations={expandedIntegrations}
              setExpandedIntegrations={setExpandedIntegrations}
              onNavigate={onNavigate}
              onOpenAddModal={onOpenAddModal}
              finding={findingFor('tools')}
              engineDefaultToolsHint={engineDefaultToolsHint}
            />
          )}
        </section>
      )}

      {sections.some((section) => section.key === 'commands') && (
        <section
          className="agent-editor__section"
          aria-labelledby="agent-commands"
        >
          <h3 id="agent-commands" className="agent-editor__section-title">
            Commands
          </h3>
          <AgentEditorCommandsTab
            commands={authoredCommands ?? {}}
            finding={findingFor('commands')}
            onNavigate={onNavigate}
          />
        </section>
      )}

      <AgentDelegationDenialCatalog delegation={form.delegation} />
    </>
  );
}
