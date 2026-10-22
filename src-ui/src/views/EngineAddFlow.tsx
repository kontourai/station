import { engineId as toEngineId } from '@kontourai/station-contracts/agent-identity';
import type { AgentConnectionView as AgentConnectionViewData } from '@kontourai/station-contracts/tool';
import { useSaveAgentConnectionMutation } from '@kontourai/station-sdk';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActionRow } from '../components/ActionRow';
import { ACPConnectionSetupPanel } from '../components/acp-connections/ACPConnectionSetupPanel';
import { ConnectionIcon } from '../components/acp-connections/ConnectionIcon';
import { useACPConnectionSetupOwner } from '../components/acp-connections/useACPConnectionSetupOwner';
import { useStartChatWithEngine } from '../components/acp-connections/useStartChatWithEngine';
import { Button } from '../components/Button';
import { DetailHeader } from '../components/DetailHeader';
import {
  PublicRegistryCatalogGroup,
  PublicRegistryFacts,
} from '../components/engine-install/PublicRegistry';
import { RegistryEntryInstallHint } from '../components/engine-install/RegistryEntryInstallHint';
import { registryEntryDiscovery } from '../components/engine-install/registryEntryDiscovery';
import { BrandIcon } from '../components/icons/BrandIcon';
import { Empty } from '../components/state';
import type {
  ACPConnectionInfo,
  ACPConnectionRegistryEntry,
} from '../hooks/useACPConnections';
import { connectionEngineId } from '../utils/execution';
import { resolveProviderPresentation } from './provider-settings/providerCatalog';
import './EngineAddFlow.css';

/** What a catalogue row opens. Every choice goes through its own confirm. */
export type EngineAddChoice =
  | { kind: 'native'; connection: AgentConnectionViewData }
  | { kind: 'command'; entry: ACPConnectionRegistryEntry }
  | { kind: 'custom' }
  /** A saved engine that never connected: check it again from its saved setup. */
  | { kind: 'recheck'; connection: ACPConnectionInfo; custom: boolean };

/**
 * A saved connection whose engine never registered (a failed first add).
 * Only a custom one's setup can be edited; a built-in one is checked again or
 * removed.
 */
export interface NotConnectedEngine {
  connection: ACPConnectionInfo;
  custom: boolean;
}

function nativePresentation(connection: AgentConnectionViewData) {
  return resolveProviderPresentation({
    id: connection.id,
    kind: 'agent',
    type: connection.type,
    name: connection.name,
    enabled: connection.enabled,
    status: connection.status,
    prerequisites: connection.prerequisites,
    readinessEvidence: connection.readinessEvidence,
    setup: connection.setup,
    description: connection.description,
    href: '',
  });
}

function commandPresentation(entry: ACPConnectionRegistryEntry) {
  return resolveProviderPresentation({
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
}

function CatalogRow({
  icon,
  name,
  tag,
  detail,
  children,
  action,
}: {
  icon?: ReactNode;
  name: string;
  tag: string;
  detail?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="engine-catalog__row">
      <div className="engine-catalog__identity">
        {icon}
        <div className="engine-catalog__info">
          <div className="engine-catalog__name">
            {name}
            <span className="plugins__cap plugins__cap--ref">{tag}</span>
          </div>
          {detail ? (
            <div className="engine-catalog__detail">{detail}</div>
          ) : null}
          {children}
        </div>
      </div>
      {action ? <div className="engine-catalog__action">{action}</div> : null}
    </li>
  );
}

/**
 * The Engines tab's one Add catalogue: saved engines that have not connected
 * yet, this Station's native engines, the built-in command engines and a
 * custom command. Choosing a row opens its setup in place (`EngineAddFlow`).
 * An engine that is not installed offers its install command and Check again,
 * not a connect action: connecting is offered once Station finds it, or
 * through Custom engine.
 */
function EngineAddCatalog({
  notConnected,
  connections,
  commandEntries,
  error,
  onChoose,
}: {
  notConnected: NotConnectedEngine[];
  connections: AgentConnectionViewData[];
  commandEntries: ACPConnectionRegistryEntry[];
  error?: string | null;
  onChoose: (choice: EngineAddChoice) => void;
}) {
  const stationEntries = commandEntries.filter(
    (entry) => entry.source !== 'registry',
  );
  const publicEntries = commandEntries.filter(
    (entry) => entry.source === 'registry',
  );
  const hasCatalogEntries = connections.length > 0 || commandEntries.length > 0;
  return (
    <div className="editor-layout engine-catalog">
      <DetailHeader
        title="Add engine"
        subtitle="Station checks local apps and commands before showing them as ready."
      />
      {error ? <div className="editor-error">{error}</div> : null}
      {!hasCatalogEntries && (
        <Empty
          variant="prominent"
          label="Every supported engine is already listed"
          description="Detected apps and commands that are ready appear in the main list automatically. Connect a custom command below, or install another supported app and reopen this catalog."
        />
      )}
      <ul className="engine-catalog__list" aria-label="Engines to add">
        {notConnected.map(({ connection, custom }) => (
          <CatalogRow
            key={`not-connected-${connection.id}`}
            icon={
              <ConnectionIcon
                icon={connection.icon}
                name={connection.name}
                id={connection.id}
                size={28}
              />
            }
            name={connection.name}
            tag="Not connected yet"
            detail={
              connection.lastError?.message ??
              'Saved, but Station has not connected to it yet.'
            }
            action={
              <Button
                aria-label={`Retry check ${connection.name}`}
                onClick={() =>
                  onChoose({ kind: 'recheck', connection, custom })
                }
              >
                Retry check
              </Button>
            }
          />
        ))}
        {connections.map((connection) => {
          const presentation = nativePresentation(connection);
          // The row still needing setup continues there, so the label says so.
          const addLabel =
            presentation.readiness === 'Ready' ||
            presentation.readiness === 'Found, not connected'
              ? 'Add'
              : 'Add and set up';
          return (
            <CatalogRow
              key={connection.id}
              icon={
                <BrandIcon
                  name={connection.name}
                  id={connection.id}
                  engineId={connectionEngineId(connection)}
                  size={28}
                />
              }
              name={connection.name}
              tag={presentation.readiness}
              detail={presentation.detail}
              action={
                <Button
                  aria-label={`${addLabel} ${connection.name}`}
                  onClick={() => onChoose({ kind: 'native', connection })}
                >
                  {addLabel}
                </Button>
              }
            />
          );
        })}
        {stationEntries.map((entry) => {
          const presentation = commandPresentation(entry);
          const notInstalled =
            registryEntryDiscovery(entry) === 'not-installed';
          return (
            <CatalogRow
              key={entry.id}
              icon={
                <BrandIcon
                  name={entry.name}
                  id={entry.id}
                  engineId={toEngineId(entry.id)}
                  size={28}
                />
              }
              name={entry.name}
              tag={presentation.readiness}
              detail={presentation.detail}
              action={
                notInstalled ? undefined : (
                  <Button
                    aria-label={`${presentation.actionLabel} ${entry.name}`}
                    onClick={() => onChoose({ kind: 'command', entry })}
                  >
                    {presentation.actionLabel}
                  </Button>
                )
              }
            >
              {entry.publicRegistry ? (
                <PublicRegistryFacts listing={entry.publicRegistry} />
              ) : null}
              <RegistryEntryInstallHint entry={entry} />
            </CatalogRow>
          );
        })}
        <CatalogRow
          name="Custom engine"
          tag="Your command"
          detail="Connect an engine that runs its own tools from a local command."
          action={
            <Button
              aria-label="Set up custom engine"
              onClick={() => onChoose({ kind: 'custom' })}
            >
              Set up
            </Button>
          }
        />
      </ul>
      <PublicRegistryCatalogGroup
        entries={publicEntries}
        onChoose={(entry) => onChoose({ kind: 'command', entry })}
      />
    </div>
  );
}

type NativeSetupStage = 'confirm' | 'checking' | 'result' | 'error';

/**
 * A native engine's setup: confirm, then turn it on (the same save the
 * engine's own page makes), then its readiness from the saved connection.
 */
function NativeEngineSetup({
  connection,
  onBack,
  onDone,
  onOpenEngine,
}: {
  connection: AgentConnectionViewData;
  onBack: () => void;
  onDone: () => void;
  onOpenEngine: (id: string) => void;
}) {
  const [stage, setStage] = useState<NativeSetupStage>('confirm');
  const [saved, setSaved] = useState<AgentConnectionViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startChat = useStartChatWithEngine();
  const save = useSaveAgentConnectionMutation({
    onSuccess: (result: AgentConnectionViewData) => {
      setSaved(result);
      setStage('result');
    },
    onError: (mutationError: Error) => {
      setError(mutationError.message);
      setStage('error');
    },
  });
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, []);
  const add = () => {
    setStage('checking');
    setError(null);
    save.mutate({ connection, isNew: false });
  };
  const presentation = saved ? nativePresentation(saved) : null;
  const ready = presentation?.readiness === 'Ready';
  const done = <Button onClick={onDone}>Done</Button>;
  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="engine-setup editor-layout"
      aria-label="Engine setup"
    >
      <DetailHeader
        title={`Add ${connection.name}`}
        subtitle={
          stage === 'confirm'
            ? 'Review what adding this engine changes.'
            : stage === 'checking'
              ? 'Station is checking this engine now.'
              : 'Here is the current readiness result.'
        }
      />
      <div className="agent-editor__section">
        {stage === 'confirm' && (
          <div className="acp-add-dialog__confirm">
            <p className="acp-add-dialog__confirm-lead">
              Add <strong>{connection.name}</strong> to this Station?
            </p>
            <ul className="acp-add-dialog__confirm-list">
              <li>
                Turns {connection.name} on for chats and agents on this Station.
              </li>
              <li>Checks whether it is ready to run work.</li>
            </ul>
            <p className="acp-add-dialog__confirm-note">
              You can reset it from its engine page at any time.
            </p>
          </div>
        )}
        {stage === 'checking' && (
          <div className="acp-add-dialog__result" role="status">
            <strong>Checking</strong>
            <span>Adding {connection.name} and checking its readiness.</span>
          </div>
        )}
        {stage === 'result' && presentation && (
          <div className="acp-add-dialog__result" role="status">
            <strong>{presentation.readiness}</strong>
            <span>
              {ready ? 'This engine is ready to use.' : presentation.detail}
            </span>
          </div>
        )}
        {stage === 'error' && (
          <div
            className="acp-add-dialog__result acp-add-dialog__result--error"
            role="alert"
          >
            <strong>Unavailable</strong>
            <span>{error}</span>
          </div>
        )}
        {startChat.notice ? (
          <p className="editor-help" role="status">
            {startChat.notice}
          </p>
        ) : null}
        <ActionRow
          className="engine-setup__actions"
          overflowLabel={`More actions for ${connection.name}`}
          secondary={
            stage === 'confirm' ? (
              <Button onClick={onBack}>Back</Button>
            ) : stage === 'checking' ? undefined : (
              done
            )
          }
          primary={
            stage === 'confirm' ? (
              <Button variant="primary" onClick={add}>
                {`Add ${connection.name}`}
              </Button>
            ) : stage === 'error' ? (
              <Button variant="primary" onClick={add}>
                Try again
              </Button>
            ) : stage === 'result' && ready && saved ? (
              <Button
                variant="primary"
                pending={startChat.pending}
                pendingLabel="Starting…"
                onClick={() => void startChat.start(saved.id, saved.name)}
              >
                {`Start a chat with ${saved.name}`}
              </Button>
            ) : stage === 'result' && saved ? (
              <Button variant="primary" onClick={() => onOpenEngine(saved.id)}>
                Finish setup
              </Button>
            ) : undefined
          }
        />
      </div>
    </section>
  );
}

/** A built-in or custom command engine's setup, in place. */
function CommandEngineSetup({
  choice,
  onBack,
  onDone,
}: {
  choice: Exclude<EngineAddChoice, { kind: 'native' }>;
  onBack: () => void;
  onDone: () => void;
}) {
  const owner = useACPConnectionSetupOwner();
  const startChat = useStartChatWithEngine();
  return (
    <>
      <ACPConnectionSetupPanel
        {...owner}
        entry={choice.kind === 'command' ? choice.entry : null}
        {...(choice.kind === 'recheck'
          ? {
              editConnection: choice.connection,
              recheck: true,
              editable: choice.custom,
            }
          : {})}
        onBack={onBack}
        onDone={onDone}
        onStartChat={(connection) =>
          void startChat.start(connection.id, connection.name)
        }
        startChatPending={startChat.pending}
      />
      {startChat.notice ? (
        <p className="editor-help engine-setup__notice" role="status">
          {startChat.notice}
        </p>
      ) : null}
    </>
  );
}

/**
 * Add engine, start to finish, inside the Engines detail pane: the catalogue,
 * then the chosen engine's confirm step, Checking and its result. Choosing
 * changes no route, so the list beside it stays put; a deep link
 * (`/connections/engines/new/<id>`) opens on that entry's confirm step.
 */
export function EngineAddFlow({
  initialChoiceId,
  notConnected,
  connections,
  commandEntries,
  onDone,
  onOpenEngine,
}: {
  initialChoiceId?: string;
  notConnected: NotConnectedEngine[];
  connections: AgentConnectionViewData[];
  commandEntries: ACPConnectionRegistryEntry[];
  onDone: () => void;
  onOpenEngine: (id: string) => void;
}) {
  const [choice, setChoice] = useState<EngineAddChoice | null>(null);
  const handledChoiceId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialChoiceId || handledChoiceId.current === initialChoiceId) return;
    const resolved: EngineAddChoice | null =
      initialChoiceId === 'custom'
        ? { kind: 'custom' }
        : (() => {
            const entry = commandEntries.find(
              (candidate) => candidate.id === initialChoiceId,
            );
            if (entry) return { kind: 'command', entry };
            const connection = connections.find(
              (candidate) => candidate.id === initialChoiceId,
            );
            return connection ? { kind: 'native', connection } : null;
          })();
    // The catalogue may not have answered yet; try again when it does.
    if (!resolved) return;
    handledChoiceId.current = initialChoiceId;
    setChoice(resolved);
  }, [initialChoiceId, commandEntries, connections]);

  const back = () => setChoice(null);
  if (!choice) {
    return (
      <EngineAddCatalog
        notConnected={notConnected}
        connections={connections}
        commandEntries={commandEntries}
        onChoose={setChoice}
      />
    );
  }
  if (choice.kind === 'native') {
    return (
      <NativeEngineSetup
        key={choice.connection.id}
        connection={choice.connection}
        onBack={back}
        onDone={onDone}
        onOpenEngine={onOpenEngine}
      />
    );
  }
  return (
    <CommandEngineSetup
      key={
        choice.kind === 'custom'
          ? 'custom'
          : choice.kind === 'command'
            ? choice.entry.id
            : `recheck-${choice.connection.id}`
      }
      choice={choice}
      onBack={back}
      onDone={onDone}
    />
  );
}
