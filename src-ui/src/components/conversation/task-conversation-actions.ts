import {
  continueDelegatedTask,
  interruptDelegatedTask,
  respondToDelegatedTaskRequest,
  StationRequestAuthorityError,
} from '@kontourai/station-sdk/client';
import type { ConversationCapabilities } from '../../connections/station-connection';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

/** Task ids stay on the delegated Task protocol, never the turn protocol. */
export function createTaskConversationActions(target: {
  apiBase: string;
  requestScope?: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
  capabilities: Pick<ConversationCapabilities, 'stop' | 'approvalAnswer'> &
    Partial<Pick<ConversationCapabilities, 'inputAnswer'>>;
}) {
  const options = (action: 'stop' | 'approvalAnswer' | 'inputAnswer') => {
    if (
      !target.requestScope?.isCurrent() ||
      target.capabilities[action]?.state !== 'allowed'
    )
      throw new StationRequestAuthorityError();
    return { requestScope: target.requestScope };
  };
  return {
    answerInput(
      taskId: string,
      input: Parameters<typeof continueDelegatedTask>[2],
    ) {
      return continueDelegatedTask(
        target.apiBase,
        taskId,
        input,
        options('inputAnswer'),
      );
    },
    stop(taskId: string, environmentId?: string) {
      return interruptDelegatedTask(
        target.apiBase,
        taskId,
        environmentId ? { environmentId } : {},
        options('stop'),
      );
    },
    answer(
      taskId: string,
      input: Parameters<typeof respondToDelegatedTaskRequest>[2],
    ) {
      return respondToDelegatedTaskRequest(
        target.apiBase,
        taskId,
        input,
        options('approvalAnswer'),
      );
    },
  };
}
