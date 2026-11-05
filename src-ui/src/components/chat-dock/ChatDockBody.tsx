import { useMemo } from 'react';
import { useStationConnectionsOptional } from '../../connections/StationConnectionsContext';
import type { StationConnection } from '../../connections/station-connection';
import { useChatStationConnection } from '../../connections/use-chat-station-connection';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { readRetainedChatTranscript } from '../../lib/retained-chat-transcript';
import { Button } from '../Button';
import {
  ConversationBody,
  type ConversationBodyProps,
} from '../conversation/ConversationBody';
import { ConversationConnectionProvider } from '../conversation/ConversationConnectionContext';
import { ErrorState, SkeletonList } from '../state';

export {
  agentScheduleRefreshKey,
  ephemeralAfterQueueDiscard,
  findPrecedingUserTurn,
  latestQueuedRetryNotice,
  latestSendFailureLine,
  staleSendFailureIds,
} from '../conversation/ConversationBody';

/** Dock shell adapter. The transcript and composer have one shared owner. */
export function ChatDockBody({
  connection: provided,
  ...props
}: ConversationBodyProps & {
  connection?: StationConnection;
}) {
  const { apiBase } = useApiBase();
  const requestScope = useHostRequestAuthorityScope();
  const connections = useStationConnectionsOptional();
  const { navigate } = useNavigationActions();
  const { connection, resolving, unavailable, retry } =
    useChatStationConnection(props.activeSession, provided);
  const value = useMemo(
    () =>
      connection
        ? {
            apiBase: connection.targetApiBase,
            requestScope: {
              ...connection.requestScope,
              isCurrent: connection.isCurrent,
            },
            station: connection,
          }
        : { apiBase, requestScope },
    [connection, apiBase, requestScope],
  );
  const retained = readRetainedChatTranscript(
    props.activeSession.retainedTranscript,
    props.activeSession.stationBinding,
    props.activeSession.conversationId,
  );
  if (resolving) return <SkeletonList label="Connecting to Station" />;
  if (unavailable)
    return (
      <div className="chat-messages">
        <ErrorState
          variant="compact"
          title="Station unavailable"
          description={
            connections?.remoteEnabled === false
              ? 'Enable Paired Station chats in Feature previews to continue.'
              : 'Reconnect to this chat’s Station to continue.'
          }
          action={
            connections?.remoteEnabled === false ? (
              <Button onClick={() => navigate('/settings/advanced')}>
                Open Feature previews
              </Button>
            ) : (
              <Button onClick={retry}>Reconnect</Button>
            )
          }
        />
        {retained?.messages.map((message, index) => (
          <p
            className="chat-dock__retained-text"
            key={`${index}:${message.role}`}
          >
            {message.content}
          </p>
        ))}
        {props.activeSession.messages
          .filter(
            (message) =>
              !retained ||
              (message.role === 'user' &&
                message.clientId &&
                !retained.messages.some(
                  (row) =>
                    row.role === 'user' && row.content === message.content,
                )),
          )
          .map((message) => (
            <p className="chat-dock__retained-text" key={message.id}>
              {message.content}
            </p>
          ))}
        {props.activeSession.input && (
          <p className="chat-dock__retained-text">
            {props.activeSession.input}
          </p>
        )}
      </div>
    );
  return (
    <ConversationConnectionProvider value={value}>
      <ConversationBody {...props} />
    </ConversationConnectionProvider>
  );
}
