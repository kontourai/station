// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AttentionSection } from '../components/attention/AttentionSection';
import { NotificationSection } from '../components/notifications/NotificationSection';

vi.mock('../hooks/useNotificationAnswerability', () => ({
  useNotificationAnswerability: () => vi.fn(),
}));

afterEach(cleanup);

describe('notification history empty states', () => {
  test.each([false, true])(
    'renders both empty lanes with filtered=%s',
    (filtered) => {
      render(
        <>
          <AttentionSection
            items={[]}
            pendingTotal={0}
            pendingVisible={0}
            filtered={filtered}
          />
          <NotificationSection
            notifications={[]}
            onDismiss={vi.fn()}
            filtered={filtered}
          />
        </>,
      );
      expect(
        screen.getByText(
          filtered ? 'No matching attention' : 'Nothing needs you right now',
        ),
      ).not.toBeNull();
      expect(
        screen.getByText(filtered ? 'No matching activity' : 'No activity yet'),
      ).not.toBeNull();
    },
  );
});
