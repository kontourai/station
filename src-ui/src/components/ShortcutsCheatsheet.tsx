import './ShortcutsCheatsheet.css';
import {
  findShortcutConflicts,
  listedShortcuts,
  useShortcutRegistry,
} from '../contexts/KeyboardShortcutsContext';
import { Dialog } from './Dialog';
import { groupShortcuts } from './shortcuts-cheatsheet-utils';
import { Empty } from './state';

interface ShortcutsCheatsheetProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutsCheatsheet({
  isOpen,
  onClose,
}: ShortcutsCheatsheetProps) {
  const { getAllShortcuts, getDisplay } = useShortcutRegistry();

  if (!isOpen) return null;

  const shortcuts = getAllShortcuts();
  const groups = groupShortcuts(listedShortcuts(shortcuts));
  const conflicts = findShortcutConflicts(shortcuts).filter(
    (conflict) => conflict.ambiguous,
  );

  return (
    /*
     * archive#3759: this was the one dialog surface in the app that hand-rolled
     * its own frame — its own backdrop, its own `role="dialog" aria-modal`, and
     * its own `window` keydown listener for Escape. Two window listeners for
     * one key is a race with no owner: the registry's route-level "go up one
     * level" fallback and this one both fired, so Escape from `/settings` both
     * closed the sheet and navigated the route out from under it. The shared
     * surface owns Escape (and the focus trap, focus restoration, backdrop
     * dismissal, and mobile keyboard containment) for every other dialog; it
     * owns this one now too, and the duplicate listener is gone rather than
     * ordered against.
     *
     * #4384: the `.modal-content` / `.modal-header` chrome this used lost its
     * styles, so the sheet rendered with no panel at all — rows floating over
     * the page, the close button under the title, the list cut off. `Dialog`
     * is the one Station dialog chrome: an opaque framed panel, a header close
     * button, and a body that scrolls.
     */
    <Dialog
      title="Keyboard shortcuts"
      closeLabel="Close keyboard shortcuts"
      onClose={onClose}
      initialFocusPolicy="panel"
      panelClassName="shortcuts-cheatsheet"
    >
      <div className="shortcuts-cheatsheet__body">
        {conflicts.length > 0 ? (
          <p className="shortcuts-cheatsheet__conflicts" role="alert">
            {conflicts.length === 1
              ? 'One chord is claimed twice with equal priority: '
              : `${conflicts.length} chords are claimed twice with equal priority: `}
            {conflicts
              .map(
                (conflict) =>
                  `${conflict.chord} (${conflict.shortcuts
                    .map((shortcut) => shortcut.description)
                    .join(' vs ')})`,
              )
              .join('; ')}
            . Which one fires depends on registration order.
          </p>
        ) : null}
        {groups.length === 0 ? (
          <Empty
            variant="compact"
            label="No keyboard shortcuts are available right now."
          />
        ) : (
          groups.map((group) => (
            <div key={group.label} className="shortcuts-cheatsheet__group">
              <h3 className="shortcuts-cheatsheet__category">{group.label}</h3>
              <div className="shortcuts-cheatsheet__list">
                {group.items.map((shortcut) => (
                  <div key={shortcut.id} className="shortcuts-cheatsheet__row">
                    <span className="shortcuts-cheatsheet__desc">
                      {shortcut.description}
                    </span>
                    <kbd className="shortcuts-cheatsheet__kbd">
                      {getDisplay(shortcut.id)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
