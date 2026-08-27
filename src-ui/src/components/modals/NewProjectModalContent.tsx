import { type RefObject, useEffect, useId, useRef } from 'react';
import { useNewProjectFormSubmit } from '../../hooks/useNewProjectFormSubmit';
import type { useNewProjectModalState } from '../../hooks/useNewProjectModalState';
import { Button } from '../Button';
import { registerDialogHistory } from '../dialog-history';
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
        <p className="new-project-modal__eyebrow">Project Setup</p>
        <h3
          ref={headingRef}
          className="new-project-modal__title"
          id="new-project-modal-title"
          // Only actually receives focus when `NewProjectModalContent`'s own
          // effect imperatively moves it here on returning from the layout
          // browser (station#1825 item 4 review round 2) — never stolen on
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
  submitting,
  onClose,
}: {
  canSubmit: boolean;
  hasCreatedProject: boolean;
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
        pendingLabel={hasCreatedProject ? 'Applying layout…' : 'Creating…'}
        disabled={!canSubmit}
      >
        {hasCreatedProject ? 'Retry layout' : 'Create'}
      </Button>
    </ResponsiveSurfaceActions>
  );
}

function NewProjectDirectoryInput({ state }: { state: NewProjectModalState }) {
  const { apiBase, draft, starter, submission } = state;
  return (
    <NewProjectDirectoryField
      apiBase={apiBase}
      directory={draft.directory}
      error={submission.directoryError}
      onDirectoryChange={(directory) => {
        if (
          normalizeWorkingDirectory(directory) !== draft.normalizedDirectory
        ) {
          starter.resetForDirectory();
        }
        draft.setIcon('');
        draft.setShowIconChoices(false);
        draft.setDirectory(directory);
      }}
    />
  );
}

function NewProjectIdentityInput({ state }: { state: NewProjectModalState }) {
  const { draft, iconCandidates, nameAdvisory, submission } = state;
  return (
    <NewProjectIdentityField
      candidates={iconCandidates.data ?? []}
      icon={draft.icon}
      name={draft.name}
      derivedName={draft.derivedName}
      nameConflict={submission.slugError}
      nameAdvisory={nameAdvisory}
      showIconChoices={draft.showIconChoices}
      iconCandidatesFetching={iconCandidates.isFetching}
      onIconChange={draft.setIcon}
      onNameChange={(name) => {
        draft.setNameTouched(true);
        draft.setName(name);
      }}
      onToggleIconChoices={() =>
        draft.setShowIconChoices(!draft.showIconChoices)
      }
    />
  );
}

function NewProjectDetails({ state }: { state: NewProjectModalState }) {
  const { draft, starter, submission } = state;
  return (
    <>
      <NewProjectDirectoryInput state={state} />
      <NewProjectIdentityInput state={state} />
      <NewProjectDescriptionField
        description={draft.description}
        onChange={draft.setDescription}
      />
      <NewProjectEnvironmentPicker
        id="new-project-default-environment"
        value={draft.defaultEnvironment}
        onChange={draft.setDefaultEnvironment}
      />
      <NewProjectStarterPicker
        codingStarter={starter.codingStarter}
        gitWorkspaceDetected={starter.gitWorkspaceDetected}
        recentLayouts={starter.recentLayouts}
        selectedLayoutId={starter.selectedLayoutId}
        onSelect={starter.selectLayout}
        onBrowse={() => starter.setShowLayoutBrowser(true)}
      />
      {submission.error && (
        <div className="new-project-modal__error">{submission.error}</div>
      )}
    </>
  );
}

function NewProjectForm({
  state,
  onClose,
}: {
  state: NewProjectModalState;
  onClose: () => void;
}) {
  const { canSubmit, submit } = useNewProjectFormSubmit(state);

  return (
    <form className="new-project-modal__form" onSubmit={submit}>
      <fieldset
        className="new-project-modal__draft-fields"
        disabled={state.submission.hasCreatedProject}
      >
        <NewProjectDetails state={state} />
      </fieldset>
      {state.submission.hasCreatedProject && (
        <p className="new-project-modal__recovery" role="status">
          Project created. Retry the selected starter layout to finish setup.
        </p>
      )}
      <NewProjectFormActions
        canSubmit={canSubmit}
        hasCreatedProject={state.submission.hasCreatedProject}
        submitting={state.submission.submitting}
        onClose={onClose}
      />
    </form>
  );
}

export function NewProjectModalContent({
  state,
  onClose,
}: {
  state: NewProjectModalState;
  onClose: () => void;
}) {
  const { starter } = state;
  const browsingLayouts = starter.showLayoutBrowser;
  const returnToForm = () => starter.setShowLayoutBrowser(false);

  const browseHistoryId = useId();
  // Hardware/browser Back while browsing must return to the draft form, not
  // exit the whole New Project flow (station#1825 item 4 review round 2).
  // The outer `ResponsiveDialogSurface` below intentionally does NOT push a
  // history layer of its own (`historyMode="route"`: the modal's overall
  // open/close is driven by the app's own `/projects/new` route, mounting
  // and unmounting `NewProjectModal` directly — see `AppViewContent.tsx`'s
  // `ProjectNewViewGate`), so without this, a Back press falls straight
  // through to that route level and discards the whole draft. The old
  // nested dialog got this for free from its own default `historyMode
  // ="entry"`; this recreates exactly that registration, scoped to the
  // browsing sub-state, using the same primitive.
  useEffect(() => {
    if (!browsingLayouts) return;
    return registerDialogHistory(browseHistoryId, () =>
      starter.setShowLayoutBrowser(false),
    );
  }, [browseHistoryId, browsingLayouts, starter.setShowLayoutBrowser]);

  // Escape, a backdrop tap, and the header's own close button all funnel
  // through `ResponsiveDialogSurface`'s single `onClose` prop. While
  // browsing, all three must behave like "Back to project" — return to the
  // draft — rather than discard it and exit the whole flow; only the draft
  // step itself can actually close the modal. This mirrors the old nested
  // dialog, whose own close button was already scoped "Close layout
  // browser", never "Close new project".
  const dismiss = browsingLayouts ? returnToForm : onClose;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const wasBrowsingRef = useRef(false);
  // Return-focus for the reverse transition (station#1825 item 4 review
  // round 2): `NewProjectLayoutBrowserBody` moves focus onto its own heading
  // when it mounts (forward). Coming back, the modal frame itself doesn't
  // remount (unlike the old nested dialog, which got a fresh focus trap for
  // free), so without this, focus falls to `document.body` — outside the
  // panel's own Tab-containment, which only intercepts keydowns targeted at
  // a descendant of the panel — and no announcement reaches screen readers
  // that the content changed back.
  //
  // Deliberately a passive `useEffect`, not `useLayoutEffect`: `NewProjectForm`
  // (mounted fresh on this same transition, as the ternary's other branch)
  // contains `PathAutocomplete`, which has its own pre-existing `autoFocus`
  // default — the same behavior the modal's genuine first open already
  // relies on — implemented as its own passive `useEffect` several levels
  // deeper in the tree. React flushes passive effects child-before-parent
  // within one commit, so a `useLayoutEffect` here (verified live in a real
  // browser) fires and is immediately overwritten by that deeper passive
  // effect afterward, leaving focus in the Working Directory field instead
  // of the heading. Matching the effect type puts this callback in the same
  // passive-effect phase, still ordered after PathAutocomplete's as the
  // shallower ancestor, so it reliably wins instead.
  useEffect(() => {
    if (wasBrowsingRef.current && !browsingLayouts) {
      headingRef.current?.focus();
    }
    wasBrowsingRef.current = browsingLayouts;
  }, [browsingLayouts]);

  return (
    <ResponsiveDialogSurface
      onClose={dismiss}
      historyMode="route"
      ariaLabelledBy={
        browsingLayouts
          ? 'new-project-layout-browser-title'
          : 'new-project-modal-title'
      }
      overlayClassName="new-project-modal__overlay"
      panelClassName="new-project-modal"
    >
      {browsingLayouts ? (
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
      ) : (
        <>
          <NewProjectModalHeader onClose={onClose} headingRef={headingRef} />
          <NewProjectForm state={state} onClose={onClose} />
        </>
      )}
    </ResponsiveDialogSurface>
  );
}
