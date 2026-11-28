import {
  CONVERSATION_IMPORT_DELETED_CODE,
  PEER_CONVERSATION_HANDOFF_ACCESS_CODE,
  PEER_CONVERSATION_HANDOFF_MAX_MESSAGES,
  PEER_CONVERSATION_HANDOFF_PAIRING_CODE,
  PEER_CONVERSATION_HANDOFF_REFUSAL_CODE,
  type PeerConversationHandoffReceiptV1,
} from '@kontourai/station-contracts/peer-chat';
import {
  useFeaturePreviewsQuery,
  useGitStatusQuery,
} from '@kontourai/station-sdk';
import {
  handoffConversationToStation,
  readConversationStationHandoffCapability,
} from '@kontourai/station-sdk/client';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { Field, Select } from '@kontourai/ui/react';
import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import type { StationConnection } from '../../connections/station-connection';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import type { PreparedOutgoingText } from '../../hooks/useChatInput';
import { useConversationStartTarget } from '../../hooks/useConversationStartTarget';
import {
  useExecutionStationCatalog,
  useExecutionStations,
} from '../../hooks/useExecutionStationCatalog';
import {
  type DraftQuote,
  draftQuoteKeys,
  parseDraftQuote,
} from '../../utils/answer-quotes';
import { userFacingErrorMessage } from '../../utils/errorText';
import type { SelectableModel } from '../../utils/modelCapabilities';
import { Button } from '../Button';
import { StartModelPicker } from '../chat-start/StartMenus';
import { DisclosureToggle } from '../DisclosureToggle';
import { ArrowDownGlyph } from '../icons/Glyph';
import { GLOBAL_CONTEXT } from '../modals/new-chat-modal-utils';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import { ErrorState, SkeletonBlock } from '../state';

/** What the dock needs to open the paired Station's new chat and send its first turn. */
export interface ContinuedOnStation {
  connection: StationConnection;
  receipt: PeerConversationHandoffReceiptV1;
  agentSlug: string;
  projectSlug?: string;
  projectName?: string;
  executionAgentId?: string;
  expectedDefinitionFingerprint?: string;
  modelId?: string;
  providerOptions?: Record<string, unknown>;
  message: string;
  /** The composer's draft became the first message: clear it and its quotes. */
  clearsComposer: boolean;
  sentQuotes: readonly DraftQuote[];
}

/**
 * A handoff to a paired Station that may have reached it. Kept until the
 * Station answers, so a reload offers the same key again: the paired Station
 * answers a repeated key with the conversation it already created.
 */
export interface PendingStationHandoff {
  idempotencyKey: string;
  environmentId: string;
  projectSlug?: string;
  executionAgentId?: string;
  expectedDefinitionFingerprint?: string;
  modelId?: string;
  message: string;
  /** The raw composer draft and quotes `message` was prepared from. */
  draft?: string;
  quotes?: DraftQuote[];
}

function stationStorageKey(apiBase: string, conversationId: string): string {
  return `station.conversation-handoff.station-pending.v1:${encodeURIComponent(apiBase)}:${conversationId}`;
}

export function readPendingStationHandoff(
  apiBase: string,
  conversationId: string,
): PendingStationHandoff | null {
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem(stationStorageKey(apiBase, conversationId)) ??
        'null',
    ) as Partial<PendingStationHandoff> | null;
    if (
      !parsed ||
      typeof parsed.idempotencyKey !== 'string' ||
      typeof parsed.environmentId !== 'string' ||
      typeof parsed.message !== 'string'
    )
      return null;
    const optional = (value: unknown) =>
      typeof value === 'string' && value ? value : undefined;
    return {
      idempotencyKey: parsed.idempotencyKey,
      environmentId: parsed.environmentId,
      message: parsed.message,
      projectSlug: optional(parsed.projectSlug),
      executionAgentId: optional(parsed.executionAgentId),
      expectedDefinitionFingerprint: optional(
        parsed.expectedDefinitionFingerprint,
      ),
      modelId: optional(parsed.modelId),
      ...(typeof parsed.draft === 'string' ? { draft: parsed.draft } : {}),
      ...(Array.isArray(parsed.quotes) &&
      parsed.quotes.every((quote) => parseDraftQuote(quote))
        ? { quotes: parsed.quotes as DraftQuote[] }
        : {}),
    };
  } catch {
    return null;
  }
}

function clearPendingStationHandoff(apiBase: string, conversationId: string) {
  try {
    sessionStorage.removeItem(stationStorageKey(apiBase, conversationId));
  } catch {
    // A cleanup refusal cannot overturn the paired Station's answer.
  }
}

/** Same rule as the Agent handoff: only Station's own non-indeterminate answer is definite. */
function isDefiniteFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { status, outcome, stationEnvelope } = error as {
    status?: unknown;
    outcome?: unknown;
    stationEnvelope?: unknown;
  };
  return (
    typeof status === 'number' &&
    outcome !== 'indeterminate' &&
    stationEnvelope !== false
  );
}

/** What stays behind on this machine: files never cross, so name what is not saved remotely. */
function leftBehind(
  status: ReturnType<typeof useGitStatusQuery>['data'],
): string | undefined {
  if (!status?.isRepo) return undefined;
  const uncommitted = status.staged + status.unstaged + status.untracked;
  const parts = [
    uncommitted > 0
      ? `${uncommitted} uncommitted change${uncommitted === 1 ? '' : 's'}`
      : undefined,
    status.ahead > 0
      ? `${status.ahead} unpushed commit${status.ahead === 1 ? '' : 's'} on ${status.branch}`
      : undefined,
  ].filter(Boolean);
  return parts.length
    ? `${parts.join(' and ')} stay on this machine. Commit and push first to use them there.`
    : undefined;
}

/**
 * The paired-Station half of "Continue with…": the same Agent, a verified
 * engine on that Station, and one of that Station's own Projects. The chat's
 * text history is carried; files are not.
 */
export function ConversationStationHandoff({
  apiBase,
  conversationId,
  agent,
  environmentId,
  sourceProject,
  message,
  draft,
  composerText,
  composerQuotes,
  prepareDraft,
  catchUpMessage,
  blockedReason,
  restored,
  onContinued,
}: {
  apiBase: string;
  conversationId: string;
  agent: AgentData;
  environmentId: string;
  sourceProject?: ProjectMetadata;
  /** The first turn on the paired Station (the draft or the catch-up request). */
  message: string;
  draft: boolean;
  /** The composer's raw draft and quotes, to tell whether a retried request still owns them. */
  composerText: string;
  composerQuotes: readonly DraftQuote[];
  /**
   * The composer's send preparation (mentions, quotes, size checks), run as
   * the Agent handoff runs it so a draft leaves the same way. Absent for a
   * retained request, which is resent exactly as it was.
   */
  prepareDraft?: () => Promise<
    PreparedOutgoingText | { refused: string } | null
  >;
  catchUpMessage: string;
  blockedReason?: string;
  restored: PendingStationHandoff | null;
  onContinued: (result: ContinuedOnStation) => void;
}) {
  const fieldId = useId();
  const target = useConversationStartTarget(environmentId, true);
  const catalog = useExecutionStationCatalog(agent, environmentId, false);
  const gitStatus = useGitStatusQuery(
    sourceProject?.workingDirectory
      ? {
          projectSlug: sourceProject.slug,
          workingDir: sourceProject.workingDirectory,
        }
      : null,
  );
  const retained = useRef<PendingStationHandoff | null>(
    restored?.environmentId === environmentId ? restored : null,
  );
  const idempotencyKey = useRef(
    retained.current?.idempotencyKey ?? randomCorrelationId(),
  );
  const [state, setState] = useState<
    'idle' | 'pending' | 'indeterminate' | 'error'
  >(retained.current ? 'indeterminate' : 'idle');
  const [feedback, setFeedback] = useState<string | undefined>(
    retained.current
      ? "The last handoff wasn't confirmed. Retrying won't create a second chat."
      : undefined,
  );
  const [modelId, setModelId] = useState<string | undefined>(
    retained.current?.modelId,
  );
  const [modelOptions, setModelOptions] = useState<Record<string, unknown>>({});
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const locked = state === 'pending' || state === 'indeterminate';
  // A retained request resends exactly what it asked for.
  const projectSlug = retained.current
    ? retained.current.projectSlug
    : target.context && target.context !== GLOBAL_CONTEXT
      ? target.context
      : undefined;
  const available = catalog.models.filter((model) => model.available !== false);
  const model: SelectableModel | undefined =
    available.find((entry) => entry.id === modelId) ??
    (retained.current ? undefined : available[0]);
  const executionAgentId =
    retained.current?.executionAgentId ?? model?.executionAgentId;
  const stationName = catalog.stationName;
  const notice = leftBehind(gitStatus.data);
  const reason =
    blockedReason ??
    (target.connectionError
      ? `Couldn't connect to ${stationName}.`
      : catalog.unmatched
        ? `${stationName} doesn't have this Agent. Add the same Agent there first.`
        : !catalog.loading &&
            catalog.models.length > 0 &&
            available.length === 0
          ? `No engine on ${stationName} can run this Agent now.`
          : undefined);
  const ready = Boolean(
    target.connection &&
      target.connection.capabilities.startChat.state === 'allowed' &&
      target.projects.isSuccess &&
      executionAgentId &&
      !reason,
  );

  // One start at a time: a second click while the draft is being prepared
  // must not prepare, send or open the chat twice (the Agent path's rule).
  const starting = useRef(false);
  const run = async () => {
    if (!ready || !target.connection || state === 'pending' || starting.current)
      return;
    starting.current = true;
    try {
      await start(target.connection);
    } finally {
      starting.current = false;
    }
  };
  const start = async (connection: StationConnection) => {
    setState('pending');
    setFeedback(undefined);
    let firstMessage = message;
    let firstDraft: string | undefined;
    let sentQuotes: readonly DraftQuote[] = [];
    let clearsComposer = false;
    const earlier = retained.current;
    if (earlier) {
      // A retry resends the request exactly; it clears the composer only if
      // the composer still holds the draft and quotes it was prepared from.
      sentQuotes = earlier.quotes ?? [];
      clearsComposer =
        earlier.draft !== undefined &&
        composerText.trim() === earlier.draft.trim() &&
        draftQuoteKeys(composerQuotes) === draftQuoteKeys(sentQuotes);
    } else if (draft && prepareDraft) {
      let prepared: Awaited<ReturnType<typeof prepareDraft>>;
      try {
        prepared = await prepareDraft();
      } catch {
        // Nothing was sent and the draft stays in the composer.
        setState('error');
        setFeedback(
          "Your draft couldn't be prepared, so nothing was sent. Try again.",
        );
        return;
      }
      if (!prepared || 'refused' in prepared) {
        setState('error');
        setFeedback(
          prepared
            ? prepared.refused
            : 'Your draft changed while it was being prepared. Try again.',
        );
        return;
      }
      firstMessage = prepared.text.trim() || catchUpMessage;
      firstDraft = prepared.draft;
      sentQuotes = prepared.quotes;
      clearsComposer = true;
    }
    const intent: PendingStationHandoff = earlier ?? {
      idempotencyKey: idempotencyKey.current,
      environmentId,
      message: firstMessage,
      ...(firstDraft !== undefined ? { draft: firstDraft } : {}),
      ...(sentQuotes.length > 0 ? { quotes: [...sentQuotes] } : {}),
      ...(projectSlug ? { projectSlug } : {}),
      ...(executionAgentId ? { executionAgentId } : {}),
      ...(model?.expectedDefinitionFingerprint
        ? { expectedDefinitionFingerprint: model.expectedDefinitionFingerprint }
        : {}),
      ...(model?.id ? { modelId: model.id } : {}),
    };
    try {
      sessionStorage.setItem(
        stationStorageKey(apiBase, conversationId),
        JSON.stringify(intent),
      );
    } catch {
      setState('error');
      setFeedback(
        "This browser blocks session storage, so a retry isn't safe. Enable it and try again.",
      );
      return;
    }
    retained.current = intent;
    try {
      const receipt = await handoffConversationToStation(
        apiBase,
        environmentId,
        {
          idempotencyKey: intent.idempotencyKey,
          conversationId,
          targetAgent: agent.slug,
          ...(intent.projectSlug ? { projectSlug: intent.projectSlug } : {}),
        },
      );
      if (!connection.isCurrent()) {
        // The chat exists there; only this connection to it changed.
        setState('indeterminate');
        setFeedback(
          `Reconnect to ${stationName}, then retry to open the chat.`,
        );
        return;
      }
      clearPendingStationHandoff(apiBase, conversationId);
      retained.current = null;
      onContinued({
        connection,
        receipt,
        agentSlug: agent.slug,
        ...(intent.projectSlug
          ? {
              projectSlug: intent.projectSlug,
              projectName: target.projects.data?.find(
                (project) => project.slug === intent.projectSlug,
              )?.name,
            }
          : {}),
        ...(intent.executionAgentId
          ? { executionAgentId: intent.executionAgentId }
          : {}),
        ...(intent.expectedDefinitionFingerprint
          ? {
              expectedDefinitionFingerprint:
                intent.expectedDefinitionFingerprint,
            }
          : {}),
        ...(intent.modelId ? { modelId: intent.modelId } : {}),
        ...(Object.keys(modelOptions).length > 0
          ? { providerOptions: modelOptions }
          : {}),
        message: intent.message,
        clearsComposer,
        sentQuotes,
      });
    } catch (error) {
      if (isDefiniteFailure(error)) {
        clearPendingStationHandoff(apiBase, conversationId);
        retained.current = null;
        idempotencyKey.current = randomCorrelationId();
        setState('error');
        const code = (error as { code?: unknown }).code;
        setFeedback(
          code === CONVERSATION_IMPORT_DELETED_CODE
            ? `That chat was removed on ${stationName}. Try again to send a fresh copy.`
            : code === PEER_CONVERSATION_HANDOFF_PAIRING_CODE
              ? `${stationName} is connected with a device sign-in. Pair it as a Station from the Station menu to continue chats there.`
              : code === PEER_CONVERSATION_HANDOFF_ACCESS_CODE
                ? `${stationName} didn't let this Station continue chats there. Check the pairing's access in the Station menu.`
                : code === PEER_CONVERSATION_HANDOFF_REFUSAL_CODE
                  ? `${stationName} didn't take this chat. Check that it has this Agent and the chosen project.`
                  : userFacingErrorMessage(error),
        );
      } else {
        setState('indeterminate');
        setFeedback(
          `${stationName} didn't confirm the handoff. Retrying won't create a second chat.`,
        );
      }
    }
  };

  if (target.connectionError)
    return (
      <ErrorState
        variant="compact"
        title={`Couldn't connect to ${stationName}`}
        description="Check the pairing in the Station menu, then retry."
        action={<Button onClick={target.reconnect}>Retry</Button>}
      />
    );
  if (!target.connection || (catalog.loading && catalog.models.length === 0))
    return <SkeletonBlock label={`Reading ${stationName}`} />;

  const modelFieldId = `${fieldId}-model`;
  const modelValueId = `${fieldId}-model-value`;
  const disclosureId = `${fieldId}-carries`;
  const reasonId = `${fieldId}-reason`;
  return (
    <div className="conversation-handoff-dialog__confirmation">
      <p className="conversation-handoff-dialog__summary">
        Keep {agent.name} and continue this chat on {stationName}.
      </p>
      {catalog.models.length > 0 && (
        <div className="conversation-handoff-dialog__model">
          <span className="editor-label" id={modelFieldId}>
            Model
          </span>
          <Button
            ref={modelTriggerRef}
            className="choice-trigger"
            aria-labelledby={`${modelFieldId} ${modelValueId}`}
            aria-haspopup="dialog"
            aria-expanded={modelPickerOpen}
            disabled={locked}
            onClick={() => setModelPickerOpen(true)}
          >
            <span id={modelValueId}>{model?.name ?? 'Choose a model'}</span>
            <ArrowDownGlyph className="choice-caret" />
          </Button>
          {modelPickerOpen && (
            <StartModelPicker
              anchor={modelTriggerRef.current}
              layer="dialog"
              models={catalog.models}
              loading={catalog.loading}
              modelConnections={[]}
              choice={{
                modelId: model?.id,
                executionAgentId,
                providerOptions: modelOptions,
              }}
              onSelect={(choice) => {
                setModelId(choice.id);
                setModelOptions({});
                setModelPickerOpen(false);
              }}
              onReset={() => setModelPickerOpen(false)}
              onRuntimeOptionChange={() => {}}
              onClose={() => setModelPickerOpen(false)}
            />
          )}
        </div>
      )}
      <Field label={`Project on ${stationName}`} htmlFor={`${fieldId}-project`}>
        <Select
          id={`${fieldId}-project`}
          value={projectSlug ?? GLOBAL_CONTEXT}
          disabled={locked || !target.projects.isSuccess}
          onChange={(event) => target.choose(event.target.value)}
        >
          {target.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      {target.projects.isError && (
        <ErrorState
          variant="compact"
          title={`Couldn't list ${stationName}'s projects`}
          action={
            <Button onClick={() => void target.projects.refetch()}>
              Retry
            </Button>
          }
        />
      )}
      {notice && (
        <p role="status" className="conversation-handoff-dialog__precondition">
          {notice}
        </p>
      )}
      <div className="conversation-handoff-dialog__note">
        <span>
          {draft
            ? 'Your draft is sent as the first message.'
            : 'Starts with a short catch-up turn.'}
        </span>
        <DisclosureToggle
          expanded={disclosureOpen}
          onToggle={() => setDisclosureOpen((open) => !open)}
          controls={disclosureId}
        >
          Details
        </DisclosureToggle>
      </div>
      {disclosureOpen && (
        <dl
          id={disclosureId}
          className="conversation-handoff-dialog__disclosure"
        >
          <dt>First message</dt>
          <dd>{draft ? 'Your draft from the composer' : message}</dd>
          <dt>Keeps</dt>
          <dd>
            Message text as the Agent's context, newest first, up to{' '}
            {PEER_CONVERSATION_HANDOFF_MAX_MESSAGES} messages
          </dd>
          {/* A relayed chat reads events only; the carried rows live in that
              Station's own record, not in this tab. */}
          <dt>Shown there</dt>
          <dd>Messages from this handoff on</dd>
          <dt>Stays here</dt>
          <dd>Files · Tool output · Attachments · This chat</dd>
        </dl>
      )}
      {reason && (
        <p
          id={reasonId}
          role="status"
          className="conversation-handoff-dialog__precondition"
        >
          {reason}
        </p>
      )}
      {feedback && (
        <div role="alert" className="conversation-handoff-dialog__feedback">
          {feedback}
        </div>
      )}
      <ResponsiveSurfaceActions className="conversation-handoff-dialog__actions">
        <Button
          variant="primary"
          disabled={state === 'pending' || !ready}
          aria-describedby={reason ? reasonId : undefined}
          onClick={() => void run()}
        >
          {state === 'pending'
            ? 'Continuing…'
            : state === 'indeterminate'
              ? 'Retry safely'
              : `Continue on ${stationName}`}
        </Button>
      </ResponsiveSurfaceActions>
    </div>
  );
}

/**
 * Where the conversation continues: this Station or a paired one. Offered only
 * when the paired-chat preview is on, this Station advertises the handoff
 * route, and a paired Station is listed for this caller; otherwise it renders
 * nothing and the dialog stays the Agent handoff it was.
 */
export function ConversationStationChoice({
  apiBase,
  value,
  disabled,
  onChange,
}: {
  apiBase: string;
  value: string;
  disabled: boolean;
  onChange: (environmentId: string) => void;
}) {
  const previews = useFeaturePreviewsQuery();
  const previewOn =
    previews.data?.some(
      (preview) => preview.id === 'paired-station-chats' && preview.enabled,
    ) === true;
  const capability = useQuery({
    queryKey: ['conversation-station-handoff-capability', apiBase],
    enabled: previewOn,
    staleTime: 60_000,
    retry: false,
    queryFn: () => readConversationStationHandoffCapability(apiBase),
  });
  const { stations, settled } = useExecutionStations({ projectSelected: true });
  const paired = stations.filter((station) => station.kind === 'paired');
  if (!previewOn || capability.data !== true || !settled || paired.length === 0)
    return null;
  return (
    <div
      className="conversation-handoff-dialog__agents"
      role="radiogroup"
      aria-label="Station"
    >
      {[
        { id: 'current', name: 'This Station' } as {
          id: string;
          name: string;
          unavailableReason?: string;
        },
        ...paired,
      ].map((station) => (
        <label key={station.id} className="conversation-handoff-dialog__agent">
          <input
            type="radio"
            name="conversation-handoff-station"
            value={station.id}
            checked={station.id === value}
            // A paired Station that is not ready stays listed, greyed, with
            // why: a handoff to it could not reach it.
            disabled={disabled || Boolean(station.unavailableReason)}
            onChange={() => {
              if (!station.unavailableReason) onChange(station.id);
            }}
          />
          <span>{station.name}</span>
          {station.unavailableReason && (
            <small>{station.unavailableReason}</small>
          )}
        </label>
      ))}
    </div>
  );
}
