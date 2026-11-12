/**
 * The handshake flags `consumed-capability-flags.test.ts` pins to their
 * routes. That suite asserts its table rows are exactly this list, and
 * `client-capability-gates.scan.test.ts` fails when a client in packages/sdk
 * or src-ui gates on a flag missing from it. Shared here because a test file
 * may not export.
 */
export const TABLED_CAPABILITY_FLAGS: readonly string[] = Object.freeze([
  'delegationToolConstraintsV1',
  'peerChatTunnelV1',
  'delegationLocalConversationV1',
  'childWorkSteering',
  'connectionRoutes',
  'coordinatorSession',
  'eventStreamResume',
  'followUpAttachments',
  'privateMemoryReview',
  'privateOperationalOutcomes',
  'readMarkers',
  'scheduledConversationTarget',
  'sessionEventWindow',
  'sessionInventoryInputRead',
  'sessionPersonReads',
  'troubleshootPrepare',
  'webPushNotifications',
]);
