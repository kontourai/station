import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import { PAIRING_SCOPE_ORCHESTRATION_OPERATE } from '@kontourai/station-contracts/environment-security';
import {
  useChildWorkInstructionsQuery,
  useSteerChildWorkMutation,
} from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { get, update } from 'idb-keyval';
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { useComposerAttachments } from '../../hooks/useComposerAttachments';
import type {
  ComposerAttachmentStageSnapshot,
  FileAttachment,
} from '../../types';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';
import {
  appendDictation,
  useStartDictation,
} from '../chat-start/useStartDictation';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { recordedDeliveryPort } from '../conversation/DeliveryPort';
import { LazyBoundary } from '../LazyBoundary';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import type { ChildInstructionForm } from './ChatInputArea';

const loadInstructionForm = () =>
  import('./ChatInputArea').then((module) => ({
    default: module.ChildInstructionForm,
  }));

import { MessageDeliveryNote } from './message-bubble/MessageDeliveryNote';
import { useUIBlockActions } from './UIBlockActionsContext';
import './ChildWorkInstructionPanel.css';

type Pending = {
  attachmentRefs?: StagedAttachmentReference[];
  threadId: string;
  childId: string;
  turnId: string;
  input: string;
  clientInputId: string;
};

function sameImages(
  left: Pending['attachmentRefs'],
  right:
    | { name: string; digest: string; clientAttachmentId: string }[]
    | undefined,
) {
  return (
    (left?.length ?? 0) === (right?.length ?? 0) &&
    (left ?? []).every(
      (ref, i) =>
        ref.digest === right?.[i]?.digest &&
        ref.name === right[i].name &&
        ref.clientAttachmentId === right[i].clientAttachmentId,
    )
  );
}

async function clearInstruction(key: string, expected: Pending) {
  await update<Pending | null>(key, (current) =>
    current?.clientInputId === expected.clientInputId &&
    current.threadId === expected.threadId &&
    current.childId === expected.childId &&
    current.turnId === expected.turnId &&
    current.input === expected.input &&
    sameImages(current.attachmentRefs, expected.attachmentRefs)
      ? null
      : (current ?? null),
  );
}

export type ChildReplyRun = {
  images?: boolean;
  engineId?: string;
  engineLabel?: string;
  model?: string;
};

type ChildDraft = {
  text: string;
  turnId?: string;
  files?: FileAttachment[];
  stages?: ComposerAttachmentStageSnapshot[];
};
export type ChildInstructionDrafts = Map<string, ChildDraft>;

function draftFromInstruction(saved: Pending): ChildDraft {
  return {
    text: saved.input,
    turnId: saved.turnId,
    files: saved.attachmentRefs?.map((ref) => ({
      id: ref.clientAttachmentId,
      name: ref.name,
      size: ref.size,
      type: ref.mimeType,
      data: '',
    })),
    stages: saved.attachmentRefs?.map((reference) => ({
      clientAttachmentId: reference.clientAttachmentId,
      name: reference.name,
      size: reference.size,
      mimeType: reference.mimeType,
      stageId: reference.stageId,
      reference,
      state: 'complete',
      delivery: 'staged',
      progress: 1,
    })),
  };
}

export function ChildWorkInstructionPanel({
  threadId,
  childId,
  turnId,
  running,
  name,
  historyAvailable,
  composer,
}: {
  composer?: {
    run: ChildReplyRun;
    canContinue: boolean;
    drafts?: ChildInstructionDrafts;
  };
  threadId: string;
  childId: string;
  turnId?: string;
  running: boolean;
  name: string;
  historyAvailable: boolean;
}) {
  const editorId = useId();
  const authority = useAuthorityPersistence();
  const host = useHostRequestAuthorityScope();
  const targetScope = useOptionalConversationConnection();
  const scope = targetScope?.requestScope ?? host;
  const apiBase = targetScope?.apiBase ?? scope?.apiBase;
  const cardActions = useUIBlockActions();
  const mayContinue = composer
    ? composer.canContinue
    : cardActions.canSendChildInstruction === true;
  const grant = authority.observation?.grant;
  const canOperate = targetScope?.station
    ? targetScope.station.isCurrent() &&
      targetScope.station.capabilities.childInstruction.state === 'allowed'
    : grant?.kind === 'operator' ||
      (grant?.kind === 'device' &&
        grant.grantedScopes.includes(PAIRING_SCOPE_ORCHESTRATION_OPERATE));
  const namespace = targetScope?.station?.stationKey ?? authority.namespace;
  const key = namespace
    ? `child-steer:${JSON.stringify([namespace, threadId, childId])}`
    : null;
  const history = useChildWorkInstructionsQuery(
    {
      threadId,
      childId,
      enabled: !!scope && !!namespace && historyAvailable,
      requestScope: scope,
      running,
    },
    apiBase,
  );
  const send = useSteerChildWorkMutation(apiBase, scope);
  const drafts = composer?.drafts;
  const [draft, setDraft] = useState<ChildDraft>(() => {
    const saved = key ? drafts?.get(key) : undefined;
    if (!saved) return { text: '' };
    // A transfer belongs to the previous mounted editor. Its retained file can be retried here.
    return {
      ...saved,
      stages: saved.stages?.map((stage) =>
        stage.state === 'queued' || stage.state === 'uploading'
          ? {
              ...stage,
              state: 'retryable',
              error: 'Upload interrupted. Retry or choose the image again.',
            }
          : stage,
      ),
    };
  });
  const latestDraft = useRef(draft);
  const writeDraft = useCallback(
    (next: ChildDraft) => {
      if (!next.text && !next.files?.length && !next.stages?.length)
        next = { text: '' };
      latestDraft.current = next;
      if (key && drafts) {
        if (next.turnId || next.text) drafts.set(key, next);
        else drafts.delete(key);
      }
      setDraft(next);
    },
    [key, drafts],
  );
  const { text, turnId: draftTurnId, files = [], stages = [] } = draft;
  // Staging must use the child reader's captured Station. A missing target scope cannot fall back to the host.
  const uploadScope = targetScope ? targetScope.requestScope : host;
  const canAccessUploads =
    !!uploadScope?.isCurrent() && !!apiBase && canOperate && mayContinue;
  const allowImages =
    canAccessUploads && composer?.run.images === true && running && !!turnId;
  const uploads = useComposerAttachments({
    apiBase: apiBase ?? '',
    ownerKey: key ?? undefined,
    requestScope: uploadScope ?? undefined,
    cancelOnUnmount: true,
    attachments: canAccessUploads ? files : [],
    stages: canAccessUploads ? stages : [],
    capabilities: { images: allowImages, files: false },
    getCurrentAttachments: () => latestDraft.current.files ?? [],
    getCurrentStages: () => latestDraft.current.stages ?? [],
    onAddAttachments: (added) =>
      writeDraft({
        ...latestDraft.current,
        turnId: latestDraft.current.turnId ?? turnId,
        files: [...(latestDraft.current.files ?? []), ...added],
      }),
    onReplaceAttachment: (replacement) =>
      writeDraft({
        ...latestDraft.current,
        files: latestDraft.current.files?.map((file) =>
          file.id === replacement.id ? replacement : file,
        ),
      }),
    onStagesChange: (stages) =>
      writeDraft({
        ...latestDraft.current,
        turnId: latestDraft.current.turnId ?? turnId,
        stages,
      }),
  });
  const reads = useRef(0);
  const [readingImages, setReadingImages] = useState(false);
  const selectImages = async (chosen: File[]) => {
    if (!allowImages || !uploadScope?.isCurrent()) return;
    reads.current += 1;
    setReadingImages(true);
    try {
      await uploads.selectFiles(chosen);
    } finally {
      reads.current -= 1;
      setReadingImages(reads.current > 0);
    }
  };
  const removeImage = (id: string) => {
    if (!uploadScope?.isCurrent()) return;
    void uploads.remove(id);
    writeDraft({
      ...latestDraft.current,
      files: latestDraft.current.files?.filter((file) => file.id !== id),
    });
  };
  const [pending, setPending] = useState<Pending | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const target = useRef({
    threadId,
    childId,
    turnId,
    running,
    mayContinue,
    canOperate,
    allowImages,
  });
  target.current = {
    threadId,
    childId,
    turnId,
    running,
    mayContinue,
    canOperate,
    allowImages,
  };
  useEffect(() => {
    let active = true;
    setPending(null);
    setLoaded(false);
    if (!key) return;
    void get<Pending>(key).then(
      (value) => {
        if (active) {
          setPending(value ?? null);
          setLoaded(true);
        }
      },
      () => {
        if (active) setMessage('Could not load the pending instruction.');
      },
    );
    return () => {
      active = false;
    };
  }, [key]);
  useEffect(() => {
    if (!key || !pending || !history.data) return;
    const entry = history.data.pages
      .flatMap((page) => page.entries)
      .find(
        (item) =>
          item.clientInputId === pending.clientInputId &&
          item.childId === pending.childId &&
          item.turnId === pending.turnId &&
          item.text === pending.input &&
          sameImages(pending.attachmentRefs, item.attachments),
      );
    if (!entry || entry.delivery === 'indeterminate') return;
    let active = true;
    void clearInstruction(key, pending).then(() => {
      if (!active) return;
      setPending(null);
      if (entry.delivery === 'refused') {
        writeDraft(draftFromInstruction(pending));
        setMessage('The instruction was not sent.');
      } else {
        writeDraft({ text: '' });
        setMessage('Sent to the subagent.');
      }
    });
    return () => {
      active = false;
    };
  }, [key, pending, history.data, writeDraft]);
  const submit = async () => {
    if (
      busy.current ||
      reads.current > 0 ||
      pending ||
      !key ||
      !scope?.isCurrent() ||
      !canOperate ||
      !mayContinue ||
      !running ||
      !turnId ||
      (!text.trim() && !files.length)
    )
      return;
    const refs = files.map(
      (file) =>
        stages.find(
          (stage) =>
            stage.clientAttachmentId === file.id &&
            stage.state === 'complete' &&
            stage.delivery === 'staged',
        )?.reference,
    );
    if (
      files.length &&
      (!allowImages ||
        uploads.sendBlockedReason ||
        refs.some((ref) => !ref) ||
        stages.length !== files.length)
    ) {
      uploads.setError(
        'The images are not ready. Retry the upload or remove them.',
      );
      return;
    }
    const saved: Pending = {
      ...(refs.length
        ? {
            attachmentRefs: refs.filter(
              (ref): ref is StagedAttachmentReference => !!ref,
            ),
          }
        : {}),
      threadId,
      childId,
      turnId,
      input: text.trim(),
      clientInputId: randomCorrelationId(),
    };
    if (draftTurnId !== turnId) {
      setMessage('The subagent turn changed. This instruction was not sent.');
      return;
    }
    busy.current = true;
    setSubmitting(true);
    try {
      try {
        let claimed = false;
        await update<Pending | null>(key, (current) => {
          if (current) return current;
          claimed = true;
          return saved;
        });
        if (!claimed) {
          setMessage('Another instruction is awaiting confirmation.');
          return;
        }
      } catch {
        setMessage('Could not save the instruction. It was not sent.');
        return;
      }
      setPending(saved);
      if (!scope.isCurrent()) {
        setMessage('The connection changed. Your instruction is saved.');
        return;
      }
      const current = target.current;
      if (
        !current.running ||
        !current.mayContinue ||
        !current.canOperate ||
        current.threadId !== saved.threadId ||
        current.childId !== saved.childId ||
        (saved.attachmentRefs?.length && !current.allowImages) ||
        current.turnId !== saved.turnId
      ) {
        setMessage(
          'The subagent or your access changed. Your instruction is saved.',
        );
        return;
      }
      const { attachmentRefs, ...instruction } = saved;
      const result = await send.mutateAsync({
        ...instruction,
        input: attachmentRefs?.length
          ? { text: saved.input, attachmentRefs }
          : saved.input,
      });
      await history.refetch();
      if (result.outcome === 'steered') {
        await clearInstruction(key, saved);
        setPending(null);
        writeDraft({ text: '' });
        setMessage('Sent to the subagent.');
      } else if (result.outcome === 'indeterminate') setMessage('');
      else {
        await clearInstruction(key, saved);
        setPending(null);
        writeDraft(draftFromInstruction(saved));
        setMessage(
          result.outcome === 'attachments-unavailable'
            ? 'The images could not be read. Reattach them and send again.'
            : result.outcome === 'unsupported'
              ? saved.attachmentRefs?.length
                ? 'The image was not sent.'
                : 'This subagent cannot receive instructions.'
              : result.outcome === 'confinement-changed'
                ? 'Access changed. The instruction was not sent.'
                : result.outcome === 'not-authorized'
                  ? 'You cannot send to this subagent.'
                  : 'The instruction was not sent. The subagent may have finished.',
        );
      }
    } catch {
      setMessage('');
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };
  const entries = history.data?.pages.flatMap((page) => page.entries) ?? [];
  const writable =
    running &&
    !!turnId &&
    canOperate &&
    mayContinue &&
    !!key &&
    loaded &&
    !pending;
  const identity = composer && (
    <span className="child-instructions__identity">
      {[composer.run.engineLabel, composer.run.model ?? 'Model not reported']
        .filter(Boolean)
        .join(' · ')}
    </span>
  );
  const historyContent = (
    <>
      {!historyAvailable && (
        <p>Instruction history is unavailable for this subagent.</p>
      )}
      {historyAvailable && scope && namespace && history.isPending && (
        <SkeletonBlock count={1} label="Instructions" />
      )}
      {history.isError && (
        <ErrorState
          variant="compact"
          title="Could not load instructions"
          description={
            history.error
              ? describeStationFailure(history.error).body
              : undefined
          }
          action={
            <Button
              size="sm"
              className="tap-target"
              onClick={() => void history.refetch()}
            >
              Retry
            </Button>
          }
        />
      )}
      {entries.length > 0 && (
        <ol>
          {entries.map((entry) => (
            <li key={entry.clientInputId}>
              <p>{entry.text}</p>
              {entry.attachments?.map((image) => (
                <span key={image.clientAttachmentId}>{image.name} </span>
              ))}
              <small>
                {entry.principal?.display ?? 'Sender not recorded'} ·{' '}
                {entry.clientOrigin?.reported.surface ??
                  'Source not recorded'}{' '}
              </small>
              <MessageDeliveryNote
                variant="inline"
                state={
                  entry.delivery === 'delivered'
                    ? 'delivered'
                    : entry.delivery === 'refused'
                      ? 'not-sent'
                      : 'unconfirmed'
                }
                port={recordedDeliveryPort}
              />
            </li>
          ))}
        </ol>
      )}
      {historyAvailable && history.isSuccess && entries.length === 0 && (
        <Empty variant="compact" label="Nothing sent yet" />
      )}
      {history.hasNextPage && (
        <Button
          size="sm"
          pending={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Load more instructions
        </Button>
      )}
    </>
  );
  return (
    <section
      className={
        composer
          ? 'child-instructions child-instructions--composer'
          : 'child-instructions'
      }
      aria-label="Subagent instructions"
    >
      {composer ? (
        <>
          {!writable && identity}
          {(entries.length > 0 || history.isError || history.hasNextPage) && (
            <details>
              <summary>Instruction history</summary>
              {historyContent}
            </details>
          )}
        </>
      ) : (
        <>
          <h4>Station instructions to {name}</h4>
          {historyContent}
        </>
      )}
      {composer && message && <p role="status">{message}</p>}
      {pending && (
        <p>
          Saved instruction:{' '}
          {[
            pending.input,
            ...(pending.attachmentRefs?.map((ref) => ref.name) ?? []),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {pending && canOperate && mayContinue && key && loaded ? (
        <MessageDeliveryNote
          variant="inline"
          state={submitting ? 'sending' : 'unconfirmed'}
          port={{
            savedOnDevice: true,
            canDiscardUnconfirmed: !submitting,
            discard: async () => {
              await clearInstruction(key, pending);
              setPending((current) =>
                current?.clientInputId === pending.clientInputId
                  ? null
                  : current,
              );
              writeDraft({
                ...draftFromInstruction(pending),
                turnId: pending.attachmentRefs?.length
                  ? pending.turnId
                  : target.current.turnId,
              });
              setMessage('');
              return null;
            },
            check: async () => {
              if (
                !scope?.isCurrent() ||
                !target.current.canOperate ||
                !target.current.mayContinue
              )
                throw new Error('The connection or your access changed.');
              const fresh = await history.refetch();
              const found = fresh.data?.pages
                .flatMap((page) => page.entries)
                .find(
                  (entry) =>
                    entry.clientInputId === pending.clientInputId &&
                    entry.childId === pending.childId &&
                    entry.turnId === pending.turnId &&
                    entry.text === pending.input &&
                    sameImages(pending.attachmentRefs, entry.attachments),
                );
              if (
                !scope.isCurrent() ||
                target.current.threadId !== pending.threadId ||
                target.current.childId !== pending.childId
              )
                throw new Error('The instruction target changed.');
              if (found && found.delivery !== 'indeterminate') {
                await clearInstruction(key, pending);
                setPending((current) =>
                  current?.clientInputId === pending.clientInputId
                    ? null
                    : current,
                );
                if (found.delivery === 'delivered') {
                  writeDraft({ text: '' });
                  setMessage('Sent to the subagent.');
                } else {
                  writeDraft(draftFromInstruction(pending));
                  setMessage('The instruction was not sent.');
                }
              }
              return found?.delivery === 'delivered'
                ? 'started'
                : found?.delivery === 'refused'
                  ? 'not-received'
                  : 'indeterminate';
            },
          }}
        />
      ) : !running ? (
        <p>This subagent has finished.</p>
      ) : !turnId ? (
        <p>This subagent cannot receive instructions.</p>
      ) : !canOperate || !mayContinue ? (
        <p>You cannot send to this subagent.</p>
      ) : !key || !loaded ? (
        <p>Preparing instructions…</p>
      ) : (
        <ChildInstructionEditor
          images={
            composer &&
            canAccessUploads &&
            (allowImages || files.length || stages.length)
              ? {
                  sessionId: JSON.stringify([scope?.authorityKey, key, turnId]),
                  attachments: files,
                  attachmentStages: stages,
                  modelSupportsAttachments: allowImages,
                  selectAttachmentFiles: allowImages ? selectImages : undefined,
                  onRemoveAttachment: removeImage,
                  onClearAttachments: () =>
                    files.forEach((file) => removeImage(file.id)),
                  onRetryAttachmentStage: allowImages
                    ? uploads.retry
                    : undefined,
                  onCancelAttachmentStage: canAccessUploads
                    ? uploads.cancel
                    : undefined,
                  onReplaceAttachmentFile: allowImages
                    ? uploads.replaceFile
                    : undefined,
                  attachmentError: uploads.error,
                  sendBlockedReason: readingImages
                    ? 'Preparing image…'
                    : uploads.sendBlockedReason,
                  removalUnblocksSend: uploads.removalUnblocksSend,
                }
              : undefined
          }
          name={name}
          editorId={editorId}
          run={composer?.run}
          text={text}
          onChange={(value) => {
            if (!busy.current)
              writeDraft({
                ...latestDraft.current,
                text: value,
                turnId: latestDraft.current.turnId ?? turnId,
              });
          }}
          sending={submitting || send.isPending}
          onSubmit={
            historyAvailable && history.isSuccess && !history.isError
              ? submit
              : undefined
          }
        />
      )}
      {!composer && message && <p role="status">{message}</p>}
    </section>
  );
}

function ChildInstructionEditor(
  props: ComponentProps<typeof ChildInstructionForm>,
) {
  const voice = useStartDictation((value) =>
    props.onChange(appendDictation(props.text, value)),
  );
  return (
    <LazyBoundary
      load={loadInstructionForm}
      shareAcrossMounts
      pending={<SkeletonBlock count={1} label="Preparing instructions" />}
      componentProps={{ ...props, voice }}
    />
  );
}
