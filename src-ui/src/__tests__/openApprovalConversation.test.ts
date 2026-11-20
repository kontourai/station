// @vitest-environment jsdom
/**
 * An approval's stored Chat-surface link opens the dock chat the
 * notification href opens (#4904 renamed `surface=activity` to
 * `surface=chat`; both spellings must still reach the dock).
 */
import { describe, expect, test } from 'vitest';
import { navigationStore } from '../contexts/NavigationContext';
import { openApprovalConversation } from '../lib/openApprovalConversation';

function current() {
  const params = new URLSearchParams(window.location.search);
  return {
    pathname: window.location.pathname,
    chat: params.get('chat'),
    dock: params.get('dock'),
    surface: params.get('surface'),
  };
}

describe('openApprovalConversation', () => {
  test.each([
    '/?surface=chat&session=thread-1',
    '/?surface=activity&session=thread-1',
  ])('%s opens the session in the dock', (href) => {
    openApprovalConversation(href);
    expect(current()).toEqual({
      pathname: '/',
      chat: 'thread-1',
      dock: 'open',
      surface: null,
    });
    expect(navigationStore.getSnapshot().activeChat).toBe('thread-1');
  });

  test('the notification href opens as written', () => {
    openApprovalConversation('/projects/alpha?chat=thread-2&dock=open');
    expect(current()).toMatchObject({
      pathname: '/projects/alpha',
      chat: 'thread-2',
      dock: 'open',
    });
  });
});
