import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { outboundStationIdentity } from '../../connections/station-state';
import type {
  OutboundDispatchTurn,
  OutboundStationIdentity,
} from '../../lib/outboundQueue';

const loadOutbox = () => import('../../lib/outboundQueue');

import type { ChatMessage } from '../../types';
import { deriveMessageDeliveryState } from '../../utils/messageDeliveryState';
import { describeStationFailure } from '../../utils/stationFailure';
import { useConversationConnection } from './ConversationConnectionContext';
import { createRecordConversationTransport } from './conversation-transport';
import type { DeliveryPort } from './DeliveryPort';

/** Ephemeral record state crosses the same durable claims as the dock. */
export function useRecordConversationController({
  session,
  input,
  onInputChange,
  onSent,
  onChanged,
  writable,
}: {
  session: OrchestrationSessionSummary;
  input: string;
  onInputChange: (value: string) => void;
  onSent?: (submitted: string) => void;
  onChanged?: () => void;
  writable: boolean;
}) {
  const target = useConversationConnection();
  const transport = createRecordConversationTransport(target);
  const conversationId = session.conversationId ?? session.threadId;
  const identity = JSON.stringify([
    target.apiBase,
    target.station?.runtimeKey,
    target.requestScope?.authorityKey,
    session.threadId,
  ]);
  const latest = useRef({ input, onInputChange, identity });
  latest.current = { input, onInputChange, identity };
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const station = target.station
    ? outboundStationIdentity(target.station)
    : undefined;
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => [
      'conversation-record-outbox',
      target.apiBase,
      target.station?.runtimeKey ?? target.requestScope?.authorityKey,
      conversationId,
    ],
    [
      target.apiBase,
      target.station?.runtimeKey,
      target.requestScope?.authorityKey,
      conversationId,
    ],
  );
  const owns = (
    row: OutboundDispatchTurn,
    identity: (value?: OutboundStationIdentity) => string,
  ) =>
    identity(row.station) === identity(station) &&
    (row.conversationId ?? row.sessionId) === conversationId;
  const enabled = !target.record?.readOnly;
  const outbox = useQuery({
    queryKey,
    enabled,
    queryFn: async () => {
      const { outboundDispatch, outboundStationKey } = await loadOutbox();
      return (await outboundDispatch.snapshot()).filter((row) =>
        owns(row, outboundStationKey),
      );
    },
    retry: false,
  });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let release = () => {};
    void loadOutbox().then(
      ({ outboundDispatch }) => {
        if (!active) return;
        const refresh = () => {
          void queryClient.invalidateQueries({ queryKey });
        };
        const local = outboundDispatch.subscribe(refresh);
        const remote = outboundDispatch.subscribeRemoteChange(refresh);
        release = () => {
          local();
          remote();
        };
      },
      () => {
        // The outbox query reports the same module-load error with Retry.
      },
    );
    return () => {
      active = false;
      release();
    };
  }, [queryClient, enabled, queryKey]);
  const rows = outbox.data ?? [];
  const current = () => {
    if (
      target.requestScope?.isCurrent?.() === false ||
      target.station?.isCurrent() === false
    )
      throw new Error('The Station connection changed.');
  };
  const send = useMutation({
    mutationKey: [
      'conversation-record-send',
      target.station?.runtimeKey ??
        target.requestScope?.authorityKey ??
        target.apiBase,
      conversationId,
    ],
    mutationFn: async (retry?: OutboundDispatchTurn) => {
      if (
        pending.current.has(conversationId) ||
        !writable ||
        !(retry?.content ?? input).trim()
      )
        return;
      pending.current.add(conversationId);
      const text = retry?.content ?? input;
      const clientTurnId = retry?.clientTurnId ?? crypto.randomUUID();
      let live:
        | Awaited<
            ReturnType<
              typeof import('../../lib/outboundQueue').outboundDispatch.beginLive
            >
          >
        | undefined;
      let invoked = false;
      try {
        current();
        const { outboundDispatch, outboundStationKey } = await loadOutbox();
        const retained = (await outboundDispatch.snapshot()).filter((row) =>
          owns(row, outboundStationKey),
        );
        if (
          retained.some((row) => row.clientTurnId !== retry?.clientTurnId) ||
          (retry &&
            retained.find((row) => row.clientTurnId === retry.clientTurnId)
              ?.status !== 'failed')
        )
          throw new Error('Resolve the earlier message before sending.');
        live = await outboundDispatch.beginLive({
          clientTurnId,
          sessionId: session.threadId,
          conversationId,
          agentSlug:
            session.assignedAgentSlug ??
            session.delegation?.targetId ??
            session.provider,
          content: text,
          station,
        });
        try {
          current();
        } catch (error) {
          await live.refused();
          throw error;
        }
        invoked = true;
        await transport.continue(conversationId, {
          message: text,
          clientTurnId,
          environment: { kind: 'current' },
        });
        await live.accepted();
        if (
          target.station?.isCurrent() !== false &&
          target.requestScope?.isCurrent?.() !== false
        ) {
          // A durable draft owner compares its current value even after this
          // detail unmounts. The ephemeral fallback only clears a live editor.
          if (onSent) onSent(text);
          else if (
            mounted.current &&
            latest.current.identity === identity &&
            latest.current.input === text
          )
            latest.current.onInputChange('');
        }
        if (
          latest.current.identity === identity &&
          target.station?.isCurrent() !== false
        )
          onChanged?.();
      } catch (error) {
        const failure = describeStationFailure(
          error,
          target.station,
          clientTurnId,
        );
        if (live && invoked) {
          if (failure.delivery === 'refused') await live.notSent(failure.body);
          else await live.indeterminate(failure.body, { listed: true });
        }
        throw error;
      } finally {
        pending.current.delete(conversationId);
      }
    },
  });
  const stop = useMutation({
    mutationFn: () => {
      current();
      return transport.stop({
        threadId: session.threadId,
        turnId: session.conversationActivity?.openTurn?.turnId,
      });
    },
    onSuccess: onChanged,
  });
  const pendingMessages: ChatMessage[] = rows.map((row) => ({
    id: row.clientTurnId,
    clientId: row.clientTurnId,
    role: 'user',
    content: row.content,
    timestamp: row.createdAt,
    ...(row.status === 'failed'
      ? {
          deliveryNotice: {
            clientTurnId: row.clientTurnId,
            text: row.content,
            state: 'not-sent' as const,
            diagnostic: '',
            description:
              row.lastError ?? 'Station did not accept this message.',
          },
        }
      : {}),
  }));
  const deliveryFor = (message: ChatMessage) => {
    const row = rows.find((row) => row.clientTurnId === message.clientId);
    if (!row) return;
    const state = deriveMessageDeliveryState({
      outbox: row.status,
      lookup: row.deliveryCheck?.outcome,
      requestInFlight: row.liveInFlight,
      outboxSendUnderWay: row.sendUnderWay,
    });
    if (!state) return;
    const port: DeliveryPort = {
      savedOnDevice: true,
      canRetry: writable && row.status === 'failed',
      canDiscardUnconfirmed:
        row.status === 'may-have-started' && !row.liveInFlight,
      check: async () => {
        current();
        const { outboundDispatch } = await loadOutbox();
        return outboundDispatch.check(
          row.clientTurnId,
          (candidate) =>
            transport.recheckDelivery(
              candidate.conversationId ?? candidate.sessionId,
              candidate.clientTurnId,
            ),
          station,
          conversationId,
        );
      },
      retry: async () => {
        current();
        await send.mutateAsync(row);
      },
      edit: async () => {
        current();
        const { outboundDispatch } = await loadOutbox();
        if (row.status === 'failed')
          await outboundDispatch.discard(
            row.clientTurnId,
            station,
            conversationId,
          );
        latest.current.onInputChange(row.content);
        send.reset();
        return row.status === 'may-have-started'
          ? 'The original may have reached the agent.'
          : null;
      },
      discard: async (kind) => {
        current();
        const { outboundDispatch } = await loadOutbox();
        if (kind === 'unconfirmed')
          await outboundDispatch.dismissUnconfirmed(
            row.clientTurnId,
            station,
            conversationId,
          );
        else
          await outboundDispatch.discard(
            row.clientTurnId,
            station,
            conversationId,
          );
        send.reset();
        return null;
      },
    };
    return { state, port };
  };
  return {
    send,
    stop,
    pendingMessages,
    deliveryFor,
    blocked: rows.length > 0,
    outboxError: outbox.error,
    retryOutbox: outbox.refetch,
  };
}
