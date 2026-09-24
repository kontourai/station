/**
 * What the float-over-chat mirrors (#90 D9): one live surface, typed by the
 * kind of thing it is — a Browser session, or a Device session (a simulator
 * or emulator on a device host).
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
      /**
       * The device's identity, the same three fields D12 shares are keyed
       * by: the device host (`local` or an SSH device host), the platform,
       * and the device id on that host.
       */
      readonly hostId: string;
      readonly platform: 'ios' | 'android';
      readonly deviceId: string;
      /** The device session's live surface (a reopened session has a new one). */
      readonly surfaceId: string;
      /**
       * The Project the person was viewing the device under when they
       * floated it (null: none — the operator needs none). The float reads
       * with THIS Project, not the chat's: a device shared with Project A is
       * still viewable from a chat in Project B, and the server still
       * authorizes that Project for this caller on every read (D12).
       */
      readonly projectSlug: string | null;
      /** What to call it before (or without) a session read: "iPhone 17 Pro". */
      readonly name: string;
    };

export type DeviceFloatSource = Extract<FloatSource, { kind: 'device' }>;

/**
 * The source's identity, stable across a reopen: a Browser session keeps
 * its id when its browser restarts and its surface id changes, a device is
 * the same device whichever session streams it, and either is still the
 * same thing the user dismissed or has open in a pane.
 */
export function floatSourceKey(source: FloatSource): string {
  return source.kind === 'browser'
    ? browserFloatSourceKey(source.browserSessionId)
    : deviceFloatSourceKey(source);
}

/** The key a Browser pane showing `browserSessionId` announces. */
export function browserFloatSourceKey(browserSessionId: string): string {
  return `browser:${browserSessionId}`;
}

/** The key a Device pane showing this device announces. */
export function deviceFloatSourceKey(device: {
  hostId: string;
  platform: 'ios' | 'android';
  deviceId: string;
}): string {
  return `device:${encodeURIComponent(device.hostId)}:${device.platform}:${encodeURIComponent(device.deviceId)}`;
}
