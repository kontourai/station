import { navigationStore } from '../contexts/NavigationContext';
import { notificationOpenTarget } from './notificationOpen';

export function openApprovalConversation(href: string): void {
  const target = notificationOpenTarget(href);
  if (!target) return;
  const sessionId = target.params.session;
  if (target.params.surface === 'activity' && sessionId) {
    navigationStore.navigate('/', { chat: sessionId, dock: 'open' });
    return;
  }
  navigationStore.navigate(target.pathname, target.params);
}
