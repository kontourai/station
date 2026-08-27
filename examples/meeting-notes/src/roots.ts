/**
 * Shared root-relevance filter (Wave 3 cleanup — `s203-knowledge-meeting-notes`
 * plan, Wave 3 Task "CLEANUPS" §b). `RootPicker.tsx` and `AskPane.tsx` each
 * defined their own copy of "personal roots are always relevant; project roots
 * only for the currently active project" (R3's manual-choice scoping rule) —
 * this module is the single source of truth both now import instead.
 */
export { isRelevantKnowledgeRoot as isRelevantRoot } from '@kontourai/station-sdk';
