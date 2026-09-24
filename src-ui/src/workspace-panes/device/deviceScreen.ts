import type { MobileDevicePlatform } from '@kontourai/station-contracts/mobile-device';

/**
 * How a device screen is drawn, shared by the Device pane and the
 * float-over-chat's Device source (#90 D9), so both show the same phone
 * shape and label without either importing the other's chunk.
 */

const PLATFORM_LABEL = { ios: 'iOS', android: 'Android' } as const;

/**
 * "iOS 26.5". The device hub already reports the runtime WITH its platform
 * ("iOS 26.5", "Android 16": `mobile-device-host.ts` passes `version`
 * through), so it is shown as given; a bare version ("26.5") gets the
 * platform in front, and a platform is never said twice.
 */
export function deviceOsLabel(device: {
  platform: MobileDevicePlatform;
  runtime: string;
}): string {
  const platform = PLATFORM_LABEL[device.platform];
  const runtime = device.runtime.trim();
  return runtime.toLowerCase().startsWith(platform.toLowerCase())
    ? runtime
    : `${platform} ${runtime}`;
}

/**
 * The phone shape shown before the first frame arrives (width / height).
 * The first frame's own size replaces it; these only keep the stage from
 * jumping from a square to a phone.
 */
export const DEVICE_PLACEHOLDER_ASPECT: Record<MobileDevicePlatform, number> = {
  ios: 9 / 19.5,
  android: 9 / 20,
};

/** The stage's rounded clip: Android scales with the screen, iOS is fixed. */
export function deviceCornerRadius(
  platform: MobileDevicePlatform,
  box: { width: number; height: number },
): number {
  return platform === 'android'
    ? Math.round(0.14 * Math.min(box.width, box.height))
    : 12;
}
