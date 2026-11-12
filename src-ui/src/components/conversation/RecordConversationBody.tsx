import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { type ReactNode, type RefObject, useMemo, useRef } from 'react';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';
import { LazyBoundary } from '../LazyBoundary';
import { ErrorState, SkeletonBlock } from '../state';
import { ConversationComposer } from './ConversationComposer';
import {
  type ConversationConnection,
  ConversationConnectionProvider,
  useOptionalConversationConnection,
} from './ConversationConnectionContext';
import type {
  ConversationReaderProps,
  ConversationReaderState,
} from './ConversationReader';

const loadReader = () =>
  import('./ConversationReader').then((module) => ({
    default: module.ConversationReader,
  }));
const loadSessionReader = () =>
  import('./ConversationReader').then((module) => ({
    default: module.SessionConversationReader,
  }));

import { ConversationStopControl } from './ConversationStopControl';
import { useRecordConversationController } from './useRecordConversationController';
import './ConversationBody.css';

export interface RecordConversationBodyProps {
  density: 'record';
  connection?: ConversationConnection;
  session: OrchestrationSessionSummary;
  reader: Omit<ConversationReaderProps, 'session'>;
  source?: ConversationReaderState;
  beforeTranscript?: ReactNode;
  afterTranscript?: ReactNode;
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  /** External records submit only through their continuation action. */
  composer?: {
    input: string;
    onInputChange: (value: string) => void;
    disabled?: boolean;
    reason?: string;
    onSubmit?: () => Promise<void>;
    onSent?: (submitted: string) => void;
    textareaRef?: RefObject<HTMLTextAreaElement | null>;
    submitAction?: { label: string; placeholder: string };
  };
  readOnly?: boolean;
  answeringDeniedReason?: string;
  onChanged?: () => void;
}

export function RecordConversationBody(props: RecordConversationBodyProps) {
  const inherited = useOptionalConversationConnection();
  const connection = props.connection ?? inherited;
  if (!connection) throw new Error('A record requires its owning connection.');
  const value = useMemo(
    () => ({
      ...connection,
      record: {
        readOnly: props.readOnly === true,
        onAnswered: props.onChanged,
        answeringDeniedReason: props.answeringDeniedReason,
      },
    }),
    [connection, props.readOnly, props.onChanged, props.answeringDeniedReason],
  );
  return (
    <ConversationConnectionProvider value={value}>
      <RecordBody {...props} connection={value} />
    </ConversationConnectionProvider>
  );
}

function RecordBody(
  props: RecordConversationBodyProps & { connection: ConversationConnection },
) {
  const { session, reader, source, composer, readOnly, connection } = props;
  const ownScrollRef = useRef<HTMLDivElement>(null);
  const ownTextareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = props.scrollContainerRef ?? ownScrollRef;
  const canWrite =
    !readOnly &&
    !composer?.disabled &&
    !reader.isStreaming &&
    (!connection.station ||
      connection.station.capabilities.send.state === 'allowed');
  const {
    send,
    stop,
    pendingMessages,
    deliveryFor,
    blocked,
    outboxError,
    retryOutbox,
  } = useRecordConversationController({
    session,
    input: composer?.input ?? '',
    onInputChange: composer?.onInputChange ?? noop,
    onSent: composer?.onSent,
    onChanged: props.onChanged,
    writable: canWrite,
  });
  const failure =
    (blocked ? null : send.error) ??
    stop.error ??
    (!readOnly ? outboxError : null);
  const translated = failure
    ? describeStationFailure(failure, connection.station)
    : undefined;
  const readerProps = {
    ...reader,
    session,
    scrollContainerRef: scrollRef,
    pendingMessages,
  };
  const deliveryConnection = {
    ...connection,
    record: { ...connection.record!, deliveryFor },
  };
  const showStop =
    !readOnly &&
    reader.isStreaming &&
    (!connection.station ||
      connection.station.capabilities.stop.state === 'allowed');
  return (
    <ConversationConnectionProvider value={deliveryConnection}>
      <div
        className="conversation-body conversation-body--record"
        data-conversation-density="record"
      >
        <div
          className="conversation-body__scroll sessions-detail__scroll"
          ref={scrollRef}
        >
          {props.beforeTranscript}
          {failure && (
            <ErrorState
              variant="compact"
              title={translated?.title ?? 'Request failed'}
              description={translated?.body}
              action={
                <Button
                  onClick={() => {
                    if (outboxError) void retryOutbox();
                    else {
                      send.reset();
                      stop.reset();
                    }
                  }}
                >
                  {outboxError ? 'Retry' : 'Dismiss'}
                </Button>
              }
            />
          )}
          {source ? (
            <LazyBoundary
              load={loadReader}
              componentProps={{ ...readerProps, ...source }}
              pending={<SkeletonBlock label="Reading the conversation" />}
            />
          ) : (
            <LazyBoundary
              load={loadSessionReader}
              componentProps={readerProps}
              pending={<SkeletonBlock label="Reading the conversation" />}
            />
          )}
          {props.afterTranscript}
        </div>
        {composer && (
          <ConversationComposer
            sessionId={session.threadId}
            activeConversationId={session.conversationId}
            input={composer.input}
            submitAction={composer.submitAction}
            attachments={[]}
            textareaRef={composer.textareaRef ?? ownTextareaRef}
            disabled={
              composer.disabled === true ||
              send.isPending ||
              (!readOnly && (!canWrite || blocked))
            }
            allowDraftWhileDisabled={
              !composer.disabled &&
              (blocked || reader.isStreaming || send.isPending)
            }
            turnInFlight={showStop}
            stopPending={stop.isPending}
            sendBlockedReason={
              composer.reason ??
              (blocked
                ? 'Check or resolve the earlier message before sending.'
                : reader.isStreaming
                  ? 'You can reply when the current turn finishes.'
                  : undefined)
            }
            modelSupportsAttachments={false}
            fileAttachmentsSupported={false}
            // Record replies take no attachments: Paste image is not offered
            // and the paperclip has no reason to report.
            onAttachUnavailable={() => {}}
            fontSize={reader.fontSize ?? 14}
            dockHeight={700}
            canModelSelect={false}
            availableModels={[]}
            modelQuery={null}
            currentModel={session.model}
            modelSelectionReason="Open in chat to change the model."
            agentLabel={reader.agentLabel}
            commandQuery={null}
            slashCommands={[]}
            onInputChange={composer.onInputChange}
            onSend={
              composer.onSubmit ??
              (async () => {
                if (canWrite && !blocked) await send.mutateAsync().catch(noop);
              })
            }
            onCancel={() => {
              if (showStop) stop.mutate();
            }}
            onClearInput={() => composer.onInputChange('')}
            onRemoveAttachment={noop}
            onClearAttachments={noop}
            onModelSelect={noop}
            onModelReset={noop}
            onModelClose={noop}
            onModelOpen={noop}
            onModelRuntimeOptionChange={noop}
            onApprovalModeChange={noop}
            onCommandSelect={async () => {}}
            onCommandClose={noop}
            onHistoryUp={noop}
            onHistoryDown={noop}
            updateFromInput={noop}
            closeAll={noop}
          />
        )}
        {!composer && showStop && (
          <div className="chat-input">
            <ConversationStopControl
              onCancel={() => stop.mutate()}
              stopPending={stop.isPending}
            />
          </div>
        )}
      </div>
    </ConversationConnectionProvider>
  );
}

function noop() {}
