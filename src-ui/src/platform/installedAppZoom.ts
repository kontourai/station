/**
 * Page zoom in the installed app.
 *
 * In a browser tab Station keeps pinch zoom (index.css only stops Safari's
 * focus-triggered zoom on small inputs). The installed app — the native iOS
 * or Android shell, or a home-screen web app in standalone display mode —
 * behaves like an app instead: no pinch or double-tap page zoom.
 *
 * Three layers, because each engine honours a different one:
 * - the viewport meta (`maximum-scale=1, user-scalable=no`) for Android
 *   WebView and WKWebView,
 * - `touch-action: pan-x pan-y` on the root (`html.is-zoom-locked`), which
 *   current Safari and Chromium apply to pinch and double-tap,
 * - and a cancelled `gesturestart` for older iOS Safari standalone apps.
 */

const LOCKED_CLASS = 'is-zoom-locked';
const LOCK_PARTS = ['maximum-scale=1', 'user-scalable=no'] as const;

/** A home-screen web app, as opposed to a browser tab. */
export function isStandaloneDisplay(win: Window = window): boolean {
  const iosStandalone = (win.navigator as Navigator & { standalone?: boolean })
    .standalone;
  if (iosStandalone === true) return true;
  return (
    typeof win.matchMedia === 'function' &&
    (win.matchMedia('(display-mode: standalone)').matches ||
      win.matchMedia('(display-mode: fullscreen)').matches)
  );
}

function viewportContent(content: string, locked: boolean): string {
  const parts = content
    .split(',')
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        !/^maximum-scale\s*=/i.test(part) &&
        !/^user-scalable\s*=/i.test(part),
    );
  return (locked ? [...parts, ...LOCK_PARTS] : parts).join(', ');
}

const cancelGesture = (event: Event) => event.preventDefault();

/** Locks or releases page zoom; idempotent. Returns the release. */
export function setInstalledAppZoomLock(
  locked: boolean,
  doc: Document = document,
): () => void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = viewportContent(meta.content, locked);
  doc.documentElement.classList.toggle(LOCKED_CLASS, locked);
  if (locked) doc.addEventListener('gesturestart', cancelGesture);
  else doc.removeEventListener('gesturestart', cancelGesture);
  return () => {
    if (locked) setInstalledAppZoomLock(false, doc);
  };
}
