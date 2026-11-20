import { navigationStore } from '../contexts/NavigationContext';
import { notificationOpenTarget } from './notificationOpen';

/**
 * Opens an approval's session in the dock. A stored Chat-surface link
 * (`/?surface=chat&session=…`, which `activityDeepLink` emits since #4904,
 * or its legacy `surface=activity` spelling) opens the same dock chat the
 * notification href (`notificationSessionHref`) does.
 */
export function openApprovalConversation(href: string): void {
  const target = notificationOpenTarget(href);
  if (!target) return;
  const sessionId = target.params.session;
  const surface = target.params.surface;
  if ((surface === 'chat' || surface === 'activity') && sessionId) {
    navigationStore.navigate('/', { chat: sessionId, dock: 'open' });
    return;
  }
  navigationStore.navigate(target.pathname, target.params);
}
