import type { RefObject } from 'react';
import type { ACPConnectionRegistryEntry } from '../../hooks/useACPConnections';
import { resolveProviderChoicePresentation } from '../../views/provider-settings/providerCatalog';
import {
  ResponsiveDialogCloseButton,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import type { ACPConnectionDraft } from './types';
import type {
  ACPConnectionSetupErrorKind,
  ACPConnectionSetupStage,
} from './useACPConnectionSetup';

export function ACPConnectionSetupHeader({
  stage,
  onClose,
}: {
  stage: ACPConnectionSetupStage;
  onClose: () => void;
}) {
  const custom = stage === 'custom';
  const subtitle =
    stage === 'confirm'
      ? 'Review what connecting this engine changes.'
      : stage === 'checking'
        ? 'Station is checking this engine now.'
        : stage === 'result'
          ? 'Here is the current readiness result.'
          : stage === 'error'
            ? 'Your setup is still here. Try again or edit it.'
            : 'Choose an engine to set up, or enter a custom command.';
  return (
    <div className="acp-add-dialog__header">
      <div>
        <h3 id="add-provider-title">
          {custom ? 'Custom engine' : 'Add engine'}
        </h3>
        <p className="acp-add-dialog__subtitle">{subtitle}</p>
      </div>
      <ResponsiveDialogCloseButton label="Close add engine" onClick={onClose} />
    </div>
  );
}

export function ACPConnectionSetupActions({
  stage,
  hasRegistryEntries,
  isCustom,
  canSubmit,
  ready,
  errorKind,
  confirmLabel,
  onCatalog,
  onCustom,
  onConfirm,
  onRetryMutation,
  onSubmit,
  onRetryRefresh,
  onClose,
}: {
  stage: ACPConnectionSetupStage;
  hasRegistryEntries: boolean;
  isCustom: boolean;
  canSubmit: boolean;
  ready: boolean;
  errorKind: ACPConnectionSetupErrorKind | null;
  confirmLabel: string;
  onCatalog: () => void;
  onCustom: () => void;
  onConfirm: () => void;
  onRetryMutation: () => void;
  onSubmit: () => void;
  onRetryRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <ResponsiveSurfaceActions className="acp-add-dialog__actions">
      <ACPConnectionSetupEntryActions
        stage={stage}
        hasRegistryEntries={hasRegistryEntries}
        canSubmit={canSubmit}
        confirmLabel={confirmLabel}
        onCatalog={onCatalog}
        onConfirm={onConfirm}
        onSubmit={onSubmit}
        onClose={onClose}
      />
      <ACPConnectionSetupCompletionActions
        stage={stage}
        isCustom={isCustom}
        ready={ready}
        errorKind={errorKind}
        onCatalog={onCatalog}
        onCustom={onCustom}
        onRetryMutation={onRetryMutation}
        onRetryRefresh={onRetryRefresh}
        onClose={onClose}
      />
    </ResponsiveSurfaceActions>
  );
}

function ACPConnectionSetupEntryActions({
  stage,
  hasRegistryEntries,
  canSubmit,
  confirmLabel,
  onCatalog,
  onConfirm,
  onSubmit,
  onClose,
}: {
  stage: ACPConnectionSetupStage;
  hasRegistryEntries: boolean;
  canSubmit: boolean;
  confirmLabel: string;
  onCatalog: () => void;
  onConfirm: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  if (stage !== 'custom' && stage !== 'catalog' && stage !== 'confirm') {
    return null;
  }
  return (
    <>
      {stage === 'confirm' && hasRegistryEntries && (
        <button
          type="button"
          className="button button--secondary"
          onClick={onCatalog}
        >
          Back
        </button>
      )}
      {stage === 'custom' && hasRegistryEntries && (
        <button
          type="button"
          className="button button--secondary"
          onClick={onCatalog}
        >
          Back
        </button>
      )}
      <button
        type="button"
        className="button button--secondary"
        onClick={onClose}
      >
        Cancel
      </button>
      {stage === 'custom' && (
        <button
          type="button"
          className="button button--primary"
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          Check engine
        </button>
      )}
      {stage === 'confirm' && (
        <button
          type="button"
          className="button button--primary"
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      )}
    </>
  );
}

function ACPConnectionSetupCompletionActions({
  stage,
  isCustom,
  ready,
  errorKind,
  onCatalog,
  onCustom,
  onRetryMutation,
  onRetryRefresh,
  onClose,
}: {
  stage: ACPConnectionSetupStage;
  isCustom: boolean;
  ready: boolean;
  errorKind: ACPConnectionSetupErrorKind | null;
  onCatalog: () => void;
  onCustom: () => void;
  onRetryMutation: () => void;
  onRetryRefresh: () => void;
  onClose: () => void;
}) {
  if (stage !== 'result' && stage !== 'error') return null;
  const edit = isCustom ? onCustom : onCatalog;
  return (
    <>
      {(stage === 'error' || !ready) && (
        <button
          type="button"
          className="button button--secondary"
          onClick={edit}
        >
          {isCustom ? 'Edit setup' : 'Choose another engine'}
        </button>
      )}
      {stage === 'error' && errorKind === 'mutation' && (
        <button
          type="button"
          className="button button--primary"
          onClick={onRetryMutation}
        >
          Try again
        </button>
      )}
      {stage === 'error' && errorKind === 'refresh' && (
        <button
          type="button"
          className="button button--primary"
          onClick={onRetryRefresh}
        >
          Retry refresh
        </button>
      )}
      <button
        type="button"
        className="button button--secondary"
        onClick={onClose}
      >
        Done
      </button>
    </>
  );
}

export function ACPConnectionCatalogStage({
  entries,
  onSelect,
  onCustom,
}: {
  entries: ACPConnectionRegistryEntry[];
  onSelect: (entry: ACPConnectionRegistryEntry) => void;
  onCustom: () => void;
}) {
  return (
    <div className="acp-add-dialog__catalog">
      {entries.map((entry) => {
        const presentation = resolveProviderChoicePresentation({
          id: entry.id,
          kind: 'command',
          type: 'acp',
          name: entry.name,
          enabled: true,
          status: 'unknown',
          setup: null,
          discovery: entry.detected ? 'detected-unconfigured' : undefined,
          description: entry.description,
          href: '',
        });
        return (
          <button
            key={entry.id}
            type="button"
            className="acp-add-dialog__choice"
            onClick={() => onSelect(entry)}
          >
            <span className="acp-add-dialog__choice-name">{entry.name}</span>
            <span className="acp-add-dialog__choice-detail">
              {presentation.detail}
            </span>
          </button>
        );
      })}
      {entries.length > 0 && <div className="acp-add-dialog__divider" />}
      <button
        type="button"
        className="acp-add-dialog__choice"
        onClick={onCustom}
      >
        <span className="acp-add-dialog__choice-name">Custom engine</span>
        <span className="acp-add-dialog__choice-detail">
          Enter a name and command first; optional details stay advanced.
        </span>
      </button>
    </div>
  );
}

/**
 * CI-R8 / RT-11 — what "Connect this provider" actually does, before it does
 * it: a persistent connection is written to this Station's config, and the
 * engine also gains an agent of its own (`materializeEngineAgent`), which the
 * old one-click path never mentioned anywhere.
 */
export function ACPConnectionConfirmStage({
  entry,
}: {
  entry: ACPConnectionRegistryEntry;
}) {
  return (
    <div className="acp-add-dialog__confirm">
      <p className="acp-add-dialog__confirm-lead">
        Connect <strong>{entry.name}</strong> to this Station?
      </p>
      <ul className="acp-add-dialog__confirm-list">
        <li>Saves a connection to {entry.name} on this computer.</li>
        <li>Adds an agent named {entry.name} to your Agents list.</li>
        <li>
          Runs <code>{entry.command}</code> to check whether it is ready.
        </li>
      </ul>
      <p className="acp-add-dialog__confirm-note">
        You can remove the connection and its agent at any time.
      </p>
    </div>
  );
}

export function ACPConnectionCustomStage({
  draft,
  advancedOpen,
  nameInputRef,
  onDraftChange,
  onAdvancedChange,
}: {
  draft: ACPConnectionDraft;
  advancedOpen: boolean;
  nameInputRef: RefObject<HTMLInputElement | null>;
  onDraftChange: (field: keyof ACPConnectionDraft, value: string) => void;
  onAdvancedChange: (open: boolean) => void;
}) {
  const input = (
    label: string,
    field: keyof ACPConnectionDraft,
    placeholder: string,
  ) => (
    <label>
      {label}
      <input
        value={draft[field]}
        onChange={(event) => onDraftChange(field, event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
  return (
    <div className="acp-add-dialog__form">
      <label>
        Name
        <input
          ref={nameInputRef}
          value={draft.name}
          onChange={(event) => onDraftChange('name', event.target.value)}
          placeholder="Gemini CLI"
        />
      </label>
      {input('Command', 'command', 'gemini')}
      <details
        className="acp-add-dialog__advanced"
        open={advancedOpen}
        onToggle={(event) => onAdvancedChange(event.currentTarget.open)}
      >
        <summary>Advanced</summary>
        {input('ID', 'id', 'gemini')}
        {input('Arguments', 'args', '--acp')}
        {input('Working directory', 'cwd', 'Defaults to your home directory')}
        {input('Icon', 'icon', 'Emoji or image URL')}
      </details>
    </div>
  );
}

export function ACPConnectionSetupStatus({
  stage,
  label,
  error,
  reason,
  pending,
}: {
  stage: ACPConnectionSetupStage;
  label?: string;
  error: string | null;
  /**
   * CI-R8: the probe's own most recent failure, when it has one. "This
   * provider needs more setup before it can run work" named nothing and both
   * buttons walked away from the problem; this is the observation that says
   * what actually happened.
   */
  reason?: { message: string; phase: string } | null;
  pending: boolean;
}) {
  if (stage === 'checking') {
    return (
      <div className="acp-add-dialog__result" role="status" aria-live="polite">
        <strong>Checking</strong>
        <span>
          {pending
            ? 'Adding the engine and checking its readiness.'
            : 'Waiting for the refreshed connection result.'}
        </span>
      </div>
    );
  }
  if (stage === 'result' && label) {
    const detail =
      label === 'Ready'
        ? 'This engine is ready to use.'
        : label === 'Setup needed'
          ? 'This engine needs more setup before it can run work.'
          : label === 'Off'
            ? 'This engine is configured but turned off.'
            : 'Station could not make this engine available.';
    return (
      <div className="acp-add-dialog__result" role="status" aria-live="polite">
        <strong>{label}</strong>
        <span>{detail}</span>
        {label !== 'Ready' && reason && (
          <>
            <span className="acp-add-dialog__result-reason">
              {`${reason.phase}: ${reason.message}`}
            </span>
            <span className="acp-add-dialog__result-action">
              {/*
                Derived from the phase the probe actually failed in, not
                guessed from the message: before `initialize` the command
                never ran, and after it the command is running and answering.
                Anything more specific would be a claim about a failure
                Station cannot classify.
*/}
              {reason.phase === 'spawn' ||
              reason.phase === 'workspace preparation'
                ? 'Station could not start this engine’s command. Install it and make it runnable on this computer, then check it again.'
                : 'The command started but did not finish connecting. Resolve what it reported above in the engine itself, then check it again.'}
            </span>
          </>
        )}
      </div>
    );
  }
  if (stage === 'error') {
    return (
      <div
        className="acp-add-dialog__result acp-add-dialog__result--error"
        role="alert"
      >
        <strong>Unavailable</strong>
        <span>{error}</span>
      </div>
    );
  }
  return null;
}
