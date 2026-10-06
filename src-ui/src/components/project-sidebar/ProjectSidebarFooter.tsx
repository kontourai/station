import { useRef, useState } from 'react';
import {
  APP_DESTINATION_REGISTRY,
  type DestinationDefinition,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SettingsGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import './ProjectSidebarFooter.css';
import { destinationIcon } from './nav-items';
import { ProjectSidebarPresenceTray } from './ProjectSidebarPresenceTray';

const loadCustomizeDialog = () =>
  import('./CustomizeDialog').then((module) => ({
    default: module.CustomizeDialog,
  }));

function destination(id: string): DestinationDefinition {
  const entry = APP_DESTINATION_REGISTRY.get(id);
  if (!entry) throw new Error(`${id} destination is not registered`);
  return entry;
}
const SCHEDULE = destination('schedule');
const SETTINGS = destination('settings');

interface ProjectSidebarFooterProps {
  activePath: string;
  navigate: (path: string) => void;
  isMobile: boolean;
  onAfterNavigate?: () => void;
}

export function ProjectSidebarFooter({
  activePath,
  navigate,
  isMobile,
  onAfterNavigate,
}: ProjectSidebarFooterProps) {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const customizeTriggerRef = useRef<HTMLButtonElement>(null);
  const activeDestination = APP_DESTINATION_REGISTRY.getDestinationForView(
    resolveViewFromPath(activePath),
  );
  const go = (path: string) => {
    navigate(path);
    if (isMobile) onAfterNavigate?.();
  };
  return (
    <div className="sidebar__footer">
      <div className="sidebar__footer-meta">
        <ProjectSidebarPresenceTray
          onOpenActivity={isMobile ? onAfterNavigate : undefined}
        />
        <div className="sidebar__footer-actions">
          <button
            type="button"
            className={`sidebar__footer-action${activeDestination?.id === SCHEDULE.id ? ' sidebar__footer-action--active' : ''}`}
            aria-current={
              activeDestination?.id === SCHEDULE.id ? 'page' : undefined
            }
            aria-label="Schedule"
            title="Schedule"
            onClick={() => go(SCHEDULE.route)}
          >
            {destinationIcon('schedule')}
          </button>
          <button
            ref={customizeTriggerRef}
            type="button"
            className="sidebar__footer-action"
            aria-label="Customize"
            title="Customize"
            aria-haspopup="dialog"
            data-first-run-anchor="customize"
            onClick={() => setCustomizeOpen(true)}
          >
            {destinationIcon('plugins')}
          </button>
          <button
            type="button"
            className={`sidebar__footer-action${activeDestination?.id === SETTINGS.id ? ' sidebar__footer-action--active' : ''}`}
            aria-current={
              activeDestination?.id === SETTINGS.id ? 'page' : undefined
            }
            aria-label="Settings"
            title="Settings"
            onClick={() => go(SETTINGS.route)}
          >
            <SettingsGlyph />
          </button>
        </div>
      </div>
      {customizeOpen && (
        <LazyBoundary
          load={loadCustomizeDialog}
          pending={null}
          shareAcrossMounts
          unavailable={(retry) => (
            <Dialog
              title="Customize"
              closeLabel="Close Customize"
              onClose={() => setCustomizeOpen(false)}
              historyMode="none"
              returnFocusTarget={customizeTriggerRef.current}
              size="sm"
              footer={
                <>
                  <Button onClick={retry}>Retry</Button>
                  <Button
                    variant="secondary"
                    onClick={() => window.location.reload()}
                  >
                    Reload
                  </Button>
                </>
              }
            >
              <p role="alert">Could not load Customize.</p>
            </Dialog>
          )}
          componentProps={{
            returnFocusTarget: customizeTriggerRef.current,
            onClose: () => setCustomizeOpen(false),
            onNavigate: (path: string) => {
              setCustomizeOpen(false);
              go(path);
            },
          }}
        />
      )}
    </div>
  );
}
