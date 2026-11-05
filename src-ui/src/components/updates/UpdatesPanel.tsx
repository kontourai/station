import { useEffect, useId, useRef } from 'react';
import { usePlatformProfile } from '../../platform/PlatformProfileContext';
import { ConnectedServerUpdates } from '../../views/settings/ConnectedServerUpdates';
import { DesktopUpdateCheck } from '../../views/settings/DesktopUpdateCheck';
import { settingsDeepLinkUrl } from '../../views/settings/settings-deep-link';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ChangelogPreference } from './ChangelogPreference';
import { ReleaseHistory, ReleaseNotes } from './ReleaseNotes';
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
      // A summary-only notice drives the Updates control status; the
      // section already states the same fact itself.
      .filter((notice) => notice.target === section && !notice.summaryOnly)
      .map((notice) => (
        <div key={notice.id} className="updates-panel__notice">
          <p role="status">{notice.message}</p>
          {notice.detail && <p>{notice.detail}</p>}
          {!profile.isDesktop &&
            notice.target === 'desktop' &&
            notice.releaseVersion && (
              <ReleaseNotes
                version={notice.releaseVersion}
                nativeApp
                active={open}
              />
            )}
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
      <div className="updates-panel content-stack content-stack--sections">
        {(profile.isDesktop ||
          profile.isMobile ||
          notices.some((notice) => notice.target === 'desktop')) && (
          <section
            ref={desktopRef}
            tabIndex={-1}
            aria-labelledby={`${id}-desktop`}
          >
            {!profile.isDesktop && <h3 id={`${id}-desktop`}>Station app</h3>}
            {noticesFor('desktop')}
            {profile.isDesktop && (
              <DesktopUpdateCheck
                active={open}
                showPolicy={false}
                showReleaseNotes
                headingId={`${id}-desktop`}
              />
            )}
          </section>
        )}
        <section ref={serverRef} tabIndex={-1} aria-labelledby={`${id}-server`}>
          <ConnectedServerUpdates
            active={open}
            showReleaseNotes
            headingId={`${id}-server`}
            notices={noticesFor('server')}
          />
        </section>
        <ReleaseHistory
          active={open}
          nativeApp={profile.isDesktop || profile.isMobile}
        />
        <ChangelogPreference />
      </div>
    </Dialog>
  );
}
