import { useOptionalShortcutRegistry } from '../../contexts/KeyboardShortcutsContext';
import { KERNEL_RESERVED_SHORTCUTS } from '../../contexts/kernelReservedShortcuts';
import { useIsMobile } from '../../hooks/useIsMobile';
import { SearchGlyph } from '../icons/Glyph';

const LABEL = 'Search or jump to…';

/**
 * The visible way into the command palette (#4694). Before this the palette
 * opened only from its keyboard shortcut, so a phone or tablet without a
 * keyboard could not reach it.
 *
 * The button passes itself as the trigger: a tapped button is not focused on
 * every touch platform, and the palette returns focus to whatever opened it.
 * On a phone it is a glyph-only control so the toolbar row keeps its width;
 * both are named "Search or jump to…".
 */
export function CommandPaletteEntry() {
  const isMobile = useIsMobile();
  const display =
    useOptionalShortcutRegistry()?.getDisplay(
      KERNEL_RESERVED_SHORTCUTS.commandPalette.id,
    ) ?? '';
  // The current binding, which Settings can change or clear. The header also
  // renders in fixtures without the shortcut provider; it shows no chord there.
  const chord = display && display !== 'Not set' ? display : '';
  return (
    <button
      type="button"
      className={
        isMobile
          ? 'app-toolbar__icon-btn app-toolbar__palette-entry app-toolbar__palette-entry--compact'
          : 'app-toolbar__palette-entry'
      }
      // The phone glyph needs a name; the pill's visible text is its name,
      // shortcut included, so it is not overridden.
      aria-label={isMobile ? LABEL : undefined}
      aria-haspopup="dialog"
      title={isMobile || !chord ? LABEL : `${LABEL} (${chord})`}
      onClick={(event) =>
        window.dispatchEvent(
          new CustomEvent('open-command-palette', {
            detail: { trigger: event.currentTarget },
          }),
        )
      }
    >
      <SearchGlyph />
      {!isMobile && (
        <>
          <span className="app-toolbar__palette-entry-label">{LABEL}</span>
          {chord && (
            <kbd className="app-toolbar__palette-entry-chord">{chord}</kbd>
          )}
        </>
      )}
    </button>
  );
}
