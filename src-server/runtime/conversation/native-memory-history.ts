import type { GetMessagesOptions, StorageAdapter } from '@voltagent/core';
import type { UIMessage } from 'ai';
import { excludeChatErrorMarkers } from '../../adapters/file/memory-adapter-prompt-view.js';
import { publicAgentIdFromRuntimeKey } from '../../routes/agents/runtime-agent-identity.js';
import {
  isNativeMemoryContinuityBinding,
  type NativeMemoryContinuityBinding,
  NativeMemoryContinuityUnavailableError,
} from '../../services/orchestration/native-memory-continuity.js';

/** Private prompt-read companion. It never changes execution or write identity. */
export interface NativeMemoryHistoryCompanion {
  readonly currentSessionId: string;
  readonly agentId: string;
  ownsRuntimeAgentKey(key: string): boolean;
  isCurrent(): Promise<boolean>;
  read(
    adapter: StorageAdapter,
    userId: string,
    conversationId: string,
    options?: GetMessagesOptions,
    context?: Parameters<StorageAdapter['getMessages']>[3],
  ): Promise<UIMessage[]>;
}

function selectMessages(messages: UIMessage[], options?: GetMessagesOptions) {
  return excludeChatErrorMarkers(messages).filter((message) => {
    if (options?.roles && !options.roles.includes(message.role)) return false;
    if (!options?.before && !options?.after) return true;
    const metadata = message.metadata as { timestamp?: unknown } | undefined;
    const timestamp = metadata?.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp))
      return false;
    return (
      (!options.before || timestamp < options.before.getTime()) &&
      (!options.after || timestamp > options.after.getTime())
    );
  });
}

/** Reads existing records in lineage order; history options apply to the composed prompt. */
export function createNativeMemoryHistoryCompanion(input: {
  binding: NativeMemoryContinuityBinding;
  /** Captured before this dispatch: no earlier native turn used the current child. */
  allowMissingCurrentRecord?: boolean;
  /** Canonical, authorized user/assistant projection for an earlier harness leg. */
  readCanonicalSession(sessionId: string): Promise<UIMessage[]>;
}): NativeMemoryHistoryCompanion {
  const { binding } = input;
  if (!isNativeMemoryContinuityBinding(binding))
    throw new NativeMemoryContinuityUnavailableError();
  const ownsRuntimeAgentKey = (key: string) => {
    try {
      return publicAgentIdFromRuntimeKey(key) === binding.scope.agentId;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    currentSessionId: binding.currentSessionId,
    agentId: binding.scope.agentId,
    ownsRuntimeAgentKey,
    isCurrent: () => binding.isCurrent(),
    async read(
      adapter: StorageAdapter,
      userId: string,
      conversationId: string,
      options?: GetMessagesOptions,
      context?: Parameters<StorageAdapter['getMessages']>[3],
    ) {
      if (
        conversationId !== binding.currentSessionId ||
        userId !== (binding.scope.userId ?? '') ||
        !(await binding.isCurrent()) ||
        (options?.limit !== undefined &&
          (!Number.isSafeInteger(options.limit) || options.limit < 0))
      )
        throw new NativeMemoryContinuityUnavailableError();
      const segments = [
        ...binding.canonicalPrefixSessionIds.map((sessionId) => ({
          sessionId,
          native: false,
        })),
        ...binding.sessionIds.map((sessionId) => ({ sessionId, native: true })),
      ];
      const messages: UIMessage[] = [];
      // Start at the newest segment so a configured history limit does not
      // require loading every earlier native session. Do not limit each leg
      // independently or drop structured tool/attachment records into text.
      for (const segment of segments.reverse()) {
        if (!(await binding.isSessionCurrent(segment.sessionId)))
          throw new NativeMemoryContinuityUnavailableError();
        let stored: UIMessage[];
        if (segment.native) {
          const record = await adapter.getConversation(segment.sessionId);
          if (
            !record &&
            segment.sessionId === binding.currentSessionId &&
            input.allowMissingCurrentRecord === true
          )
            stored = [];
          else {
            if (
              !record ||
              record.id !== segment.sessionId ||
              record.userId !== userId ||
              !ownsRuntimeAgentKey(record.resourceId)
            )
              throw new NativeMemoryContinuityUnavailableError();
            stored = await adapter.getMessages(
              userId,
              segment.sessionId,
              { ...options, limit: undefined },
              context,
            );
          }
        } else stored = await input.readCanonicalSession(segment.sessionId);
        const selected = selectMessages(stored, options);
        const remaining = options?.limit
          ? options.limit - messages.length
          : undefined;
        messages.unshift(
          ...(remaining === undefined ? selected : selected.slice(-remaining)),
        );
        if (options?.limit && messages.length >= options.limit) break;
      }
      // Never send a mixed snapshot after a boundary or authorization change.
      if (!(await binding.isCurrent()))
        throw new NativeMemoryContinuityUnavailableError();
      return messages;
    },
  });
}
