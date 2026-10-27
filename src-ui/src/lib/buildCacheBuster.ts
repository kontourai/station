import { buildInfo } from '../build-info';

/**
 * The build key device caches (the persisted query cache and offline reading
 * copies) are written under: a copy is restored only by the build that wrote
 * it, so any build change expires both.
 */
export function buildCacheBuster(): string {
  return `${buildInfo.version}+${buildInfo.commit}`;
}
