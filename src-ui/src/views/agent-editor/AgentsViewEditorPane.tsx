import { useEngineConnectionsQuery } from '@kontourai/station-sdk';
import { type Dispatch, type SetStateAction, useRef, useState } from 'react';
import {
  type AgentFixRoute,
  AgentReadinessCell,
  agentFixRoute,
} from '../../components/AgentReadinessCell';
import type { AgentRunnability } from '../../components/agent-runnability';
import { EngineChip } from '../../components/badges/EngineChip';
import { DetailHeader } from '../../components/DetailHeader';
import { AgentIcon } from '../../components/icons/AgentIcon';
import { InfoGlyph, LockGlyph } from '../../components/icons/Glyph';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../../components/ResponsiveDialogSurface';
import type { AgentData } from '../../contexts/AgentsContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { NavigationView, Tool } from '../../types';
import { agentEngineDescriptor } from '../../utils/engine';
import { AgentAddModal } from '../AgentAddModal';
import { AgentEditorForm, type AgentFormData } from '../AgentEditorForm';
import type { EngineKind } from './AgentEditorEngineSelection';
import {
  AgentEditorCopySourcePicker,
  AgentEditorLoadFailureState,
  AgentEditorLoadingState,
  AgentEditorNotFoundState,
  AgentEditorNotSetUpState,
  AgentEditorStartingPoints,
} from './AgentEditorStateViews';

interface AgentsViewEditorPaneProps {
  isLoading: boolean;
  notFound: boolean;
  loadError: string | null;
  error: string | null;
  isCreating: boolean;
  /** §4 beat two: a starting point has been chosen and the form is shown. */
  startingPointChosen: boolean;
  copyPicking: boolean;
  onCopyPicking: (picking: boolean) => void;
  onStartWithModel: () => void;
  onStartWithCli: () => void;
  onCopyAgent: (agent: AgentData) => void;
  onDuplicate: (agent: AgentData) => void;
  onFixAgent: (agent: AgentData, route: AgentFixRoute) => void;
  engineKind: EngineKind;
  onEngineKindChange: (kind: EngineKind) => void;
  stationConnectionId: string;
  /** §4: Create stays disabled until the chosen engine is Ready. */
  createBlocked: boolean;
  promptIsRequired: boolean;
  createdNotice: string | null;
  onChat: () => void;
  agents: AgentData[];
  selectedSlug: string | null;
  selectedAgent?: AgentData;
  isAcp: boolean;
  isPlugin: boolean;
  locked: boolean;
  isLocked: boolean;
  dirty: boolean;
  isSaving: boolean;
  validationErrors: Record<string, string>;
  availableTools: Tool[];
  availableSkills: any[];
  integrationTools: Record<string, Tool[]>;
  appConfig: any;
  enrich: (prompt: string) => Promise<string | null>;
  isEnriching: boolean;
  onNavigate: (view: NavigationView) => void;
  onDeselect: () => void;
  onRetryLoad: () => void;
  onDelete: () => void;
  onSave: () => void;
  onUnlockPlugin: () => void;
  form: AgentFormData;
  setForm: Dispatch<SetStateAction<AgentFormData>>;
  /** Shared with the New Chat picker and Home's card — see `agent-runnability`. */
  selectedRunnability?: AgentRunnability;
  /** A registry engine identity with no Agent file behind it yet. */
  selectedIsUnmaterializedEngine: boolean;
  onEnable: () => void;
  enableInFlight: boolean;
  enableError: string | null;
  onConfigureConnection: () => void;
  /** Its tools read is still retrying a "this Agent is activating" refusal. */
  toolsActivating: boolean;
  /** Activation never arrived inside the retry window. */
  toolsActivationTimedOut: boolean;
  /** The runtime gave up activating this Agent, and why. */
  activationFailure?: { reason: string; at: string };
  onRetryActivation: () => void;
}

export function AgentsViewEditorPane({
  isLoading,
  notFound,
  loadError,
  error,
  isCreating,
  startingPointChosen,
  copyPicking,
  onCopyPicking,
  onStartWithModel,
  onStartWithCli,
  onCopyAgent,
  onDuplicate,
  onFixAgent,
  engineKind,
  onEngineKindChange,
  stationConnectionId,
  createBlocked,
  promptIsRequired,
  createdNotice,
  onChat,
  agents,
  selectedSlug,
  selectedAgent,
  isAcp,
  isPlugin,
  locked,
  isLocked,
  dirty,
  isSaving,
  validationErrors,
  availableTools,
  availableSkills,
  integrationTools,
  appConfig,
  enrich,
  isEnriching,
  onNavigate,
  onDeselect,
  onRetryLoad,
  onDelete,
  onSave,
  onUnlockPlugin,
  form,
  setForm,
  selectedRunnability,
  selectedIsUnmaterializedEngine,
  onEnable,
  enableInFlight,
  enableError,
  onConfigureConnection,
  toolsActivating,
  toolsActivationTimedOut,
  activationFailure,
  onRetryActivation,
}: AgentsViewEditorPaneProps) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const [addModalType, setAddModalType] = useState<
    'integrations' | 'skills' | null
  >(null);
  const { data: agentConnections = [] } = useEngineConnectionsQuery();
  // archive#4521: the mobile footer is the ONE save affordance on a
  // touch/narrow surface (DetailHeader's own sticky bar below), so the
  // header's row must not ALSO render one there — that produced two Save
  // rows on screen at once. Same breakpoint DetailHeader.css gates the
  // footer's visibility on (`MOBILE_MEDIA_QUERY` mirrors the CSS literal).
  const isMobile = useIsMobile();

  // §4 beat one stands in for the form. The header Create button submits the
  // form, so hide it while a picker is shown — otherwise it validates an
  // empty (hidden) form and silently no-ops, reading as a dead button.
  const showStartingPoints = isCreating && !startingPointChosen && !copyPicking;
  const showCopyPicker = isCreating && copyPicking;
  const showPicker = showStartingPoints || showCopyPicker;
  const validationMessages = Object.values(validationErrors);
  const notRunnable =
    selectedRunnability && !selectedRunnability.runnable
      ? selectedRunnability
      : undefined;
  const editorUnavailable =
    isLoading || notFound || !!loadError || selectedIsUnmaterializedEngine;
  // archive#4521 items 1/2: `agentFixRoute` reads the SAME server-derived
  // `unavailableFix.kind` the Agents list and New Chat picker's repair verb
  // come from. It is consulted for exactly ONE additional case below — a
  // Station-engine agent with no `agentConnectionId` to point "Configure in
  // Connections" at (`fixRoute === 'models'`) — not for every route that
  // table can name: `enable`/`edit`/`policy`/`none` still render no action
  // here in the (marginal) shapes that reach them, unchanged from before
  // this route was consulted at all. A materialization (`notRunnable.enable`)
  // or a specific bound connection already has its own precise remedy below
  // (`onEnable`/`onConfigureConnection`).
  const fixRoute = selectedAgent ? agentFixRoute(selectedAgent) : undefined;

  return (
    <>
      {selectedIsUnmaterializedEngine ? (
        <AgentEditorNotSetUpState
          name={selectedAgent?.name ?? selectedSlug ?? 'This engine'}
          reason={notRunnable?.reason ?? 'It has no agent definition yet.'}
          {...(notRunnable?.enable
            ? { actionLabel: 'Enable', onAction: onEnable }
            : selectedAgent?.execution?.agentConnectionId
              ? {
                  actionLabel: 'Configure in Connections',
                  onAction: onConfigureConnection,
                }
              : {})}
          actionPending={enableInFlight}
          error={enableError}
          onDeselect={onDeselect}
        />
      ) : isLoading ? (
        <AgentEditorLoadingState />
      ) : notFound ? (
        <AgentEditorNotFoundState
          selectedSlug={selectedSlug}
          onDeselect={onDeselect}
        />
      ) : loadError ? (
        <AgentEditorLoadFailureState
          selectedSlug={selectedSlug}
          error={loadError}
          onRetry={onRetryLoad}
          onDeselect={onDeselect}
        />
      ) : (
        <div className="agent-inline-editor">
          <DetailHeader
            title={isCreating ? 'New Agent' : form.name || selectedSlug || ''}
            icon={
              !isCreating && selectedAgent ? (
                <AgentIcon
                  agent={selectedAgent as any}
                  size="medium"
                  className="editor-icon-preview"
                />
              ) : undefined
            }
            badge={
              isAcp
                ? {
                    label: selectedAgent?.connectionName ?? 'Engine',
                    variant: 'muted' as const,
                  }
                : isPlugin
                  ? {
                      label: selectedAgent?.plugin ?? 'Plugin',
                      variant: 'info' as const,
                    }
                  : undefined
            }
            titleAccessory={
              !isCreating && selectedAgent ? (
                <>
                  <EngineChip engine={agentEngineDescriptor(selectedAgent)} />
                  {/* archive#4521: `compact` — never a pane-local decision
                      about which states get a header chip (that was the
                      "two surfaces deciding one thing" defect this
                      replaced) — asks AgentReadinessCell for whatever short,
                      chip-native label it currently has for this agent
                      (`agentReadinessCompactState`), which is why a new
                      short-label case added there reaches here with no
                      change on this side. */}
                  <AgentReadinessCell
                    agent={selectedAgent}
                    part="status"
                    compact
                  />
                </>
              ) : undefined
            }
            mobileFooter={
              // archive#4521: gated on the SAME `isMobile` (mirrors
              // `MOBILE_MEDIA_QUERY`, DetailHeader.css's own
              // `.detail-header__mobile-footer` breakpoint) as the header
              // row's Save button below, rather than always mounting this
              // and leaving CSS alone to hide it — two mounted Save buttons
              // is exactly the bug this closes, whichever one the stylesheet
              // was supposed to hide.
              isMobile && !isAcp && !showPicker ? (
                <>
                  <button
                    type="button"
                    className="editor-btn"
                    onClick={onDeselect}
                  >
                    Cancel
                  </button>
                  {/* archive#4521: this bar is the mobile surface's
                      ONE save affordance now that the header row's own
                      button is desktop-only (below) — so it carries the same
                      dirty indicator and Create/Save wording that row used
                      to, rather than a plainer stand-in nobody would notice
                      differs. */}
                  <button
                    type="button"
                    className="editor-btn editor-btn--primary agent-editor__save-btn"
                    onClick={onSave}
                    disabled={isSaving || locked || createBlocked}
                  >
                    {dirty && !isSaving && (
                      <span
                        className="agent-inline-editor__dirty-dot"
                        role="img"
                        aria-label="Unsaved changes"
                      />
                    )}
                    {isSaving
                      ? 'Saving…'
                      : isCreating
                        ? 'Create Agent'
                        : 'Save Changes'}
                  </button>
                </>
              ) : undefined
            }
          >
            {/* §4: the agent the user just made is one click from a chat,
                and so is any other Ready agent — the same predicate the list
                row and the picker use. */}
            {!isCreating && selectedRunnability?.runnable && (
              <button type="button" className="editor-btn" onClick={onChat}>
                Chat
              </button>
            )}
            {!isCreating && selectedSlug && selectedAgent && !isAcp && (
              <>
                <button
                  ref={overflowTriggerRef}
                  type="button"
                  className="editor-btn"
                  aria-haspopup="menu"
                  aria-expanded={showOverflow}
                  onClick={() => setShowOverflow(true)}
                >
                  More actions
                </button>
                {showOverflow && (
                  <ResponsiveDialogSurface
                    ariaLabel="Agent actions"
                    onClose={() => setShowOverflow(false)}
                    historyMode="entry"
                    returnFocusTarget={overflowTriggerRef.current}
                    anchorRef={overflowTriggerRef}
                    // archive#4521: `anchorRef` alone only measures
                    // the trigger — a consuming surface still has to spend
                    // that measurement (see `ResponsiveDialogSurface`'s own
                    // docblock). With no overlay/panel classes this popover
                    // got neither the composer's anchored geometry nor the
                    // `Dialog` primitive's centered one — an inert
                    // `[data-anchored]` nobody read, floating whole document
                    // flow with no `position` at all. The trigger sits in
                    // the sticky HEADER, not a bottom bar, so this opens
                    // DOWNWARD from the anchor's bottom edge — the same
                    // top-anchored fix archive#1303 made for the Background tasks
                    // panel (`agent-actions-overlay`/`agent-actions-panel`,
                    // editor-layout.css).
                    overlayClassName="agent-actions-overlay"
                    panelClassName="agent-actions-panel"
                  >
                    <ResponsiveDialogHeader
                      title="Agent actions"
                      closeLabel="Close agent actions"
                      onClose={() => setShowOverflow(false)}
                    />
                    <div role="menu" className="composer-actions-menu__list">
                      <button
                        type="button"
                        role="menuitem"
                        className="composer-actions-menu__item"
                        onClick={() => {
                          setShowOverflow(false);
                          onDuplicate(selectedAgent);
                        }}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="composer-actions-menu__item"
                        disabled={locked}
                        onClick={() => {
                          setShowOverflow(false);
                          setShowDeleteModal(true);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </ResponsiveDialogSurface>
                )}
              </>
            )}
            {/* archive#4521: the mobile footer above is this
                surface's save affordance below the mobile breakpoint — this
                header-row button rendering unconditionally there is what
                put two Save controls on screen at once. */}
            {!isAcp && !showPicker && !isMobile && (
              <button
                type="button"
                className="editor-btn editor-btn--primary agent-editor__save-btn"
                onClick={onSave}
                disabled={isSaving || locked || createBlocked}
              >
                {dirty && !isSaving && (
                  <span
                    className="agent-inline-editor__dirty-dot"
                    role="img"
                    aria-label="Unsaved changes"
                  />
                )}
                {isSaving
                  ? 'Saving…'
                  : isCreating
                    ? 'Create Agent'
                    : 'Save Changes'}
              </button>
            )}
          </DetailHeader>

          {error && (
            <div className="agent-editor__error-banner" role="alert">
              {error}
            </div>
          )}

          {createdNotice && (
            <div className="editor__lock-banner editor__lock-banner--info">
              <span>
                <InfoGlyph /> {createdNotice}
              </span>
            </div>
          )}

          {/*
            AC5. A create returns as soon as its write is durable, so opening
            the new Agent immediately can outrun its activation. That is a
            WAIT, not a failure — say so, rather than showing an empty tool
            list that reads as "this Agent has no tools". If activation never
            lands, the second banner stops implying it still might.
*/}
          {toolsActivating && (
            <div className="editor__lock-banner editor__lock-banner--info">
              <span>
                <InfoGlyph /> Finishing setup — this agent’s tools are still
                becoming available.
              </span>
            </div>
          )}
          {/*
            Activation was tried and abandoned. "Hasn't finished activating"
            was true for a while and then became a lie — this says what
            actually failed and offers the one action that can change it.
*/}
          {activationFailure ? (
            <div className="agent-editor__error-banner" role="alert">
              <strong>This agent couldn’t be activated.</strong>{' '}
              {activationFailure.reason} Everything here is saved and editable.
              <div className="agent-editor__state-actions">
                <button
                  type="button"
                  className="editor-btn"
                  onClick={onRetryActivation}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            toolsActivationTimedOut && (
              <div className="agent-editor__error-banner" role="alert">
                This agent hasn’t finished activating, so its tools couldn’t be
                loaded. Everything else here is saved and editable.
                <div className="agent-editor__state-actions">
                  <button
                    type="button"
                    className="editor-btn"
                    onClick={onRetryActivation}
                  >
                    Retry
                  </button>
                </div>
              </div>
            )
          )}

          {validationMessages.length > 0 && (
            <div className="agent-editor__error-banner" role="alert">
              <strong>Can’t save yet — please fix:</strong>
              <ul className="agent-editor__validation-summary">
                {validationMessages.map((msg) => (
                  <li key={msg}>{msg}</li>
                ))}
              </ul>
            </div>
          )}

          {isPlugin && locked && (
            <div className="editor__lock-banner">
              <span>
                <LockGlyph /> This agent is managed by a plugin. Edits will be
                overwritten on plugin updates.
              </span>
              <button
                type="button"
                className="editor__lock-btn"
                onClick={onUnlockPlugin}
              >
                Unlock
              </button>
            </div>
          )}

          {isAcp && (
            <div className="editor__lock-banner editor__lock-banner--info">
              <span>
                <InfoGlyph /> This agent is managed by its engine connection.
                Configuration is read-only.
              </span>
              {selectedAgent?.execution?.agentConnectionId && (
                <button
                  type="button"
                  className="editor__lock-btn"
                  onClick={onConfigureConnection}
                >
                  Configure in Connections
                </button>
              )}
            </div>
          )}

          {/*
            A persisted Agent that exists but cannot run right now. Its editor
            stays open — the user may well be here to fix it — but the state
            and its reason are stated, in the same words the New Chat picker
            and the list row use, with the one repair that addresses a
            connection-level cause.
*/}
          {notRunnable && !isCreating && (
            <div className="editor__lock-banner editor__lock-banner--info">
              <span>
                <InfoGlyph /> Not set up: {notRunnable.reason}
              </span>
              {notRunnable.enable ? (
                <button
                  type="button"
                  className="editor__lock-btn"
                  onClick={onEnable}
                  disabled={enableInFlight}
                >
                  {enableInFlight ? 'Setting up…' : 'Enable'}
                </button>
              ) : selectedAgent?.execution?.agentConnectionId ? (
                <button
                  type="button"
                  className="editor__lock-btn"
                  onClick={onConfigureConnection}
                >
                  Configure in Connections
                </button>
              ) : (
                // archive#4521 items 1/2: Station's own engine has no
                // `agentConnectionId` to point Connections at — this is the
                // "no enabled LLM provider connection is configured" case,
                // and the branch above rendered NOTHING for it (a reason
                // with no route). `fixRoute` reads the SAME server-derived
                // `unavailableFix.kind` the list row and New Chat picker's
                // repair verb come from (`agentFixRoute`), so this button
                // and the Model section's own "Add model connection"
                // banner further down this same page (which this navigates
                // to) can never disagree about the remedy.
                fixRoute === 'models' &&
                selectedAgent && (
                  <button
                    type="button"
                    className="editor__lock-btn"
                    onClick={() => onFixAgent(selectedAgent, 'models')}
                  >
                    Add model connection
                  </button>
                )
              )}
            </div>
          )}

          <div className="agent-inline-editor__body">
            {showStartingPoints ? (
              <AgentEditorStartingPoints
                onStartModel={onStartWithModel}
                onStartCli={onStartWithCli}
                onCopy={() => onCopyPicking(true)}
                copyDisabled={agents.length === 0}
              />
            ) : showCopyPicker ? (
              <AgentEditorCopySourcePicker
                agents={agents}
                onPick={onCopyAgent}
                onBack={() => onCopyPicking(false)}
                onFix={onFixAgent}
              />
            ) : (
              <AgentEditorForm
                form={form}
                setForm={setForm}
                engineKind={engineKind}
                onEngineKindChange={onEngineKindChange}
                stationConnectionId={stationConnectionId}
                isCreating={isCreating}
                locked={locked}
                isPlugin={isPlugin}
                isLocked={isLocked}
                validationErrors={validationErrors}
                promptIsRequired={promptIsRequired}
                availableTools={availableTools}
                availableSkills={availableSkills}
                integrationTools={integrationTools}
                appConfig={appConfig}
                enrich={enrich}
                isEnriching={isEnriching}
                onNavigate={onNavigate}
                onOpenAddModal={(type) => setAddModalType(type)}
                agentConnections={agentConnections}
                authoredCommands={selectedAgent?.commands}
              />
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={!editorUnavailable && showDeleteModal}
        title="Delete Agent"
        message={`Are you sure you want to delete "${form.name || selectedSlug}"? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={onDelete}
        onCancel={() => setShowDeleteModal(false)}
        variant="danger"
      />

      {!editorUnavailable && addModalType && (
        <AgentAddModal
          type={addModalType}
          availableTools={availableTools}
          availableSkills={availableSkills}
          form={form}
          setForm={setForm}
          onClose={() => setAddModalType(null)}
        />
      )}
    </>
  );
}
