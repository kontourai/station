import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  AttentionRequestReference,
  NeedsInputAttentionItem,
} from '@kontourai/station-contracts/attention';
import {
  ENGINE_CAPABILITY_MATRICES,
  resolveComposerImageSupport,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { isProvablyNotSent } from '@kontourai/station-sdk';
import {
  type ForegroundMessageInput,
  sendExecutionMessage,
} from '@kontourai/station-sdk/client';
import { getInputReplyContext } from '@kontourai/station-sdk/input-reply';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useModelImageSupport } from '../../contexts/ModelCapabilitiesContext';
import { useComposerAttachments } from '../../hooks/useComposerAttachments';
import { inlineComposerAttachments } from '../../lib/attachment-staging-queue';
import type {
  ComposerAttachmentStageSnapshot,
  FileAttachment,
} from '../../types';
import { ChatInputArea } from '../chat/ChatInputArea';
import { ConversationConnectionProvider } from '../conversation/ConversationConnectionContext';
import { ErrorState, SkeletonBlock } from '../state';
import './NeedsInputReply.css';
import { userFacingErrorMessage } from '../../utils/errorText';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';

type Scope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
export function NeedsInputReply({
  item,
  scope,
}: {
  item: NeedsInputAttentionItem & { inputReference: AttentionRequestReference };
  scope: Scope;
}) {
  const [reference] = useState(item.inputReference);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [stages, setStages] = useState<ComposerAttachmentStageSnapshot[]>([]);
  const [attempt, setAttempt] = useState<ForegroundMessageInput | null>(null);
  const [sent, setSent] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const client = useQueryClient();
  const changed =
    reference.threadId !== item.inputReference.threadId ||
    reference.requestId !== item.inputReference.requestId ||
    reference.requestEventId !== item.inputReference.requestEventId;
  const query = useQuery({
    queryKey: [
      'input-reply-context',
      scope.apiBase,
      scope.authorityKey,
      reference,
    ],
    queryFn: async ({ signal }) => {
      if (!scope.isCurrent()) throw new Error('Station access changed');
      const value = await getInputReplyContext(scope.apiBase, reference, {
        signal,
        requestScope: scope,
      });
      if (!scope.isCurrent()) throw new Error('Station access changed');
      return value;
    },
    enabled: scope.isCurrent() && !changed,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
  const context =
    scope.isCurrent() &&
    !changed &&
    !query.isError &&
    !query.isFetching &&
    query.data?.state === 'open'
      ? query.data
      : undefined;
  const modelSupport = useModelImageSupport(context?.modelId);
  const matrix =
    Object.values(ENGINE_CAPABILITY_MATRICES).find(
      (value) => value.engineId === context?.engineId,
    ) ?? UNKNOWN_EXTERNAL_ENGINE_MATRIX;
  const imageSupport = resolveComposerImageSupport(matrix, {
    connectionCapabilities: context?.capabilities ?? [],
    modelSupport,
  });
  const files = context?.capabilities.includes('file-input') ?? false;
  const composer = useComposerAttachments({
    apiBase: scope.apiBase,
    requestScope: scope,
    cancelOnUnmount: true,
    attachments,
    stages,
    capabilities: {
      images: imageSupport.attachable,
      files,
      imageRefusal: imageSupport.refusal,
    },
    onAddAttachments: (added) =>
      setAttachments((current) => [...current, ...added]),
    onReplaceAttachment: (replacement) =>
      setAttachments((current) =>
        current.map((file) =>
          file.id === replacement.id ? replacement : file,
        ),
      ),
    onStagesChange: setStages,
  });
  const mutation = useMutation({
    mutationFn: async (input: ForegroundMessageInput) => {
      if (!scope.isCurrent() || changed)
        throw new Error(
          'This request or your Station access changed. Open the chat before answering.',
        );
      return sendExecutionMessage(scope.apiBase, input, {
        requestScope: scope,
      });
    },
    onError: (error) => {
      if (
        scope.isCurrent() &&
        (isProvablyNotSent(error) ||
          describeStationFailure(error).delivery === 'refused')
      )
        setAttempt(null);
    },
    onSuccess: async () => {
      if (!scope.isCurrent()) return;
      setSent(true);
      setText('');
      setAttachments([]);
      setStages([]);
      setAttempt(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['attention'] }),
        client.invalidateQueries({ queryKey: ['orchestration-sessions'] }),
      ]);
    },
  });
  const submit = () => {
    if (
      !context ||
      !scope.isCurrent() ||
      changed ||
      mutation.isPending ||
      sent ||
      composer.sendBlockedReason
    )
      return;
    if (attempt) {
      mutation.mutate(attempt);
      return;
    }
    if (!text.trim() && !attachments.length) return;
    const staged = stages.filter((stage) => stage.delivery === 'staged');
    if (
      attachments.length &&
      (stages.length !== attachments.length ||
        stages.some(
          (stage) =>
            !attachments.some((file) => file.id === stage.clientAttachmentId),
        ) ||
        (staged.length > 0 &&
          (staged.length !== stages.length ||
            staged.some((stage) => !stage.reference))))
    ) {
      composer.setError("These files can't be sent together. Reattach them.");
      return;
    }
    const input: ForegroundMessageInput = {
      target: {
        agent: agentId(context.agentId),
        environment: { kind: 'current' },
      },
      conversationId: context.conversationId,
      message: text,
      clientTurnId: randomCorrelationId(),
      expectedInputRequest: reference,
      ...(staged.length
        ? {
            attachmentRefs: staged.flatMap((stage) =>
              stage.reference ? [stage.reference] : [],
            ),
          }
        : attachments.length
          ? { attachments: inlineComposerAttachments(attachments) }
          : {}),
    };
    setAttempt(input);
    mutation.mutate(input);
  };
  const locked = Boolean(attempt) || mutation.isPending || sent || !context;
  const remove = (id: string) => {
    if (locked) return;
    void composer.remove(id);
    setAttachments((current) => current.filter((file) => file.id !== id));
  };
  if (!scope.isCurrent())
    return (
      <ErrorState
        title="Station access changed"
        description="This answer belongs to another Station and can't be sent here."
      />
    );
  return (
    <form
      className="attention-answer input-reply"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {changed ? (
        <p role="alert">
          This request changed. Open the chat to review your draft.
        </p>
      ) : null}
      {query.isFetching ? (
        <SkeletonBlock count={1} label="Checking input request" />
      ) : !context && !changed ? (
        <ErrorState
          title={
            query.isError
              ? describeStationFailure(query.error).title
              : 'Input request unavailable'
          }
          description={
            query.isError
              ? describeStationFailure(query.error).body
              : "Couldn't confirm this chat can accept a reply. Your draft is saved."
          }
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        />
      ) : null}
      <ConversationConnectionProvider
        value={{ apiBase: scope.apiBase, requestScope: scope }}
      >
        <ChatInputArea
          input={text}
          attachments={attachments}
          textareaRef={textarea}
          disabled={locked}
          turnInFlight={false}
          modelSupportsAttachments={imageSupport.attachable}
          fileAttachmentsSupported={files}
          fontSize={14}
          dockHeight={400}
          canModelSelect={false}
          availableModels={[]}
          modelQuery={null}
          commandQuery={null}
          slashCommands={[]}
          onInputChange={setText}
          onSend={async () => submit()}
          onCancel={() => {}}
          onClearInput={() => setText('')}
          selectAttachmentFiles={composer.selectFiles}
          attachmentError={composer.error}
          onAttachUnavailable={composer.setError}
          attachmentStages={stages}
          sendBlockedReason={composer.sendBlockedReason}
          onRetryAttachmentStage={composer.retry}
          onCancelAttachmentStage={composer.cancel}
          onReplaceAttachmentFile={composer.replaceFile}
          onRemoveAttachment={remove}
          onClearAttachments={() =>
            attachments.forEach((file) => remove(file.id))
          }
          onModelSelect={() => {}}
          onModelReset={() => {}}
          onModelClose={() => {}}
          onModelOpen={() => {}}
          onModelRuntimeOptionChange={() => {}}
          onApprovalModeChange={() => {}}
          onCommandSelect={async () => {}}
          onCommandClose={() => {}}
          onHistoryUp={() => {}}
          onHistoryDown={() => {}}
          updateFromInput={setText}
          closeAll={() => {}}
          submitAction={{
            label: 'Send answer',
            placeholder: 'Answer this request',
          }}
        />
      </ConversationConnectionProvider>
      {mutation.error && (
        <p role="alert">
          {userFacingErrorMessage(mutation.error)}{' '}
          {attempt
            ? "Retrying won't send it twice."
            : 'Review this answer, then send again.'}
        </p>
      )}
      {attempt && !sent && (
        <Button
          onClick={submit}
          disabled={!context || changed || mutation.isPending}
        >
          Retry same answer
        </Button>
      )}
      {sent && <p role="status">Answer sent.</p>}
    </form>
  );
}
