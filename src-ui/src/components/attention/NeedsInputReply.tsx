import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  AttentionRequestReference,
  NeedsInputAttentionItem,
} from '@kontourai/station-contracts/attention';
import { CHAT_FILE_MIME_TYPES } from '@kontourai/station-contracts/chat-attachment';
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
import { filesFromDataTransfer } from '../../utils/attachment-file-transfer';
import { Button } from '../Button';
import { ComposerAttachmentStrip } from '../chat/ComposerAttachmentStrip';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import { ErrorState, SkeletonBlock } from '../state';
import './NeedsInputReply.css';

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
  const filePicker = useRef<HTMLInputElement>(null);
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
          'The request or Station access changed. Open the current session before answering.',
        );
      return sendExecutionMessage(scope.apiBase, input, {
        requestScope: scope,
      });
    },
    onError: (error) => {
      if (isProvablyNotSent(error)) setAttempt(null);
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
      composer.setError(
        'The selected files do not have one complete delivery mode. Reattach them before sending.',
      );
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
        description="This answer remains bound to its original Station and cannot be sent here."
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
          This request changed. Your draft still belongs to the earlier request;
          open the session to review it.
        </p>
      ) : null}
      {query.isFetching ? (
        <SkeletonBlock count={1} label="Checking input request" />
      ) : !context && !changed ? (
        <ErrorState
          title="Input request unavailable"
          description="Its current binding or input capabilities could not be confirmed. Your draft has been retained."
        />
      ) : null}
      <label htmlFor={`input-reply-${item.id}`}>Answer this session</label>
      <textarea
        id={`input-reply-${item.id}`}
        value={text}
        readOnly={locked}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          if (locked) return;
          const pasted = filesFromDataTransfer(event.clipboardData);
          if (pasted.length) {
            event.preventDefault();
            void composer.selectFiles(pasted);
          }
        }}
      />
      <fieldset disabled={locked} className="input-reply__attachments">
        <ComposerAttachmentStrip
          attachments={attachments}
          stages={stages}
          onRemove={remove}
          onRetry={composer.retry}
          onCancel={composer.cancel}
          onReplaceFile={composer.replaceFile}
        />
        {(imageSupport.attachable || files) && (
          <>
            <input
              ref={filePicker}
              type="file"
              hidden
              multiple
              accept={[
                ...(imageSupport.attachable ? ['image/*'] : []),
                ...(files ? CHAT_FILE_MIME_TYPES : []),
              ].join(',')}
              onChange={(event) => {
                const selected = Array.from(event.target.files ?? []);
                event.target.value = '';
                void composer.selectFiles(selected);
              }}
              aria-label="Files for this answer"
            />
            <Button onClick={() => filePicker.current?.click()}>
              Attach files
            </Button>
          </>
        )}
      </fieldset>
      {composer.error && <p role="alert">{composer.error}</p>}
      {composer.sendBlockedReason && (
        <p role="status">{composer.sendBlockedReason}</p>
      )}
      {mutation.error && (
        <p role="alert">
          {mutation.error.message} Retry sends the same answer with the same
          operation identity.
        </p>
      )}
      {sent ? (
        <p role="status">Answer sent.</p>
      ) : (
        <ResponsiveSurfaceActions>
          <Button
            type="submit"
            pending={mutation.isPending}
            pendingLabel="Sending answer…"
            disabled={
              !context ||
              changed ||
              Boolean(composer.sendBlockedReason) ||
              (!attempt && !text.trim() && !attachments.length)
            }
          >
            {attempt ? 'Retry same answer' : 'Send answer'}
          </Button>
        </ResponsiveSurfaceActions>
      )}
    </form>
  );
}
