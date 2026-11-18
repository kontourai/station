import type { ProjectSharedTaskSummary } from '@kontourai/station-contracts/project-shared-task';
import {
  appendProjectTaskRoomHumanMessage,
  discoverProjectTaskRoom,
} from '@kontourai/station-sdk/project-task-rooms';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { RoomComposer } from '../../components/room/RoomComposer';
import { SkeletonBlock } from '../../components/state';
import { requireGuestAccount } from './guest-account-authority';

export function GuestTaskReply({
  apiBase,
  principalId,
  shared,
  onSent,
}: {
  apiBase: string;
  principalId: string;
  shared: ProjectSharedTaskSummary;
  onSent(): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const pendingIntent = useRef<
    { proposalId: string; occurredAt: string; text: string } | undefined
  >(undefined);
  const sending = useRef(false);
  const scope = { authentication: 'omit' as const, timeoutMs: 15000 };
  const room = useQuery({
    queryKey: [
      'guest-task-discussion',
      apiBase,
      principalId,
      shared.shareId,
      shared.task.id,
    ],
    queryFn: async ({ signal }) => {
      await requireGuestAccount(apiBase, principalId, signal);
      const room = await discoverProjectTaskRoom(apiBase, shared.task.id, {
        ...scope,
        signal,
      });
      await requireGuestAccount(apiBase, principalId, signal);
      return room;
    },
    retry: false,
    gcTime: 0,
  });
  const send = useMutation({
    retry: false,
    mutationFn: async () => {
      const intent = pendingIntent.current!;
      return appendProjectTaskRoomHumanMessage(
        apiBase,
        {
          ...intent,
          taskId: shared.task.id,
          expectedTaskCreatedAt: shared.task.createdAt,
          expectedMember: { shareId: shared.shareId, principalId },
        },
        scope,
      );
    },
  });
  async function reply() {
    if (sending.current || !draft.trim()) return;
    sending.current = true;
    pendingIntent.current ??= {
      proposalId: randomCorrelationId(),
      occurredAt: new Date().toISOString(),
      text: draft.trim(),
    };
    try {
      const outcome = await send.mutateAsync();
      if (outcome.kind === 'committed' || outcome.kind === 'duplicate') {
        setDraft('');
        setNotice('Reply sent.');
        pendingIntent.current = undefined;
        onSent();
      } else {
        setNotice(
          'The reply could not be confirmed. Check the conversation before retrying.',
        );
        void room.refetch();
      }
    } catch {
      setNotice(
        'The reply could not be confirmed. Retry to check the same reply.',
      );
      void room.refetch();
    } finally {
      sending.current = false;
    }
  }
  if (room.isPending) return <SkeletonBlock label="Checking reply access" />;
  if (room.isError)
    return (
      <Button onClick={() => void room.refetch()}>Retry reply access</Button>
    );
  if (
    (room.data.kind !== 'opened' && room.data.kind !== 'existing') ||
    !room.data.capabilities.messageWrite
  )
    return (
      <div>
        <p>
          To reply, ask the owner to check your Project role and browser access.
        </p>
        <Button pending={room.isFetching} onClick={() => void room.refetch()}>
          Check reply access
        </Button>
      </div>
    );
  return (
    <RoomComposer
      id={id}
      label="Reply to this Task"
      placeholder="Write a reply…"
      value={draft}
      onValueChange={setDraft}
      onSend={() => void reply()}
      canSend={!!draft.trim() && !room.isFetching}
      pending={send.isPending}
      readOnly={!!pendingIntent.current}
      sendLabel={pendingIntent.current ? 'Retry reply' : 'Send reply'}
      inputProps={{ maxLength: 16384 }}
      below={notice && <p role="status">{notice}</p>}
    />
  );
}
