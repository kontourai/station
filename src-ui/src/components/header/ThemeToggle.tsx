import { useCallback, useLayoutEffect } from 'react';
import { useDeviceSettingsActions } from '../../contexts/DeviceSettingsContext';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import {
  useKeyboardShortcut,
  useShortcutDisplay,
} from '../../hooks/useKeyboardShortcut';
import { useResolvedThemeMode } from '../../hooks/useResolvedThemeMode';
import { MoonGlyph, SunGlyph } from '../icons/Glyph';

export function ThemeToggle() {
  // The mode on screen, which System takes from the device (#4407).
  const theme = useResolvedThemeMode();
  const { setDeviceSetting } = useDeviceSettingsActions();

  // `main.tsx`'s pre-render fast path already sets `data-theme` before first
  // paint (no flash); this effect keeps the DOM attribute in sync with live
  // toggles for the lifetime of the page.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // The toggle is an explicit choice of the other mode, which leaves System.
  const toggleTheme = useCallback(() => {
    setDeviceSetting('theme', theme === 'dark' ? 'light' : 'dark');
  }, [theme, setDeviceSetting]);

  useKeyboardShortcut(
    'theme.toggle',
    'h',
    ['cmd'],
    'Toggle theme',
    toggleTheme,
  );
  const shortcut = useShortcutDisplay('theme.toggle');

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={withShortcutHint(
        `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`,
        'theme.toggle',
        () => shortcut,
      )}
    >
      {theme === 'dark' ? <SunGlyph /> : <MoonGlyph />}
    </button>
  );
}
