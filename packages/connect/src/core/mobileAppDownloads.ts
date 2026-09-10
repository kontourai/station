import type { PairingDeepLinkChannel } from './pairingDeepLink';

/** Public install destinations only. Add store or testing invitation URLs when published. */
export const MOBILE_APP_DOWNLOADS: Record<
  Exclude<PairingDeepLinkChannel, 'dev'>,
  { ios?: string; android?: string }
> = {
  stable: {},
  beta: {},
  nightly: {},
};
