import { useCallback } from 'react';
import { showChatPageOrDock } from '../../app-shell/chat-placement';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import {
  navigationStore,
  useNavigationActions,
} from '../../contexts/NavigationContext';
import { requestConversationFileIntake } from '../../lib/conversation-file-intake';

export function useBrowserArtifactIntake() {
  const scope = useHostRequestAuthorityScope();
  const navigation = useNavigationActions();
  return useCallback(
    (isCurrent: () => boolean = () => true) => {
      const sessionId = navigationStore.getSnapshot().activeChat;
      if (!sessionId) throw new Error('Open a conversation before attaching.');
      if (!scope || !scope.isCurrent())
        throw new Error('Reconnect to this Station before attaching.');
      const boundScope = {
        ...scope,
        isCurrent: () =>
          isCurrent() &&
          scope.isCurrent() &&
          navigationStore.getSnapshot().activeChat === sessionId,
      };
      return async (files: File[]) => {
        const result = await requestConversationFileIntake(
          boundScope,
          sessionId,
          files,
          () => {
            showChatPageOrDock(() => navigation.setDockState(true));
          },
          { allOrNothing: true },
        );
        if (result.errors.length || result.added !== files.length)
          throw new Error(
            result.errors[0] ?? 'Some attachments could not be added.',
          );
      };
    },
    [navigation, scope],
  );
}
