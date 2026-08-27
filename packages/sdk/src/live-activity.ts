/** Lazy Activity-surface SDK entrypoint; keep its query out of first paint. */

export type {
  LiveActivityParticipant,
  LiveActivityProjection,
} from '@kontourai/station-contracts/live-activity';
export {
  fetchLiveActivity,
  LiveActivityProtocolError,
} from './client/live-activity.js';
export { useLiveActivityQuery } from './query-domains/liveActivity.js';
