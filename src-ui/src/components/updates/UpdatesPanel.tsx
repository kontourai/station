import { useEffect, useId, useRef } from 'react';
import { readClientReleaseVersion } from '../../build-info';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { ConnectedServerUpdates } from '../../views/settings/ConnectedServerUpdates';
import { DesktopUpdateCheck } from '../../views/settings/DesktopUpdateCheck';
import { settingsDeepLinkUrl } from '../../views/settings/settings-deep-link';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { type UpdateTarget, useUpdateNotices } from './updatesEvents';
import '../../views/SettingsView.css';

export function UpdatesPanel({
  open,
  onClose,
  onNavigate,
  returnFocusTarget,
  target,
  requestSequence,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
  returnFocusTarget: HTMLElement | null;
  target?: UpdateTarget;
  requestSequence: number;
}) {
  const profile = usePlatformProfile();
  const notices = useUpdateNotices();
  const desktopRef = useRef<HTMLElement>(null);
  const serverRef = useRef<HTMLElement>(null);
  const id = useId();
  // biome-ignore lint/correctness/useExhaustiveDependencies: A repeated open request should focus its section again.
  useEffect(() => {
    if (open && target)
      (target === 'desktop' ? desktopRef : serverRef).current?.focus();
  }, [open, target, requestSequence]);
  const noticesFor = (section: UpdateTarget) =>
    notices
      .filter((notice) => notice.target === section)
      .map((notice) => (
        <div key={notice.id} className="updates-panel__notice">
          <p role="status">{notice.message}</p>
          {notice.detail && <p>{notice.detail}</p>}
          {notice.href && (
            <a href={notice.href} target="_blank" rel="noopener noreferrer">
              {notice.actionLabel ?? 'View release'}
            </a>
          )}
          {!notice.href && notice.onAction && (
            <Button onClick={notice.onAction}>
              {notice.actionLabel ?? 'Try again'}
            </Button>
          )}
        </div>
      ));
  return (
    <Dialog
      open={open}
      title="Updates"
      closeLabel="Close Updates"
      onClose={onClose}
      returnFocusTarget={returnFocusTarget}
      size="md"
      footer={
        <Button
          onClick={() =>
            onNavigate(
              settingsDeepLinkUrl({
                view: 'system',
                highlight:
                  target === 'desktop'
                    ? 'desktop-app-updates'
                    : 'core-app-updates',
              }),
            )
          }
        >
          Update policies and details
        </Button>
      }
    >
      <div className="updates-panel">
        {(profile.isDesktop ||
          profile.isMobile ||
          notices.some((notice) => notice.target === 'desktop')) && (
          <section
            ref={desktopRef}
            tabIndex={-1}
            aria-labelledby={`${id}-desktop`}
          >
            <h3 id={`${id}-desktop`}>
              {profile.isDesktop ? 'Desktop app' : 'Station app'}
            </h3>
            <p className="updates-panel__identity">
              {profile.isDesktop
                ? (profile.productName ?? 'Station')
                : (readClientReleaseVersion() ?? 'Version unavailable')}
              {profile.channel ? ` · ${profile.channel}` : ''}
            </p>
            {noticesFor('desktop')}
            {profile.isDesktop ? (
              <DesktopUpdateCheck showPolicy={false} />
            ) : (
              <p>
                Install app updates through your app distribution source. An
                available release link appears here after the app checks.
              </p>
            )}
          </section>
        )}
        <section ref={serverRef} tabIndex={-1} aria-labelledby={`${id}-server`}>
          <h3 id={`${id}-server`}>Connected server</h3>
          {noticesFor('server')}
          <ConnectedServerUpdates />
        </section>
      </div>
    </Dialog>
  );
}
