import { useEffect, useState } from 'react';
import type { ContextMenuPoint } from '../hooks/useContextMenuGesture';
import { useCopyToClipboardToast } from '../hooks/useCopyToClipboardToast';
import { wantsNativeContextMenu } from '../lib/native-context-menu';
import { hasTauriRuntime } from '../platform/native';
import { ContextMenu } from './ContextMenu';

/** Links the app's own menu can act on: the ones a copy is useful for. */
function isWebLink(anchor: HTMLAnchorElement): boolean {
  return anchor.protocol === 'http:' || anchor.protocol === 'https:';
}

/**
 * The desktop and mobile apps' answer to the WebView's own context menu.
 *
 * In a browser tab that menu is the browser's, and Station leaves it alone. In
 * the Tauri app it is the WebView's: page commands such as Reload (which drops
 * a running chat's stream and every unsaved draft in the window) and — in a nightly or
 * dev build, which ships the inspector — Inspect Element. None of those is a
 * command a user means to give the app, so a right-click that no control
 * claimed opens nothing here.
 *
 * What still reaches the native menu is the rule in `wantsNativeContextMenu`:
 * selected text, an editable field, and Shift+right-click, which is the
 * deliberate route to Inspect Element where the build has it. A control that
 * opens its own menu prevents the event first, and this listener (bubble
 * phase, on the document, after React's root listener) leaves it alone.
 *
 * A web link gets a small menu of its own — Open link, Copy link — because the
 * WebView's link menu is the worst of the set: its Open Link navigates the app
 * window itself away from Station. "Open link" is a click on the anchor, so it
 * goes wherever a left-click on that link goes (a chat link's pane, the
 * system browser); there is no second routing rule to drift from the first.
 */
export function NativeContextMenuGuard() {
  const [linkMenu, setLinkMenu] = useState<{
    at: ContextMenuPoint;
    anchor: HTMLAnchorElement;
  } | null>(null);
  const copy = useCopyToClipboardToast();

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented || wantsNativeContextMenu(event)) return;
      event.preventDefault();
      const target = event.target;
      const anchor =
        target instanceof Element
          ? target.closest<HTMLAnchorElement>('a[href]')
          : null;
      if (anchor && isWebLink(anchor)) {
        setLinkMenu({ at: { x: event.clientX, y: event.clientY }, anchor });
      }
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);

  if (!linkMenu) return null;
  const { anchor } = linkMenu;
  return (
    <ContextMenu
      at={linkMenu.at}
      label="Link actions"
      onClose={() => setLinkMenu(null)}
      actions={[
        {
          key: 'open',
          label: 'Open link',
          onSelect: () => {
            if (anchor.isConnected) anchor.click();
          },
        },
        {
          key: 'copy',
          label: 'Copy link',
          onSelect: () => {
            void copy(anchor.href);
          },
        },
      ]}
    />
  );
}
