import { LazyBoundary } from '../LazyBoundary';
import { SkeletonList } from '../state';
import type { PluginFrameHostProps } from './PluginFrameHost';

/**
 * Builds an isolated plugin pane element without pulling `PluginFrameHost`
 * onto the entry chunk (archive#2467's ratchet): the host is imported only
 * when a remote Station actually renders a plugin Pane. `LazyBoundary` also
 * contains a rejected chunk fetch with a retry instead of letting an
 * unhandled rejection escape through the workspace pane tree.
 */
// Stable module-scope loader — an inline loader re-suspends the frame on
// every parent render (archive#2605 class).
const loadPluginFrameHost = () =>
  import('./PluginFrameHost').then((module) => ({
    default: module.PluginFrameHost,
  }));

export function isolatedPluginLayout(props: PluginFrameHostProps) {
  return (
    <LazyBoundary<PluginFrameHostProps>
      load={loadPluginFrameHost}
      componentProps={props}
      pending={<SkeletonList count={3} label="Loading extension" />}
    />
  );
}
