import type { PlatformProfile } from './PlatformProfileContext';

/** Maps the trusted platform profile, never a user agent, to client origin. */
export function clientOriginSurfaceForProfile(
  profile: Pick<PlatformProfile, 'isDesktop' | 'isMobile'>,
): 'web' | 'desktop' | 'mobile' {
  return profile.isMobile ? 'mobile' : profile.isDesktop ? 'desktop' : 'web';
}
