import type {
  LiveSurfaceDeviceButton,
  LiveSurfaceOrientation,
} from '@kontourai/station-contracts/live-surface';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { HomeGlyph } from '../../components/icons/Glyph';
import type { LiveSurfaceHeaderApi } from '../../live-surface/LiveSurfaceCanvas';
import { BackGlyph, RecentsGlyph, RotateGlyph } from '../deviceGlyphs';

/** Rotate turns a quarter clockwise from where the device is now. */
export const NEXT_ORIENTATION: Record<
  LiveSurfaceOrientation,
  LiveSurfaceOrientation
> = {
  portrait: 'landscape-left',
  'landscape-left': 'portrait-upside-down',
  'portrait-upside-down': 'landscape-right',
  'landscape-right': 'portrait',
};

/**
 * A device's hardware in the full-screen bar (the pane's and the float's):
 * Home, and Back and Recents on Android or Rotate on iOS, as the pane's own
 * toolbar offers them. Each sends through the surface's own input (and so
 * its lease), and is disabled exactly while that input is down.
 */
export function DeviceImmersiveActions({
  api,
  platform,
}: {
  api: LiveSurfaceHeaderApi;
  platform: 'ios' | 'android';
}) {
  const { surface, inputReady, sendInput } = api;
  const press = (button: LiveSurfaceDeviceButton) =>
    sendInput([{ kind: 'device-button', button }]);
  const orientation = surface.producerStatus.orientation ?? 'portrait';
  const className = 'live-surface-controls__action live-surface-controls__icon';
  const action = (label: string, glyph: ReactNode, run: () => void) => (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      aria-label={label}
      title={label}
      disabled={!inputReady}
      onClick={run}
    >
      {glyph}
    </Button>
  );
  return (
    <>
      {action('Home', <HomeGlyph />, () => press('home'))}
      {platform === 'android' ? (
        <>
          {action('Back', <BackGlyph />, () => press('back'))}
          {action('Recents', <RecentsGlyph />, () => press('recents'))}
        </>
      ) : (
        action('Rotate', <RotateGlyph />, () =>
          sendInput([
            { kind: 'rotate', orientation: NEXT_ORIENTATION[orientation] },
          ]),
        )
      )}
    </>
  );
}
