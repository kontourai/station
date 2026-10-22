import { Fragment, type RefObject } from 'react';
import type { ACPConnectionRegistryEntry } from '../../hooks/useACPConnections';
import { resolveProviderChoicePresentation } from '../../views/provider-settings/providerCatalog';
import { RegistryEntryInstallHint } from '../engine-install/RegistryEntryInstallHint';
import { registryEntryDiscovery } from '../engine-install/registryEntryDiscovery';
import {
  ResponsiveDialogCloseButton,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import type { ACPConnectionDraft } from './types';
import type {
  ACPConnectionSetupAttempt,
  ACPConnectionSetupErrorKind,
  ACPConnectionSetupStage,
} from './useACPConnectionSetup';

export function ACPConnectionSetupHeader({
  stage,
  editing = false,
  onClose,
}: {
  stage: ACPConnectionSetupStage;
  editing?: boolean;
  onClose: () => void;
}) {
  const custom = stage === 'custom';
  const subtitle =
    editing && stage === 'custom'
      ? "Change this engine's setup, then check it."
      : stage === 'confirm'
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
          {editing ? 'Edit engine' : custom ? 'Custom engine' : 'Add engine'}
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
  canRetryCheck,
  firstContact = false,
  errorKind,
  confirmLabel,
  onCatalog,
  onCustom,
  onConfirm,
  onRetryMutation,
  onRetryCheck,
  onSubmit,
  onRetryRefresh,
  onClose,
}: {
  stage: ACPConnectionSetupStage;
  hasRegistryEntries: boolean;
  isCustom: boolean;
  canSubmit: boolean;
  ready: boolean;
  /** The result failed its probe; re-running the add re-probes it. */
  canRetryCheck: boolean;
  /** The engine's first start continues on the server after closing. */
  firstContact?: boolean;
  errorKind: ACPConnectionSetupErrorKind | null;
  confirmLabel: string;
  onCatalog: () => void;
  onCustom: () => void;
  onConfirm: () => void;
  onRetryMutation: () => void;
  /** Retry check on a result; defaults to re-running the add. */
  onRetryCheck?: () => void;
  onSubmit: () => void;
  onRetryRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <ResponsiveSurfaceActions className="acp-add-dialog__actions">
      {stage === 'checking' && (
        // Closing does not cancel anything: the add's request finishes, and
        // a first start keeps running on the server while Station runs.
        <button
          type="button"
          className="button button--secondary"
          onClick={onClose}
        >
          {firstContact ? 'Keep checking in background' : 'Close'}
        </button>
      )}
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
        canRetryCheck={canRetryCheck}
        errorKind={errorKind}
        onCatalog={onCatalog}
        onCustom={onCustom}
        onRetryMutation={onRetryMutation}
        onRetryCheck={onRetryCheck ?? onRetryMutation}
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
  canRetryCheck,
  errorKind,
  onCatalog,
  onCustom,
  onRetryMutation,
  onRetryCheck,
  onRetryRefresh,
  onClose,
}: {
  stage: ACPConnectionSetupStage;
  isCustom: boolean;
  ready: boolean;
  canRetryCheck: boolean;
  errorKind: ACPConnectionSetupErrorKind | null;
  onCatalog: () => void;
  onCustom: () => void;
  onRetryMutation: () => void;
  onRetryCheck: () => void;
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
      {stage === 'result' && canRetryCheck && (
        <button
          type="button"
          className="button button--primary"
          onClick={onRetryCheck}
        >
          Retry check
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
          discovery: registryEntryDiscovery(entry),
          description: entry.description,
          href: '',
        });
        return (
          <Fragment key={entry.id}>
            <button
              type="button"
              className="acp-add-dialog__choice"
              onClick={() => onSelect(entry)}
            >
              <span className="acp-add-dialog__choice-name">{entry.name}</span>
              <span className="acp-add-dialog__choice-detail">
                {presentation.detail}
              </span>
            </button>
            <RegistryEntryInstallHint entry={entry} />
          </Fragment>
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
        <li>
          Saves a connection to {entry.name} on the computer Station runs on.
        </li>
        <li>
          Adds an agent named {entry.name} to your Agents list once the engine
          connects.
        </li>
        <li>
          Runs <code>{entry.command}</code> to check whether it is ready.
        </li>
      </ul>
      <p className="acp-add-dialog__confirm-note">
        You can remove the connection and its agent at any time.
      </p>
      <RegistryEntryInstallHint entry={entry} />
    </div>
  );
}

/**
 * A command with whitespace that does not look like a path is most often a
 * program plus its arguments typed into one field; a path to a program may
 * itself contain spaces.
 */
function commandHasArguments(command: string): boolean {
  const value = command.trim();
  return /\s/.test(value) && !/^([~/.]|[A-Za-z]:[\\/])/.test(value);
}

export function ACPConnectionCustomStage({
  draft,
  advancedOpen,
  nameInputRef,
  idLocked = false,
  onDraftChange,
  onAdvancedChange,
}: {
  draft: ACPConnectionDraft;
  advancedOpen: boolean;
  nameInputRef: RefObject<HTMLInputElement | null>;
  /** A saved connection's id cannot change (it names its engine). */
  idLocked?: boolean;
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
        disabled={field === 'id' && idLocked}
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
      {commandHasArguments(draft.command) && (
        <p className="acp-add-dialog__field-note">
          This looks like a program and its arguments. Put arguments in Advanced
          → Arguments and keep only the program here.
        </p>
      )}
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
  firstContact = false,
  attempt = 'add',
  engineName,
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
  /** The engine's first start is still running in the background. */
  firstContact?: boolean;
  /** A first add, a re-check, or a saved edit: they are said differently. */
  attempt?: ACPConnectionSetupAttempt;
  engineName?: string;
}) {
  const engine = engineName ?? 'this engine';
  if (stage === 'checking') {
    return (
      <div className="acp-add-dialog__result" role="status" aria-live="polite">
        <strong>Checking</strong>
        <span>
          {firstContact
            ? attempt === 'add'
              ? `Starting ${engine} for the first time. A first start can take up to a minute.`
              : `Starting ${engine}. A first start can take up to a minute.`
            : !pending
              ? 'Waiting for the refreshed connection result.'
              : attempt === 'recheck'
                ? `Checking ${engine} again.`
                : attempt === 'edit'
                  ? `Saving your changes and checking ${engine}.`
                  : 'Adding the engine and checking its readiness.'}
        </span>
      </div>
    );
  }
  if (stage === 'result' && label) {
    const detail =
      label === 'Ready'
        ? 'This engine is ready to use.'
        : label === 'Setup required'
          ? 'This engine needs more setup before it can run work — its Agent is added when it connects.'
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
              {reason.message}
            </span>
            {/*
              Derived from the phase the probe actually failed in, not guessed
              from the message. A command that never launched is reported by
              the server with its own remedy (acp-process.ts), so no second
              hint repeats it; after launch the command is running and
              answering, so the remedy lies in the engine.
            */}
            {reason.phase === 'workspace preparation' ? (
              <span className="acp-add-dialog__result-action">
                Station could not prepare a folder for this engine. Check its
                working directory under Advanced, then check it again.
              </span>
            ) : reason.phase !== 'spawn' ? (
              <span className="acp-add-dialog__result-action">
                The command started but did not finish connecting. Resolve what
                it reported above in the engine itself, then check it again.
              </span>
            ) : null}
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
