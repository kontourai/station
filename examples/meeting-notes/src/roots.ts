/**
 * Shared root-relevance filter for `RootPicker.tsx` and `AskPane.tsx`:
 * personal roots are always relevant, project roots only for the active
 * project. One source, so the two panes cannot disagree.
 */
export { isRelevantKnowledgeRoot as isRelevantRoot } from '@kontourai/station-sdk';
