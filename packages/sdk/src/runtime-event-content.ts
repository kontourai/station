/**
 * Out-of-line runtime event content (docs/design/event-content-spill.md):
 * the content read, the viewed-content digest, and the query hooks. Lazy;
 * kept out of the SDK first-paint barrel.
 */
export {
  type ApprovalContentBinding,
  computeViewedContentDigest,
  fetchApprovalContentBinding,
  fetchRuntimeEventContent,
  loadApprovalContent,
  loadRuntimeEventContent,
  type RuntimeEventContentRead,
} from './client/runtime-event-content.js';
export {
  type LoadedApprovalContent,
  useApprovalContentQuery,
  useResolvedRuntimeEventValueQuery,
  useRuntimeEventContentQuery,
} from './query-domains/runtimeEventContent.js';
