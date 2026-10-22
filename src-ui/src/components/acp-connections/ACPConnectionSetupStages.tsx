import type { ReactNode, RefObject } from 'react';
import type { ACPConnectionRegistryEntry } from '../../hooks/useACPConnections';
import { ActionRow, type OverflowAction } from '../ActionRow';
import { Button } from '../Button';
import { DetailHeader } from '../DetailHeader';
import {
  PublicRegistryFacts,
  publicRegistryCommandLine,
} from '../engine-install/PublicRegistry';
import { RegistryEntryInstallHint } from '../engine-install/RegistryEntryInstallHint';
import type { ACPConnectionDraft } from './types';
import type {
  ACPConnectionSetupAttempt,
  ACPConnectionSetupErrorKind,
  ACPConnectionSetupStage,
} from './useACPConnectionSetup';

export function ACPConnectionSetupHeader({
  stage,
  editing = false,
  engineName,
}: {
  stage: ACPConnectionSetupStage;
  editing?: boolean;
  /** The catalogue choice being connected; absent for a custom engine. */
  engineName?: string;
}) {
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
              : 'Enter the command that starts your engine.';
  const title = editing
    ? 'Edit engine'
    : engineName
      ? `Connect ${engineName}`
      : 'Custom engine';
  return <DetailHeader title={title} subtitle={subtitle} />;
}

/** The two labelled actions and the overflow one setup stage offers. */
interface SetupActionSlots {
  primary?: ReactNode;
  secondary?: ReactNode;
  overflow?: OverflowAction[];
}

export interface ACPConnectionSetupActionProps {
  stage: ACPConnectionSetupStage;
  isCustom: boolean;
  canSubmit: boolean;
  /** False while the chosen engine is not installed: there is nothing to connect yet. */
  canConfirm: boolean;
  ready: boolean;
  /** The result failed its probe; re-running the add re-probes it. */
  canRetryCheck: boolean;
  /** The engine's first start continues on the server after closing. */
  firstContact?: boolean;
  errorKind: ACPConnectionSetupErrorKind | null;
  confirmLabel: string;
  engineName: string;
  /** Back to the catalogue. Absent where the flow was not opened from one. */
  onBack?: () => void;
  onConfirm: () => void;
  onSubmit: () => void;
  onRetryMutation: () => void;
  onRetryCheck: () => void;
  onRetryRefresh: () => void;
  onEditSetup: () => void;
  onDone: () => void;
  /** Ready: start a chat with this engine. Absent: only Done is offered. */
  onStartChat?: () => void;
  startChatPending?: boolean;
}

function action(label: string, onClick: () => void, primary = false) {
  return (
    <Button variant={primary ? 'primary' : 'secondary'} onClick={onClick}>
      {label}
    </Button>
  );
}

function entryActions(props: ACPConnectionSetupActionProps): SetupActionSlots {
  const leave = props.onBack
    ? action('Back', props.onBack)
    : action('Cancel', props.onDone);
  if (props.stage === 'custom') {
    return {
      secondary: leave,
      primary: (
        <Button
          variant="primary"
          disabled={!props.canSubmit}
          onClick={props.onSubmit}
        >
          Check engine
        </Button>
      ),
    };
  }
  return {
    secondary: leave,
    primary: props.canConfirm
      ? action(props.confirmLabel, props.onConfirm, true)
      : undefined,
  };
}

function readyActions(props: ACPConnectionSetupActionProps): SetupActionSlots {
  return {
    secondary: action('Done', props.onDone),
    primary: props.onStartChat ? (
      <Button
        variant="primary"
        pending={props.startChatPending}
        pendingLabel="Starting…"
        onClick={props.onStartChat}
      >
        {`Start a chat with ${props.engineName}`}
      </Button>
    ) : undefined,
  };
}

/**
 * A failed result or error: the repair is primary. A custom engine keeps
 * Edit setup beside it; a catalogue engine keeps Done, with choosing another
 * engine one step further in.
 */
function repairActions(props: ACPConnectionSetupActionProps): SetupActionSlots {
  const primary =
    props.stage === 'result'
      ? props.canRetryCheck
        ? action('Retry check', props.onRetryCheck, true)
        : undefined
      : props.errorKind === 'mutation'
        ? action('Try again', props.onRetryMutation, true)
        : props.errorKind === 'refresh'
          ? action('Retry refresh', props.onRetryRefresh, true)
          : undefined;
  const done: OverflowAction = {
    key: 'done',
    label: 'Done',
    onSelect: props.onDone,
  };
  if (props.isCustom) {
    return {
      primary,
      secondary: action('Edit setup', props.onEditSetup),
      overflow: [done],
    };
  }
  return {
    primary,
    secondary: action('Done', props.onDone),
    overflow: props.onBack
      ? [
          {
            key: 'another',
            label: 'Choose another engine',
            onSelect: props.onBack,
          },
        ]
      : [],
  };
}

function setupActionSlots(
  props: ACPConnectionSetupActionProps,
): SetupActionSlots {
  switch (props.stage) {
    case 'custom':
    case 'confirm':
      return entryActions(props);
    case 'checking':
      // Leaving does not cancel anything: the add's request finishes, and a
      // first start keeps running on the server while Station runs.
      return {
        secondary: action(
          props.firstContact ? 'Keep checking in background' : 'Close',
          props.onDone,
        ),
      };
    case 'result':
      return props.ready ? readyActions(props) : repairActions(props);
    case 'error':
      return repairActions(props);
  }
}

export function ACPConnectionSetupActions(
  props: ACPConnectionSetupActionProps,
) {
  const slots = setupActionSlots(props);
  return (
    <ActionRow
      className="engine-setup__actions"
      overflowLabel={`More actions for ${props.engineName}`}
      primary={slots.primary}
      secondary={slots.secondary}
      overflow={slots.overflow}
    />
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
  installed,
}: {
  entry: ACPConnectionRegistryEntry;
  /**
   * False when the host lookup did not find the engine: it is installed
   * first, and the connect step is offered once a re-check finds it.
   */
  installed: boolean;
}) {
  // A public listing is confirmed by its exact command line; the server
  // refuses the add when the listing no longer matches it.
  const listing =
    entry.source === 'registry' ? entry.publicRegistry : undefined;
  const launch = listing?.hostLaunch;
  if (!installed) {
    return (
      <div className="acp-add-dialog__confirm">
        <p className="acp-add-dialog__confirm-lead">
          <strong>{entry.name}</strong> is not installed on the computer Station
          runs on.
        </p>
        <p className="acp-add-dialog__confirm-note">
          Install it, then choose Check again. You can connect it once Station
          finds it.
        </p>
        <RegistryEntryInstallHint entry={entry} />
      </div>
    );
  }
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
          Runs{' '}
          <code>
            {launch ? publicRegistryCommandLine(launch) : entry.command}
          </code>{' '}
          to check whether it is ready.
        </li>
      </ul>
      {listing ? (
        <div className="acp-add-dialog__confirm-registry">
          <p>
            {entry.name} is listed in the public registry, not by Station.
            Station runs the copy of <code>{launch?.command}</code> it finds on
            the computer it runs on and does not download anything.
          </p>
          <PublicRegistryFacts listing={listing} />
          {listing.recommendedEnv ? (
            <p>
              The registry also recommends these settings, which Station does
              not apply:{' '}
              {Object.entries(listing.recommendedEnv)
                .map(([name, value]) => `${name}=${value}`)
                .join(', ')}
              .
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="acp-add-dialog__confirm-note">
        You can remove the connection and its agent at any time.
      </p>
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
  setupRequiredSlot,
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
  /**
   * Mount point beside a result that is not Ready (the engine sign-in lane
   * places its panel here). Rendered after the reason, inside the result.
   */
  setupRequiredSlot?: ReactNode;
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
        {label !== 'Ready' && setupRequiredSlot}
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
