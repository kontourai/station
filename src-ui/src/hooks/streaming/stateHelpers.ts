/**
 * Helper utilities for stream state management
 */

import type { ContentPart, HandlerResult, StreamState } from './types';

/**
 * Create a result object with no changes
 */
export function createNoOpResult(state: StreamState): HandlerResult {
  return {
    updated: false,
    currentTextChunk: state.currentTextChunk,
    contentParts: state.contentParts,
    pendingApprovals: state.pendingApprovals,
    reasoningChunks: state.reasoningChunks,
    currentReasoningChunk: state.currentReasoningChunk,
  };
}

/**
 * Create a result object with updates
 */
export function createResult(
  state: StreamState,
  updates: Partial<StreamState> & { updated?: boolean; streamingMessage?: any },
): HandlerResult {
  return {
    updated: updates.updated ?? true,
    currentTextChunk: updates.currentTextChunk ?? state.currentTextChunk,
    contentParts: updates.contentParts ?? state.contentParts,
    pendingApprovals: updates.pendingApprovals ?? state.pendingApprovals,
    reasoningChunks: updates.reasoningChunks ?? state.reasoningChunks,
    currentReasoningChunk:
      updates.currentReasoningChunk ?? state.currentReasoningChunk,
    streamingMessage: updates.streamingMessage,
  };
}

/**
 * Update a specific content part by type
 */
export function updateContentPart(
  parts: ContentPart[],
  type: ContentPart['type'],
  updater: (part: ContentPart) => ContentPart,
): ContentPart[] {
  return parts.map((part) => (part.type === type ? updater(part) : part));
}

/**
 * Add a content part to the beginning of the array
 */
export function prependContentPart(
  parts: ContentPart[],
  newPart: ContentPart,
): ContentPart[] {
  return [newPart, ...parts];
}

/**
 * Add a content part to the end of the array
 */
export function appendContentPart(
  parts: ContentPart[],
  newPart: ContentPart,
): ContentPart[] {
  return [...parts, newPart];
}

/**
 * Check if a content part of a specific type exists
 */
export function hasContentPartOfType(
  parts: ContentPart[],
  type: ContentPart['type'],
): boolean {
  return parts.some((p) => p.type === type);
}

/**
 * Get concatenated text content from all text parts
 */
export function getTextFromParts(parts: ContentPart[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.content || '')
    .join('');
}
