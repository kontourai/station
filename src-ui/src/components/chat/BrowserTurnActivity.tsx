import { createContext, useContext, useMemo } from 'react';
import { useStreamingContent } from '../../hooks/useStreamingContent';
import type { ChatMessage } from '../../types';
import { useBrowserActivityScope } from './BrowserActivityContext';
import { browserCallSessionId } from './browser-activity-calls';
import type { ToolCallLike } from './tool-call-runs';
import {
  type TranscriptChildren,
  TranscriptChildrenContext,
} from './transcript-child-work';

type Activity = {
  calls: ToolCallLike[];
  lastId: string;
  owner: string;
  owners: Map<string, string>;
  active: boolean;
};
type Index = Map<string, Activity>;
const Context = createContext<Index | null>(null);
export const useBrowserTurnActivities = () => useContext(Context);
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
        calls: Map<string, ToolCallLike>;
        owners: Map<string, string>;
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
        if (!session || !part.toolCallId) continue;
        const key = browserTurnKey(thread, turn, session);
        let group = groups.get(key);
        if (!group)
          groups.set(
            key,
            (group = {
              thread,
              turn,
              calls: new Map(),
              owners: new Map(),
            }),
          );
        // The persisted copy owns a call while the stream is being flushed.
        if (!group.calls.has(part.toolCallId) || owner !== 'stream') {
          group.calls.set(part.toolCallId, part);
          group.owners.set(part.toolCallId, owner);
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
        lastId: entries.at(-1)![0],
        owner: group.owners.get(entries.at(-1)![0])!,
        owners: group.owners,
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
