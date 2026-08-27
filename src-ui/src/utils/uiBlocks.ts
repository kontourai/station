// The ui-block extractor lives in the SDK so every path that turns tool results
// into chat content parts shares ONE implementation: the managed + orchestration
// streaming handlers AND the conversation-load mapper. Re-exported here so the
// existing `utils/uiBlocks` import path keeps working.
export { extractUIBlocks } from '@kontourai/station-sdk';
