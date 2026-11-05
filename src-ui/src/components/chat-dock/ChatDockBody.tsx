import type { ComponentProps } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { ConversationBody } from '../conversation/ConversationBody';
import { ConversationConnectionProvider } from '../conversation/ConversationConnectionContext';

export {
  agentScheduleRefreshKey,
  ephemeralAfterQueueDiscard,
  findPrecedingUserTurn,
  latestQueuedRetryNotice,
  latestSendFailureLine,
  staleSendFailureIds,
} from '../conversation/ConversationBody';

/** Dock shell adapter. The transcript and composer have one shared owner. */
export function ChatDockBody(props: ComponentProps<typeof ConversationBody>) {
  const { apiBase } = useApiBase();
  const requestScope = useHostRequestAuthorityScope();
  return (
    <ConversationConnectionProvider value={{ apiBase, requestScope }}>
      <ConversationBody {...props} />
    </ConversationConnectionProvider>
  );
}
