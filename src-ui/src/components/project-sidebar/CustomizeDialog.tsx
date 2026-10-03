import { APP_DESTINATION_REGISTRY } from '../../app-shell/destination-registry';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { Dialog } from '../Dialog';
import { destinationIcon } from './nav-items';
import './CustomizeDialog.css';

export function CustomizeDialog({
  onClose,
  onNavigate,
  returnFocusTarget,
}: {
  onClose: () => void;
  onNavigate: (path: string) => void;
  returnFocusTarget?: HTMLElement | null;
}) {
  const entries = APP_DESTINATION_REGISTRY.getCustomizeNav(
    useSurfaceVisibilityFlags(),
  );
  return (
    <Dialog
      title="Customize"
      closeLabel="Close Customize"
      onClose={onClose}
      returnFocusTarget={returnFocusTarget}
      size="sm"
    >
      <nav aria-label="Customize Station" className="customize-dialog__links">
        {entries.map((entry) => {
          const destination = APP_DESTINATION_REGISTRY.get(entry.id);
          return (
            <a
              key={entry.id}
              href={entry.route}
              className="customize-dialog__link"
              onClick={(event) => {
                if (
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onNavigate(entry.route);
              }}
            >
              {destination?.icon ? destinationIcon(destination.icon) : null}
              <span>{entry.label}</span>
              <span aria-hidden="true">›</span>
            </a>
          );
        })}
      </nav>
    </Dialog>
  );
}
