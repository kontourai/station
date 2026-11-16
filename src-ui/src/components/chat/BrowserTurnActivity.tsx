import { createContext, useContext, useMemo } from 'react';
import { toolPartSettleableBy } from '../../hooks/orchestration/messageParts';
import { useStreamingContent } from '../../hooks/useStreamingContent';
import type { ChatMessage } from '../../types';
import { LazyBoundary } from '../LazyBoundary';
import { useBrowserActivityScope } from './BrowserActivityContext';
import { browserCallSessionId } from './browser-activity-calls';
import type { ToolCallLike } from './tool-call-runs';
import {
  type TranscriptChildren,
  TranscriptChildrenContext,
} from './transcript-child-work';

type Activity = {
  calls: ToolCallLike[];
  firstId: string;
  session: string;
  owner: string;
  owners: Map<string, string>;
  active: boolean;
  ambiguous: boolean;
};
type Index = Map<string, Activity>;
const Context = createContext<Index | null>(null);
export const useBrowserTurnActivities = () => useContext(Context);
export const browserCallIdentity = (part: ToolCallLike) =>
  part.toolCallId
    ? JSON.stringify([
        part.toolCallId,
        typeof part.sourceEventId === 'string' ? part.sourceEventId : null,
      ])
    : undefined;
export const browserTurnKey = (thread: string, turn: string, session: string) =>
  JSON.stringify([thread, turn, session]);

/** Project only calls with explicit turn, session and call identities. */
type Props = {
  transcriptChildren?: TranscriptChildren;
  messages: readonly ChatMessage[];
  chatId: string;
  threadId: string;
  liveTurnId?: string | null;
  live: boolean;
  includeStream: boolean;
  children: React.ReactNode;
};
const EMPTY_CHILDREN: TranscriptChildren = new Map();
export function BrowserTurnActivityProvider(props: Props) {
  const scope = useBrowserActivityScope();
  const children = scope ? (
    <EnabledBrowserTurnActivity
      key={JSON.stringify([
        scope.requestScope.authorityKey,
        scope.apiBase,
        props.chatId,
        props.threadId,
      ])}
      {...props}
    />
  ) : (
    props.children
  );
  return (
    <TranscriptChildrenContext.Provider
      value={props.transcriptChildren ?? EMPTY_CHILDREN}
    >
      {children}
    </TranscriptChildrenContext.Provider>
  );
}
function EnabledBrowserTurnActivity({
  messages,
  chatId,
  threadId,
  liveTurnId,
  live,
  includeStream,
  children,
}: Props) {
  const stream = useStreamingContent(chatId);
  const activities = useMemo(() => {
    const groups = new Map<
      string,
      {
        thread: string;
        turn: string;
        session: string;
        calls: Map<string, ToolCallLike>;
        owners: Map<string, string>;
        ambiguous: boolean;
      }
    >();
    const add = (
      thread: string | undefined,
      turn: string | undefined | null,
      parts: readonly ToolCallLike[],
      owner: string,
    ) => {
      if (!thread || !turn) return;
      for (const part of parts) {
        const session = browserCallSessionId(part);
        const identity = browserCallIdentity(part);
        if (!session || !identity) continue;
        const key = browserTurnKey(thread, turn, session);
        let group = groups.get(key);
        if (!group)
          groups.set(
            key,
            (group = {
              thread,
              turn,
              session,
              calls: new Map(),
              owners: new Map(),
              ambiguous: false,
            }),
          );
        // Match the producer's open/unresolved-to-terminal settlement rule.
        if (typeof part.sourceEventId === 'string') {
          for (const [oldKey, old] of group.calls) {
            if (oldKey === identity || old.toolCallId !== part.toolCallId)
              continue;
            if (
              toolPartSettleableBy(
                {
                  type: 'tool-invocation',
                  toolCallId: old.toolCallId,
                  sourceEventId:
                    typeof old.sourceEventId === 'string'
                      ? old.sourceEventId
                      : undefined,
                  state: typeof old.state === 'string' ? old.state : undefined,
                },
                part.toolCallId!,
                part.sourceEventId,
              )
            ) {
              group.calls.delete(oldKey);
              group.owners.delete(oldKey);
            }
          }
        }
        if (typeof part.sourceEventId !== 'string') {
          const terminal = [...group.calls.entries()].find(
            ([, existing]) =>
              existing.toolCallId === part.toolCallId &&
              typeof existing.sourceEventId === 'string' &&
              toolPartSettleableBy(
                {
                  type: 'tool-invocation',
                  toolCallId: part.toolCallId,
                  state:
                    typeof part.state === 'string' ? part.state : undefined,
                },
                part.toolCallId!,
                existing.sourceEventId,
              ),
          );
          if (terminal) {
            group.owners.set(identity, 'superseded');
            continue;
          }
        }
        const previous = group.calls.get(identity);
        if (
          previous &&
          (group.owners.get(identity) === owner ||
            (typeof part.sourceEventId !== 'string' && previous !== part))
        ) {
          group.ambiguous = true;
          const occurrence = JSON.stringify([
            identity,
            owner,
            group.calls.size,
          ]);
          group.calls.set(occurrence, part);
          group.owners.set(occurrence, owner);
          continue;
        }
        // The persisted copy owns a call while the stream is being flushed.
        if (!previous || owner !== 'stream') {
          group.calls.set(identity, part);
          group.owners.set(identity, owner);
        }
      }
    };
    for (const [index, message] of messages.entries()) {
      if (message.role === 'assistant')
        add(
          message.sessionId ?? threadId,
          message.turnId,
          message.contentParts ?? [],
          `row:${index}`,
        );
    }
    if (includeStream) add(threadId, liveTurnId, stream.contentParts, 'stream');
    const index: Index = new Map();
    for (const [key, group] of groups) {
      const entries = [...group.calls.entries()];
      index.set(key, {
        calls: entries.map(([, part]) => part),
        firstId: entries[0]![0],
        session: group.session,
        owner: group.owners.get(entries[0]![0])!,
        owners: group.owners,
        ambiguous: group.ambiguous,
        active: live && group.thread === threadId && group.turn === liveTurnId,
      });
    }
    return index;
  }, [
    messages,
    threadId,
    liveTurnId,
    live,
    includeStream,
    stream.contentParts,
  ]);
  return <Context.Provider value={activities}>{children}</Context.Provider>;
}

const loadBrowserActivityContent = () =>
  import('../browser-activity/BrowserActivityContent');
/** Stable tail slot: changing calls updates props without moving the live viewer. */
export function LiveBrowserTurnActivities() {
  const activities = useBrowserTurnActivities();
  const scope = useBrowserActivityScope();
  if (!scope || !activities) return null;
  return (
    <>
      {[...activities.entries()]
        .filter(([, activity]) => activity.active)
        .map(([key, activity]) => (
          <LazyBoundary
            key={key}
            load={loadBrowserActivityContent}
            componentProps={{
              scope,
              browserSessionId: activity.session,
              run: { type: 'tool-call-run' as const, key, calls: [] },
              summaryCalls: activity.calls,
              active: true,
              renderRow: () => null,
            }}
            pending={null}
            unavailable={() => null}
            shareAcrossMounts
          />
        ))}
    </>
  );
}
