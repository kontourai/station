/** Lazy Activity-surface SDK entrypoint; keep its query out of first paint. */

export type {
  LiveActivityParticipant,
  LiveActivityProjection,
} from '@kontourai/station-contracts/live-activity';
export {
  fetchLiveActivity,
  LiveActivityProtocolError,
} from './client/live-activity.js';
export {
  LIVE_ACTIVITY_POLL_INTERVAL_MS,
  useLiveActivityQuery,
} from './query-domains/liveActivity.js';
