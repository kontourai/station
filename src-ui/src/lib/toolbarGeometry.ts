/**
 * The vertical space the app toolbar actually occupies, in CSS pixels.
 *
 * The toolbar pads itself down by the top safe-area inset, so its occupied
 * height is the inset plus its nominal height. CSS gets that from
 * `--app-toolbar-total-height`, but JavaScript cannot: `getPropertyValue` on an
 * unregistered custom property returns the raw token text, so reading a
 * `calc(...)` token and `parseInt`-ing it yields `NaN`. Measuring the element
 * sidesteps the whole problem and stays correct if the toolbar's padding ever
 * changes again.
 */
export function readToolbarHeight(): number {
  if (typeof document === 'undefined') return 0;

  const toolbar = document.querySelector('.app-toolbar');
  if (toolbar) {
    const { height } = toolbar.getBoundingClientRect();
    if (height > 0) return height;
    // A full-screen mobile chat hides the toolbar outright
    // (`app__main--mobile-dock-fullscreen`). It then occupies nothing but the
    // safe-area inset, which is exactly what the CSS in that mode reduces
    // `--app-toolbar-total-height` to — so agree with it instead of falling
    // through to the pre-mount fallback and over-reserving a whole 52px bar.
    // Checked explicitly rather than inferred from `height === 0`, because a
    // jsdom test has no layout and must still get the summed fallback below.
    if (getComputedStyle(toolbar).display === 'none') {
      return (
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--safe-top',
          ),
        ) || 0
      );
    }
  }

  // Before the toolbar mounts (or in a jsdom test with no layout), fall back to
  // summing the parts rather than reading the composite token.
  const styles = getComputedStyle(document.documentElement);
  const px = (name: string) =>
    Number.parseFloat(styles.getPropertyValue(name)) || 0;
  return px('--safe-top') + px('--app-toolbar-height');
}
