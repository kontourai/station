import type { HandlerConfig, StreamChunk, StreamHandler } from '../types.js';

/**
 * Detects <thinking> tags in text-delta chunks and transforms them to reasoning events
 *
 * Key behavior: Buffers ALL chunks while processing thinking blocks to ensure proper ordering.
 * Non-text chunks are held until reasoning-end is emitted, then flushed.
 *
 * Handles:
 * - Buffering text-start until we know if content is thinking or text
 * - Converting text-delta → reasoning-delta inside <thinking> blocks
 * - Emitting reasoning-start/end events
 * - Properly handling text-start/end around thinking blocks
 * - Buffering non-text chunks (tool events, etc.) until reasoning completes
 */
export class ReasoningHandler implements StreamHandler {
  name = 'reasoning';

  // State for tag detection
  private inThinking = false;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used via this.thinkingContent in handler methods
  private thinkingContent = '';
  private partialTag = '';

  // State for text-start/end handling
  private pendingTextStart: StreamChunk | null = null;
  private hasEmittedContent = false;
  private needsTextStart = false;

  // Buffer for non-text chunks during thinking
  private chunkBuffer: StreamChunk[] = [];

  constructor(
    private config: Pick<HandlerConfig, 'enableThinking' | 'debug'> = {},
  ) {}

  async *process(
    input: AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    for await (const chunk of input) {
      yield* this.processChunk(chunk);
    }
  }

  /**
   * Process a single chunk
   * Delegates to specific handlers based on chunk type
   */
  private async *processChunk(chunk: StreamChunk): AsyncGenerator<StreamChunk> {
    if (chunk.type === 'text-start') {
      yield* this.handleTextStart(chunk);
    } else if (chunk.type === 'text-end') {
      yield* this.handleTextEnd(chunk);
    } else if (chunk.type === 'text-delta') {
      yield* this.handleTextDelta(chunk);
    } else {
      // Buffer non-text chunks if we're in a thinking block
      if (this.inThinking) {
        this.bufferChunk(chunk);
      } else {
        yield chunk;
      }
    }
  }

  /**
   * Buffer a non-text chunk to be emitted after reasoning-end
   */
  private bufferChunk(chunk: StreamChunk): void {
    this.chunkBuffer.push(chunk);
  }

  /**
   * Flush all buffered chunks
   */
  private async *flushBuffer(): AsyncGenerator<StreamChunk> {
    if (this.chunkBuffer.length > 0) {
      for (const chunk of this.chunkBuffer) {
        yield chunk;
      }
      this.chunkBuffer = [];
    }
  }

  /**
   * Handle text-start event
   * Buffer it until we know if the content is thinking or regular text
   */
  // biome-ignore lint/correctness/useYield: generator buffers chunks, yields in subsequent calls
  private async *handleTextStart(
    chunk: StreamChunk,
  ): AsyncGenerator<StreamChunk> {
    this.pendingTextStart = chunk;
    this.hasEmittedContent = false;
    // Don't yield yet - wait to see if content is thinking or text
  }

  /**
   * Handle text-end event
   * Convert to reasoning-end if in thinking block, otherwise pass through
   */
  private async *handleTextEnd(
    chunk: StreamChunk,
  ): AsyncGenerator<StreamChunk> {
    if (this.inThinking) {
      // Still in thinking block - close it and flush buffered chunks
      if (chunk.type === 'text-end') {
        yield this.createReasoningEnd(chunk.id);
      }
      yield* this.flushBuffer();
      this.inThinking = false;
      this.thinkingContent = '';
    } else if (this.hasEmittedContent) {
      // We emitted text content, so emit text-end
      yield chunk;
    }
    // else: we never emitted anything, suppress text-end too

    this.pendingTextStart = null;
    this.hasEmittedContent = false;
  }

  /**
   * Handle text-delta event
   * Process character by character to detect <thinking> tags
   */
  private async *handleTextDelta(
    chunk: StreamChunk,
  ): AsyncGenerator<StreamChunk> {
    if (chunk.type === 'text-delta') {
      const text = chunk.text || '';
      const id = chunk.id || '0';

      for (const char of text) {
        yield* this.processCharacter(char, id);
      }
    }
  }

  /**
   * Process a single character
   * Builds up partialTag buffer to detect <thinking> and </thinking> tags
   */
  private async *processCharacter(
    char: string,
    id: string,
  ): AsyncGenerator<StreamChunk> {
    this.partialTag += char;

    // Check for <thinking> tag
    if (this.partialTag.includes('<thinking>')) {
      yield* this.handleThinkingStart(id);
      return;
    }

    // Check for </thinking> tag
    if (this.partialTag.includes('</thinking>')) {
      yield* this.handleThinkingEnd(id);
      return;
    }

    // Still building a potential tag - keep buffering
    if (this.isPotentialTag(this.partialTag)) {
      return; // Don't yield yet
    }

    // Not a tag - emit immediately to reduce buffering
    yield* this.emitBufferedContent(id);
  }

  /**
   * Handle detection of <thinking> tag
   * Emit any text before the tag, then start reasoning block
   */
  private async *handleThinkingStart(id: string): AsyncGenerator<StreamChunk> {
    const beforeTag = this.partialTag.substring(
      0,
      this.partialTag.indexOf('<thinking>'),
    );

    // Emit any text before the thinking tag
    if (beforeTag) {
      yield* this.emitTextContent(beforeTag, id);
    }

    // Start reasoning block
    if (this.config.enableThinking !== false) {
      const startId =
        this.pendingTextStart?.type === 'text-start'
          ? this.pendingTextStart.id
          : id;
      yield this.createReasoningStart(startId);
      this.pendingTextStart = null;
    }

    this.inThinking = true;
    this.thinkingContent = '';
    this.hasEmittedContent = true;
    this.partialTag = '';
  }

  /**
   * Handle detection of </thinking> tag
   * End reasoning block, flush buffered chunks, and prepare for subsequent text
   */
  private async *handleThinkingEnd(id: string): AsyncGenerator<StreamChunk> {
    if (this.config.enableThinking !== false) {
      yield this.createReasoningEnd(id);
    }

    // Flush any buffered non-text chunks
    yield* this.flushBuffer();

    this.inThinking = false;
    this.thinkingContent = '';
    this.hasEmittedContent = true;
    this.partialTag = '';
    this.needsTextStart = true;
  }

  /**
   * Emit buffered content as either reasoning-delta or text-delta
   */
  private async *emitBufferedContent(id: string): AsyncGenerator<StreamChunk> {
    if (this.inThinking) {
      yield* this.emitReasoningContent(this.partialTag, id);
    } else {
      yield* this.emitTextContent(this.partialTag, id);
    }
    this.partialTag = '';
  }

  /**
   * Emit content as reasoning-delta
   */
  private async *emitReasoningContent(
    text: string,
    id: string,
  ): AsyncGenerator<StreamChunk> {
    if (this.config.enableThinking !== false) {
      this.thinkingContent += text;
      yield this.createReasoningDelta(id, text);
      this.hasEmittedContent = true;
    }
  }

  /**
   * Emit content as text-delta
   * Handles pending text-start and needsTextStart flag
   */
  private async *emitTextContent(
    text: string,
    id: string,
  ): AsyncGenerator<StreamChunk> {
    // Emit pending text-start if we haven't emitted content yet
    if (this.pendingTextStart && !this.hasEmittedContent) {
      yield this.pendingTextStart;
      this.pendingTextStart = null;
    }

    // Emit text-start if we transitioned from thinking to text
    if (this.needsTextStart) {
      yield this.createTextStart(id);
      this.needsTextStart = false;
    }

    yield this.createTextDelta(id, text);
    this.hasEmittedContent = true;
  }

  /**
   * Check if string could be the start of a <thinking> or </thinking> tag
   */
  private isPotentialTag(str: string): boolean {
    return '<thinking>'.startsWith(str) || '</thinking>'.startsWith(str);
  }

  // Factory methods for creating chunks

  private createReasoningStart(id: string): StreamChunk {
    return { type: 'reasoning-start', id } as StreamChunk;
  }

  private createReasoningDelta(id: string, text: string): StreamChunk {
    return { type: 'reasoning-delta', id, text } as StreamChunk;
  }

  private createReasoningEnd(id: string): StreamChunk {
    return { type: 'reasoning-end', id } as StreamChunk;
  }

  private createTextStart(id: string): StreamChunk {
    return { type: 'text-start', id };
  }

  private createTextDelta(id: string, text: string): StreamChunk {
    return { type: 'text-delta', id, text };
  }
}
