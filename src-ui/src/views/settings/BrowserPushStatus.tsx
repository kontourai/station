import { Button } from '../../components/Button';
import { CheckGlyph } from '../../components/icons/Glyph';
import { usePushNotificationsState } from '../../contexts/PushNotificationsContext';

export function BrowserPushStatus() {
  const notifications = usePushNotificationsState();

  if (!notifications.supported) {
    return notifications.error ? (
      <div className="settings__notif-error" role="alert">
        {notifications.error}
      </div>
    ) : null;
  }

  return (
    <div className="settings__notif-subscribe">
      {notifications.subscribed ? (
        <div className="settings__notif-subscribed">
          <span className="settings__notif-status">
            <CheckGlyph /> Subscribed to push notifications
          </span>
          <Button type="button" size="sm" onClick={notifications.unsubscribe}>
            Unsubscribe
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          onClick={notifications.subscribe}
          disabled={notifications.permission === 'denied'}
        >
          {notifications.permission === 'denied'
            ? 'Notifications blocked by browser'
            : 'Enable push notifications'}
        </Button>
      )}
      {notifications.error && (
        <div className="settings__notif-error">{notifications.error}</div>
      )}
    </div>
  );
}
