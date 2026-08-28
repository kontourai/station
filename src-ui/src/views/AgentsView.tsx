import { useAgentsQuery } from '@kontourai/station-sdk';
import { AgentGlyph } from '../components/icons/Glyph';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { AGENTS_PANE_ID } from '../components/split-pane-metrics';
import { type AgentData } from '../contexts/AgentsContext';
import type { NavigationView } from '../types';
import { AgentsViewEditorPane } from './agent-editor/AgentsViewEditorPane';
import { useAgentsViewModel } from './agent-editor/useAgentsViewModel';
import './editor-layout.css';
import './page-layout.css';

interface AgentsViewProps {
  agents: AgentData[];
  apiBase?: string;
  availableModels: Array<{ id: string; name: string }>;
  defaultModel?: string;
  onNavigate: (view: NavigationView) => void;
}

export function AgentsView({ agents, onNavigate }: AgentsViewProps) {
  const { isLoading: agentsLoading, isError: agentsLoadFailed } =
    useAgentsQuery();
  const {
    DiscardModal,
    agentsCollectionEmpty,
    appConfig,
    availableSkills,
    availableTools,
    dirty,
    editorId,
    emptyContent,
    enableError,
    enableInFlight,
    enrich,
    error,
    form,
    handleConfigureConnection,
    handleDelete,
    handleEnableSelected,
    handleDeselect,
    handleNew,
    handleRetryLoad,
    handleSave,
    handleSelect,
    integrationTools,
    isAcp,
    isCreating,
    isEnriching,
    isLoading,
    isLocked,
    isPlugin,
    isSaving,
    listItems,
    loadError,
    locked,
    notFound,
    selectedAgent,
    selectedIsUnmaterializedEngine,
    selectedRunnability,
    toolsActivating,
    toolsActivationTimedOut,
    activationFailure,
    onRetryActivation,
    selectedSlug,
    search,
    setForm,
    setIsLocked,
    setSearch,
    startingPointChosen,
    copyPicking,
    setCopyPicking,
    handleStartWithModel,
    handleStartWithCli,
    handleCopyAgent,
    handleDuplicate,
    handleFixAgent,
    engineKind,
    setEngineKindOverride,
    createBlocked,
    promptIsRequired,
    createdNotice,
    stationConnectionId,
    validationErrors,
  } = useAgentsViewModel({ agents, onNavigate });

  return (
    <>
{/* empty-state action: creation and filter reset are adjacent */}
      <SplitPaneLayout
        paneId={AGENTS_PANE_ID}
        label="agents"
        title="Agents"
        subtitle="Who can do work here, and what each one runs on."
        items={listItems}
        loading={agentsLoading}
        selectedId={editorId}
        onSelect={handleSelect}
        onDeselect={handleDeselect}
        onSearch={setSearch}
        searchValue={search}
        listFilteredEmptyNoun="agents"
        collectionEmpty={agentsCollectionEmpty}
        searchPlaceholder="Search agents..."
        onAdd={() => handleNew()}
        addLabel="New agent"
        listEmptyTitle={
          agentsLoadFailed ? 'Couldn’t load agents' : 'No agents yet'
        }
// archive#4463: when the list is genuinely
// empty (no filter active), authoredAgents.length is always 0 too, so
// the detail pane's create-first-run card is always showing beside
// this — and its description was the exact same sentence. The card
// is the trusted surface for "how to get started"; the list keeps
// only the title, so there is one owner of the guidance.
        listEmptyDescription={
          agentsLoadFailed
            ? 'Check the Station connection, then try this page again.'
            : undefined
        }
        listIntro={
          agentsLoadFailed ? (
            <div className="agent-editor__error-banner" role="alert">
              Agent data could not be refreshed. Existing agents, if shown, may
              be out of date.
            </div>
          ) : undefined
        }
        emptyIcon={<AgentGlyph />}
        emptyDescription="Select an agent to edit, or create a new one"
        emptyContent={emptyContent}
      >
        <AgentsViewEditorPane
          isLoading={isLoading}
          notFound={notFound}
          loadError={loadError}
          error={error}
          isCreating={isCreating}
          startingPointChosen={startingPointChosen}
          copyPicking={copyPicking}
          onCopyPicking={setCopyPicking}
          onStartWithModel={handleStartWithModel}
          onStartWithCli={handleStartWithCli}
          onCopyAgent={handleCopyAgent}
          onDuplicate={handleDuplicate}
          onFixAgent={handleFixAgent}
          engineKind={engineKind}
          onEngineKindChange={setEngineKindOverride}
          stationConnectionId={stationConnectionId}
          createBlocked={createBlocked}
          promptIsRequired={promptIsRequired}
          createdNotice={createdNotice}
          onChat={() =>
            window.dispatchEvent(
              new CustomEvent('station:open-new-chat', {
                detail: { agentSlug: selectedSlug },
              }),
            )
          }
          agents={agents}
          selectedSlug={selectedSlug}
          selectedAgent={selectedAgent}
          isAcp={isAcp}
          isPlugin={isPlugin}
          locked={locked}
          isLocked={isLocked}
          dirty={dirty}
          isSaving={isSaving}
          validationErrors={validationErrors}
          availableTools={availableTools}
          availableSkills={availableSkills}
          integrationTools={integrationTools}
          appConfig={appConfig}
          enrich={enrich}
          isEnriching={isEnriching}
          onNavigate={onNavigate}
          onDeselect={handleDeselect}
          onRetryLoad={handleRetryLoad}
          onDelete={handleDelete}
          onSave={handleSave}
          onUnlockPlugin={() => setIsLocked(false)}
          form={form}
          setForm={setForm}
          selectedRunnability={selectedRunnability}
          selectedIsUnmaterializedEngine={selectedIsUnmaterializedEngine}
          onEnable={handleEnableSelected}
          enableInFlight={enableInFlight}
          enableError={enableError}
          onConfigureConnection={handleConfigureConnection}
          toolsActivating={toolsActivating}
          toolsActivationTimedOut={toolsActivationTimedOut}
          activationFailure={activationFailure}
          onRetryActivation={onRetryActivation}
        />
      </SplitPaneLayout>

      <DiscardModal />
    </>
  );
}
