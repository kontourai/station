/**
 * What the float-over-chat mirrors (#90 D9): one live surface, typed by the
 * kind of thing it is. The Browser source is complete; the Device source is
 * declared so the shell, the store and "hidden while in a pane" are already
 * shaped for it, and the Device batch wires its player.
 */
export type FloatSource =
  | {
      readonly kind: 'browser';
      /** The server-owned session: the source's identity. */
      readonly browserSessionId: string;
      /** The session's live surface while it is live (it changes on reopen). */
      readonly surfaceId: string;
    }
  | {
      readonly kind: 'device';
      // TODO(#90 device batch): the Device pane's identity for a device
      // stream (host, device, platform) and its live surface id. The shell
      // renders nothing for this kind until that batch adds its player.
      readonly hostId: string;
      readonly deviceId: string;
      readonly surfaceId: string;
    };

/**
 * The source's identity, stable across a reopen: a Browser session keeps
 * its id when its browser restarts and its surface id changes, and it is
 * still the same thing the user dismissed or has open in a pane.
 */
export function floatSourceKey(source: FloatSource): string {
  return source.kind === 'browser'
    ? `browser:${source.browserSessionId}`
    : `device:${encodeURIComponent(source.hostId)}:${encodeURIComponent(source.deviceId)}`;
}

/** The key a Browser pane showing `browserSessionId` announces. */
export function browserFloatSourceKey(browserSessionId: string): string {
  return `browser:${browserSessionId}`;
}
