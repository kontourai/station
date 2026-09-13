/** Host-neutral mobile inspection. Identifiers never carry host paths or credentials. */
export type MobileDevicePlatform = 'ios' | 'android';

export interface MobileDeviceTarget {
  hostId: string;
  platform: MobileDevicePlatform;
  deviceId: string;
}

export interface MobileDeviceSummary extends MobileDeviceTarget {
  name: string;
  runtime: string;
  booted: boolean;
}

export type MobileDeviceHostFailure =
  | 'not-configured'
  | 'invalid-configuration'
  | 'hub-unavailable'
  | 'invalid-response'
  | 'response-too-large'
  | 'busy';

export interface MobileDeviceInventory {
  hostId: string;
  state: 'ready' | 'partial' | 'unavailable';
  observedAt: string;
  devices: MobileDeviceSummary[];
  failure?: MobileDeviceHostFailure;
}

/** One captured frame, not stream health or proof of the foreground app's identity. */
export interface MobileDeviceCapture {
  captureId: string;
  target: MobileDeviceTarget;
  capturedAt: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  pngBase64: string;
}
