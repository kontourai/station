import { useConnections } from '@kontourai/station-connect';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import {
  getNotificationOpenNotice,
  installNotificationOpener,
  type NotificationOpenNotice,
  notificationLinkRequest,
  openNotificationTarget,
  requestNotificationOpen,
  setNotificationOpenNotice,
  subscribeToNotificationOpenNotice,
} from '../../lib/notificationStationOpen';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { ErrorState } from '../state';
import './NotificationStationOpener.css';

/**
 * How long a tap waits for the active Station's verified id before it is
 * opened without it (on the active Station, as an older Station's would be).
 */
const IDENTITY_WAIT_MS = 8_000;

/** The message `sw.js` posts to an open tab for a notification tap. */
export const SERVICE_WORKER_OPEN_MESSAGE = 'station-notification-open';

/**
 * Turns a Web Push tap the service worker hands to this tab into an open
 * request: the worker sends the link's absolute URL on this origin and a
 * port to acknowledge on, and falls back to navigating the tab when no
 * acknowledgement comes (an older bundle, or this one not loaded yet).
 */
export function serviceWorkerOpenRequest(
  data: unknown,
  origin: string,
): ReturnType<typeof notificationLinkRequest> {
  if (typeof data !== 'object' || data === null) return null;
  const { type, url } = data as Record<string, unknown>;
  if (type !== SERVICE_WORKER_OPEN_MESSAGE || typeof url !== 'string')
    return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  return notificationLinkRequest(`${parsed.pathname}${parsed.search}`);
}

/**
 * The app's one notification opener: installs the entry point every
 * channel calls (`requestNotificationOpen`), answers the service worker's
 * tap messages, and shows what opening is doing.
 */
export function NotificationStationOpener() {
  const { connections, activeConnection, setActiveConnection } =
    useConnections();
  const { status, observation } = useAuthorityPersistence();
  const { navigate } = useNavigationActions();
  // A same-origin browser connection may never have saved its Station's id;
  // the verified authority observation is that id.
  const activeEnvironmentId =
    activeConnection?.environmentId ??
    (status === 'verified' ? observation?.environmentId : undefined) ??
    null;
  const latest = useRef({
    connections,
    activeConnection,
    setActiveConnection,
    activeEnvironmentId,
  });
  latest.current = {
    connections,
    activeConnection,
    setActiveConnection,
    activeEnvironmentId,
  };
  const [waitedForIdentity, setWaitedForIdentity] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setWaitedForIdentity(true),
      IDENTITY_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, []);
  // Taps wait (queued) until the active Station's id is known, so a link
  // from this very Station is not mistaken for another one's.
  const identitySettled =
    activeEnvironmentId !== null ||
    status === 'unavailable' ||
    waitedForIdentity;

  useEffect(
    () =>
      identitySettled
        ? installNotificationOpener((request) => {
            void openNotificationTarget(request, {
              connections: () => latest.current.connections,
              active: () => latest.current.activeConnection,
              activeEnvironmentId: () => latest.current.activeEnvironmentId,
              setActiveConnection: (id) =>
                latest.current.setActiveConnection(id),
              navigate: (pathname, params) => navigate(pathname, params),
            });
          })
        : undefined,
    [identitySettled, navigate],
  );

  useEffect(() => {
    const worker =
      typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      const request = serviceWorkerOpenRequest(
        event.data,
        window.location.origin,
      );
      if (!request) return;
      event.ports[0]?.postMessage({ handled: true });
      requestNotificationOpen(request);
    };
    worker.addEventListener('message', onMessage);
    // A listener added with addEventListener does not start the queue alone.
    worker.startMessages?.();
    return () => worker.removeEventListener('message', onMessage);
  }, []);

  const notice = useSyncExternalStore(
    subscribeToNotificationOpenNotice,
    getNotificationOpenNotice,
    () => null,
  );
  return notice ? <NotificationOpenNoticeView notice={notice} /> : null;
}

export function NotificationOpenNoticeView({
  notice,
}: {
  notice: NotificationOpenNotice;
}) {
  const dismiss = () => setNotificationOpenNotice(null);
  const manage = () => {
    dismiss();
    openConnectionsModal({ mode: 'list' });
  };
  if (notice.kind === 'switching')
    return (
      <div
        className="notification-station-notice notification-station-notice--pending"
        role="status"
      >
        <span className="notification-station-notice__progress" aria-hidden />
        <p className="notification-station-notice__line">
          Opening conversation on <strong>{notice.stationName}</strong>…
        </p>
      </div>
    );
  const copy = noticeCopy(notice);
  const retry =
    notice.kind === 'switch-failed' || notice.kind === 'unreachable'
      ? () => {
          dismiss();
          notice.retry();
        }
      : undefined;
  return (
    <div className="notification-station-notice">
      <ErrorState
        variant="default"
        title={copy.title}
        description={copy.description}
        action={
          <ActionRow
            label="Notification actions"
            overflowLabel="More notification actions"
            primary={
              retry ? (
                <Button variant="primary" size="sm" onClick={retry}>
                  Retry
                </Button>
              ) : copy.manage ? (
                <Button variant="primary" size="sm" onClick={manage}>
                  Manage Stations
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={dismiss}>
                  OK
                </Button>
              )
            }
            secondary={
              retry && copy.manage ? (
                <Button size="sm" onClick={manage}>
                  Manage Stations
                </Button>
              ) : retry || copy.manage ? (
                <Button size="sm" onClick={dismiss}>
                  Dismiss
                </Button>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}

function noticeCopy(
  notice: Exclude<NotificationOpenNotice, { kind: 'switching' }>,
): { title: string; description: string; manage: boolean } {
  switch (notice.kind) {
    case 'not-saved':
      return {
        title: 'Station not on this device',
        description:
          "The notification came from a Station that isn't saved here.",
        manage: true,
      };
    case 'switch-failed':
      return {
        title: `Couldn't switch to ${notice.stationName}`,
        description: 'The conversation was not opened.',
        manage: true,
      };
    case 'not-found':
      return {
        title: 'Conversation not found',
        description: 'It may have been deleted, or it is on another Station.',
        manage: false,
      };
    case 'forbidden':
      return {
        title: 'No access to this conversation',
        description: 'This device is not allowed to read it.',
        manage: true,
      };
    case 'unreachable':
      return {
        title: "Couldn't open the conversation",
        description: 'The Station did not answer.',
        manage: true,
      };
  }
}
