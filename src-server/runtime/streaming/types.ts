/**
 * Core types for streaming pipeline architecture (Generator-based)
 */

import type { IStreamChunk } from '../types.js';

/**
 * Stream chunk flowing through the pipeline.
 * Alias for the framework-agnostic IStreamChunk interface.
 */
export type StreamChunk = IStreamChunk;

/**
 * Handler configuration options
 */
export interface HandlerConfig {
  /** Enable debug logging */
  debug?: boolean;
  /** Enable thinking block emission (for ReasoningHandler) */
  enableThinking?: boolean;
}

/**
 * Stream handler interface - processes chunks using generator pattern
 *
 * Each handler:
 * - Receives an async iterable of chunks (output of previous handler)
 * - Yields 0 or more chunks per input chunk
 * - Can maintain internal state
 * - Can suppress chunks (don't yield)
 * - Can transform chunks (yield different type)
 * - Can emit multiple chunks (yield multiple times)
 */
export interface StreamHandler {
  /** Handler name for debugging */
  name: string;

  /**
   * Process a stream of chunks
   * @param input - Async iterable of chunks from previous handler (or source)
   * @returns Async generator yielding 0+ chunks per input
   */
  process(input: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk>;

  /**
   * Optional finalize method called after all chunks processed
   * Can return metadata/stats collected during processing
   */
  finalize?(): Promise<any> | any;
}

/**
 * Writable stream interface for SSE output
 */
export interface WritableStream {
  write(data: string): Promise<void>;
}

/**
 * Bedrock-specific chunk format for SSE output
 */
export interface BedrockChunk {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  finishReason?: string;
  [key: string]: unknown;
}
