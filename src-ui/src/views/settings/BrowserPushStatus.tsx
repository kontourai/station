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
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={notifications.unsubscribe}
          >
            Unsubscribe
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={notifications.subscribe}
          disabled={notifications.permission === 'denied'}
        >
          {notifications.permission === 'denied'
            ? 'Notifications blocked by browser'
            : 'Enable push notifications'}
        </button>
      )}
      {notifications.error && (
        <div className="settings__notif-error">{notifications.error}</div>
      )}
    </div>
  );
}
