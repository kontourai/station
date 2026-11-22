import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useActiveStationName } from '../../hooks/useActiveStationName';
import { useNewProjectFormSubmit } from '../../hooks/useNewProjectFormSubmit';
import type { useNewProjectModalState } from '../../hooks/useNewProjectModalState';
import { hasLocalStationForProfile } from '../../platform/client-origin-surface';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { Button } from '../Button';
import { useDialogHistoryHost } from '../DialogHistoryHost';
import { registerDialogHistory } from '../dialog-history';
import { FolderGlyph, PlusGlyph } from '../icons/Glyph';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import {
  NewProjectDescriptionField,
  NewProjectDirectoryField,
  NewProjectEnvironmentPicker,
  NewProjectIdentityField,
} from './NewProjectFormFields';
import { NewProjectLayoutBrowserBody } from './NewProjectLayoutBrowser';
import { NewProjectRepositorySource } from './NewProjectRepositorySource';
import { NewProjectStarterPicker } from './NewProjectStarterPicker';
import { normalizeWorkingDirectory } from './project-form-utils';

type NewProjectModalState = ReturnType<typeof useNewProjectModalState>;

function NewProjectModalHeader({
  onClose,
  headingRef,
}: {
  onClose: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className="new-project-modal__header">
      <div>
        <h3
          ref={headingRef}
          className="new-project-modal__title"
          id="new-project-modal-title"
          // Only actually receives focus when `NewProjectModalContent`'s own
          // effect imperatively moves it here on returning from the layout
          // browser (archive#1825 2) — never stolen on
          // the modal's genuine first open, which stays owned by
          // `ResponsiveDialogSurface`'s own initial-focus behavior.
          tabIndex={-1}
        >
          New Project
        </h3>
      </div>
      <ResponsiveDialogCloseButton
        onClick={onClose}
        label="Close new project"
      />
    </div>
  );
}

function NewProjectFormActions({
  canSubmit,
  hasCreatedProject,
  hasRecoveryIntent,
  openCreatedProject,
  selectForDraft,
  submitting,
  onClose,
}: {
  canSubmit: boolean;
  hasCreatedProject: boolean;
  hasRecoveryIntent: boolean;
  openCreatedProject: boolean;
  selectForDraft: boolean;
  submitting: boolean;
  onClose: () => void;
}) {
  return (
    <ResponsiveSurfaceActions className="new-project-modal__actions">
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      {/*
        SHELL-01: Create fired with no acknowledgement at all for the 6-8 s
        the POST took, which is what invited the double-submit the audit's
        first pass rendered as an error. The label swap was already here; the
        shared `Button`'s `pending` adds the spinner and the refusal, and
        makes this the same treatment every other async primary now uses
        rather than a per-dialog convention.
*/}
      <Button
        type="submit"
        variant="primary"
        pending={submitting}
        pendingLabel={
          openCreatedProject
            ? selectForDraft
              ? 'Selecting…'
              : 'Opening…'
            : hasCreatedProject
              ? 'Applying layout…'
              : 'Creating…'
        }
        disabled={!canSubmit}
      >
        {openCreatedProject
          ? selectForDraft
            ? 'Select Project'
            : 'Open Project'
          : hasCreatedProject
            ? 'Retry layout'
            : hasRecoveryIntent
              ? 'Continue creation'
              : 'Create'}
      </Button>
    </ResponsiveSurfaceActions>
  );
}

function NewProjectExistingFolder({ state }: { state: NewProjectModalState }) {
  const { draft, starter, submission } = state;
  const profile = usePlatformProfile();
  const stationName = useActiveStationName() ?? 'the connected Station';
  if (!hasLocalStationForProfile(profile)) return null;
  return (
    <details
      className="new-project-modal__options"
      open={Boolean(draft.directory && !draft.repositoryAcquisition)}
    >
      <summary>Use an existing folder</summary>
      <NewProjectDirectoryField
        directory={draft.directory}
        stationName={stationName}
        error={submission.directoryError}
        notice={submission.directoryNotice}
        onDirectoryChange={(directory) => {
          if (
            normalizeWorkingDirectory(directory) !== draft.normalizedDirectory
          ) {
            starter.resetForDirectory();
          }
          draft.setIcon('');
          draft.setIconDisabled(false);
          draft.setShowIconChoices(false);
          draft.setDirectory(directory);
          draft.setRepositoryAcquisition(null);
        }}
      />
    </details>
  );
}

function NewProjectIdentityInput({
  state,
  inputRef,
}: {
  state: NewProjectModalState;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { draft, iconCandidates, nameAdvisory, submission } = state;
  const profile = usePlatformProfile();
  const hostOwnedWorkspace = !hasLocalStationForProfile(profile);
  return (
    <NewProjectIdentityField
      inputRef={inputRef}
      candidates={iconCandidates.data ?? []}
      icon={draft.icon}
      iconDisabled={draft.iconDisabled}
      name={draft.name}
      derivedName={draft.derivedName}
      nameConflict={submission.slugError}
      nameAdvisory={
        submission.hasCreatedProject || submission.hasRecoveryIntent
          ? undefined
          : nameAdvisory
      }
      showIconChoices={draft.showIconChoices}
      iconCandidatesFetching={iconCandidates.isFetching}
      onIconChange={(icon, disabled) => {
        draft.setIcon(icon);
        draft.setIconDisabled(disabled === true);
      }}
      onNameChange={(name) => {
        draft.setNameTouched(true);
        draft.setName(name);
      }}
      onToggleIconChoices={() =>
        draft.setShowIconChoices(!draft.showIconChoices)
      }
      identityHint={
        hostOwnedWorkspace && draft.startIntent === 'workspace'
          ? 'Created on this Station. You pick the name; the host keeps the folder.'
          : undefined
      }
    />
  );
}

function NewProjectDetails({
  state,
  onAcquisitionBusy,
  nameRef,
}: {
  state: NewProjectModalState;
  onAcquisitionBusy: (busy: boolean) => void;
  nameRef: RefObject<HTMLInputElement | null>;
}) {
  const { draft, starter, submission } = state;
  const authority = useHostRequestAuthorityScope();
  const intentId = useId();
  const workspaceSelected = draft.startIntent === 'workspace';
  const intents = [
    {
      value: 'blank',
      title: 'Blank workspace',
      description: 'Start with an empty workspace on this Station.',
      Icon: PlusGlyph,
    },
    {
      value: 'workspace',
      title: 'From a repository',
      description: 'Acquire a Git checkout or use an existing folder.',
      Icon: FolderGlyph,
    },
  ] as const;
  const layoutPicker =
    workspaceSelected || draft.startIntent === 'blank' ? (
      <NewProjectStarterPicker
        codingStarter={starter.codingStarter}
        gitWorkspaceDetected={starter.gitWorkspaceDetected}
        recentLayouts={starter.recentLayouts}
        selectedLayoutId={starter.selectedLayoutId}
        onSelect={starter.selectLayout}
        onBrowse={() => starter.setShowLayoutBrowser(true)}
      />
    ) : null;
  return (
    <>
      <NewProjectIdentityInput state={state} inputRef={nameRef} />
      <fieldset className="new-project-modal__intents">
        <legend>Workspace</legend>
        <div className="new-project-modal__intent-grid">
          {intents.map(({ value, title, description, Icon }) => (
            <label key={value} className="new-project-modal__intent">
              <input
                type="radio"
                name={intentId}
                value={value}
                checked={workspaceSelected === (value === 'workspace')}
                onChange={() => {
                  draft.setStartIntent(value);
                  if (value === 'blank') {
                    if (draft.resolvedName) {
                      draft.setName(draft.resolvedName);
                      draft.setNameTouched(true);
                    }
                    draft.setDirectory('');
                    draft.setRepositoryAcquisition(null);
                    starter.resetForDirectory();
                    starter.selectLayout(null);
                  }
                }}
              />
              <Icon className="new-project-modal__intent-icon" />
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {workspaceSelected && (
        <>
          <NewProjectRepositorySource
            onBusyChange={onAcquisitionBusy}
            onUseCheckout={(path, name, acquisitionId) => {
              if (!authority?.isCurrent()) return;
              draft.setRepositoryAcquisition({
                id: acquisitionId,
                directory: path,
                recoveryKey: JSON.stringify([
                  authority.apiBase,
                  authority.draftRecoveryKey ?? authority.authorityKey,
                ]),
              });
              starter.resetForDirectory();
              draft.setDirectory(path);
              if (!draft.nameTouched) {
                draft.setName(name);
                draft.setNameTouched(true);
              }
            }}
          />
          <NewProjectExistingFolder state={state} />
        </>
      )}
      <details className="new-project-modal__options">
        <summary>More options</summary>
        <NewProjectDescriptionField
          description={draft.description}
          onChange={draft.setDescription}
        />
        <NewProjectEnvironmentPicker
          id="new-project-default-environment"
          value={draft.defaultEnvironment}
          onChange={draft.setDefaultEnvironment}
        />
        {!workspaceSelected && layoutPicker}
      </details>
      {workspaceSelected && layoutPicker}
      {submission.error && (
        <div className="new-project-modal__error">{submission.error}</div>
      )}
    </>
  );
}

function NewProjectForm({
  state,
  onClose,
  nameRef,
  hidden,
  selectForDraft,
}: {
  state: NewProjectModalState;
  onClose: () => void;
  nameRef: RefObject<HTMLInputElement | null>;
  hidden: boolean;
  selectForDraft: boolean;
}) {
  const { canSubmit, submit, sourceError } = useNewProjectFormSubmit(state);
  const [acquisitionBusy, setAcquisitionBusy] = useState(false);
  const needsCheckout =
    state.draft.startIntent === 'workspace' &&
    !state.draft.normalizedDirectory &&
    !state.submission.hasCreatedProject &&
    !state.submission.hasRecoveryIntent;

  return (
    <form
      className="new-project-modal__form"
      hidden={hidden}
      inert={hidden}
      style={hidden ? { display: 'none' } : undefined}
      onSubmit={(event) => {
        if (acquisitionBusy || needsCheckout) {
          event.preventDefault();
          return;
        }
        submit(event);
      }}
    >
      <div className="new-project-modal__draft-scroll">
        <fieldset
          className="new-project-modal__draft-fields"
          disabled={
            state.submission.hasCreatedProject ||
            state.submission.hasRecoveryIntent
          }
        >
          <NewProjectDetails
            nameRef={nameRef}
            state={state}
            onAcquisitionBusy={setAcquisitionBusy}
          />
        </fieldset>
        {sourceError && <p role="alert">{sourceError}</p>}
        {state.submission.hasRecoveryIntent && (
          <div className="new-project-modal__recovery">
            <p role={state.submission.recovery.corrupt ? 'alert' : 'status'}>
              {state.submission.recovery.corrupt
                ? 'The saved Project setup could not be read.'
                : `Saved setup: ${state.submission.recovery.pending?.draft.name}. Station checks the same request before continuing.`}
            </p>
            {state.submission.recovery.pending && (
              <p>
                Starter:{' '}
                {state.submission.recovery.pending.starterLayoutId
                  ? (state.starter.eligibleLayouts.find(
                      (layout) =>
                        layout.id ===
                        state.submission.recovery.pending?.starterLayoutId,
                    )?.name ?? 'Selected starter unavailable')
                  : 'No starter layout'}
              </p>
            )}
            {state.submission.recovery.statusMessage && (
              <p role="status">{state.submission.recovery.statusMessage}</p>
            )}
            {state.submission.recovery.pending && (
              <Button
                type="button"
                variant="secondary"
                disabled={
                  state.submission.recoveryBusy || state.submission.submitting
                }
                onClick={() =>
                  void state.submission.recovery.operation.refetch()
                }
              >
                Check setup
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={state.submission.submitting}
              onClick={state.submission.setAsideRecovery}
            >
              Set aside this setup
            </Button>
            <p className="editor-hint">
              Anything already created, such as the Project or checkout, is
              kept.
            </p>
          </div>
        )}

        {state.submission.hasCreatedProject && (
          <p className="new-project-modal__recovery" role="status">
            {state.submission.canOpenCreatedProject
              ? selectForDraft
                ? 'Project created. Select it for this draft.'
                : 'Project created. Continue to open it.'
              : 'Project created. Retry the selected starter layout to finish setup.'}
          </p>
        )}
      </div>
      <NewProjectFormActions
        canSubmit={canSubmit && !acquisitionBusy && !needsCheckout}
        hasCreatedProject={state.submission.hasCreatedProject}
        hasRecoveryIntent={state.submission.hasRecoveryIntent}
        openCreatedProject={state.submission.canOpenCreatedProject}
        selectForDraft={selectForDraft}
        submitting={state.submission.submitting}
        onClose={onClose}
      />
    </form>
  );
}

export function NewProjectModalContent({
  state,
  onClose,
  historyMode,
  returnFocusTarget,
}: {
  state: NewProjectModalState;
  onClose: () => void;
  historyMode: 'route' | 'entry';
  returnFocusTarget?: HTMLElement | null;
}) {
  const { starter } = state;
  const browsingLayouts = starter.showLayoutBrowser;
  const returnToForm = () => starter.setShowLayoutBrowser(false);

  const browseHistoryId = useId();
  const browseHistoryHost = useDialogHistoryHost();
  // Back from the layout browser returns to the form before the enclosing
  // route or inline dialog handles its own Back entry.
  useEffect(() => {
    if (!browsingLayouts) return;
    return registerDialogHistory(
      browseHistoryId,
      () => starter.setShowLayoutBrowser(false),
      browseHistoryHost,
    );
  }, [
    browseHistoryHost,
    browseHistoryId,
    browsingLayouts,
    starter.setShowLayoutBrowser,
  ]);

  // Escape, a backdrop tap, and the header's own close button all funnel
  // through `ResponsiveDialogSurface`'s single `onClose` prop. While
  // browsing, all three must behave like "Back to project" — return to the
  // draft — rather than discard it and exit the whole flow; only the draft
  // step itself can actually close the modal. This mirrors the old nested
  // dialog, whose own close button was already scoped "Close layout
  // browser", never "Close new project".
  const dismiss = browsingLayouts ? returnToForm : onClose;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const wasBrowsingRef = useRef(false);
  // The frame stays mounted during layout browsing; returning must restore an
  // announced target inside its focus trap (archive#1825).
  useEffect(() => {
    if (wasBrowsingRef.current && !browsingLayouts) {
      headingRef.current?.focus();
    }
    wasBrowsingRef.current = browsingLayouts;
  }, [browsingLayouts]);

  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={dismiss}
      historyMode={historyMode}
      returnFocusTarget={returnFocusTarget}
      initialFocusRef={nameRef}
      initialFocusPolicy="desktop"
      ariaLabelledBy={
        browsingLayouts
          ? 'new-project-layout-browser-title'
          : 'new-project-modal-title'
      }
      overlayClassName="new-project-modal__overlay"
      panelClassName="new-project-modal"
    >
      {!browsingLayouts && (
        <NewProjectModalHeader onClose={onClose} headingRef={headingRef} />
      )}
      <NewProjectForm
        state={state}
        onClose={onClose}
        nameRef={nameRef}
        hidden={browsingLayouts}
        selectForDraft={historyMode === 'entry'}
      />
      {browsingLayouts && (
        <NewProjectLayoutBrowserBody
          available={starter.eligibleLayouts}
          loading={starter.layoutsLoading}
          catalogError={starter.layoutError}
          selectedId={starter.selectedLayoutId}
          onRetry={() => void starter.refetchLayouts()}
          onSelect={(layoutId) => {
            starter.selectLayout(layoutId);
            returnToForm();
          }}
          onBack={returnToForm}
        />
      )}
    </ResponsiveDialogSurface>
  );
}
