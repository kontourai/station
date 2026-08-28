/**
 * @vitest-environment jsdom
 */
import { describe, expect, test } from 'vitest';
import {
  ACKNOWLEDGE_ATTENTION_ACTION,
  DISMISS_NOTIFICATION_ACTION,
} from '../notificationRowActions';

/**
 * archive#3779. These pin the MEASURED mechanism, not the HTTP verb: the row
 * action's `DELETE /notifications/:id` sets `status: 'dismissed'` and keeps
 * the record (`NotificationService.dismiss`), verified live — the request
 * answers 200 and the row is still on the page and still in
 * `GET /notifications`.
 *
 * The point of asserting it here is that this file is where the page's words
 * are chosen, so a future rename cannot claim a destruction the server does
 * not perform without this going red.
 */
describe('the notification row action model', () => {
  test('neither mechanism destroys a record', () => {
    expect(ACKNOWLEDGE_ATTENTION_ACTION.destroys).toBe(false);
    expect(DISMISS_NOTIFICATION_ACTION.destroys).toBe(false);
  });

  test('they differ in whether the fact can surface again by itself', () => {
    // An attention item is a projection: the same session failing again
    // re-derives it unacknowledged. A dismissed notification is terminal for
    // its dedupe tag — `schedule` refuses to re-raise it.
    expect(ACKNOWLEDGE_ATTENTION_ACTION.reversibleByFact).toBe(true);
    expect(DISMISS_NOTIFICATION_ACTION.reversibleByFact).toBe(false);
  });

  test('both read "Dismiss", because both dismiss', () => {
    expect(ACKNOWLEDGE_ATTENTION_ACTION.label).toBe('Dismiss');
    expect(DISMISS_NOTIFICATION_ACTION.label).toBe('Dismiss');
  });

  test('the mechanisms are distinguishable even where the words are not', () => {
    // The DRY half of #3779 that survives: two mechanisms, named once, so a
    // vocabulary decision changes one file rather than five call sites.
    expect(ACKNOWLEDGE_ATTENTION_ACTION.mechanism).not.toBe(
      DISMISS_NOTIFICATION_ACTION.mechanism,
    );
  });
});
