import type { PlatformProfile } from './PlatformProfileContext';

/** Maps the trusted platform profile, never a user agent, to client origin. */
export function clientOriginSurfaceForProfile(
  profile: Pick<PlatformProfile, 'isDesktop' | 'isMobile'>,
): 'web' | 'desktop' | 'mobile' {
  return profile.isMobile ? 'mobile' : profile.isDesktop ? 'desktop' : 'web';
}

/**
 * Whether this UI is sitting on a machine that runs a Station server.
 * Phone Tauri is a client of some other Station; web and desktop supervise
 * or are served by one. Same predicate OnboardingGate threads as
 * `hasLocalStation`.
 */
export function hasLocalStationForProfile(
  profile: Pick<PlatformProfile, 'isTauri' | 'isMobile'>,
): boolean {
  return !profile.isTauri || !profile.isMobile;
}
