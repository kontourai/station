import type {
  VoiceEndpointDetector,
  VoiceEndpointUtterance,
  VoiceInputEvent,
} from './component-types.js';

/** Converts provider input events into at-most-once final utterances per epoch. */
export interface FinalVoiceEndpointDetectorOptions {
  readonly completedEpochLimit?: number;
}

export class FinalVoiceEndpointDetector implements VoiceEndpointDetector {
  readonly descriptor = Object.freeze({
    id: 'final-endpoint',
    name: 'Final utterance endpoint detector',
  });
  private readonly completedEpochs = new Set<number>();
  private readonly completedOrder: number[] = [];
  private highestCompletedEpoch = Number.NEGATIVE_INFINITY;

  private readonly completedEpochLimit: number;

  constructor(options: FinalVoiceEndpointDetectorOptions = {}) {
    const limit = options.completedEpochLimit ?? 128;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('completedEpochLimit must be a positive integer.');
    this.completedEpochLimit = limit;
  }

  get completedEpochCount(): number {
    return this.completedEpochs.size;
  }

  consume(event: VoiceInputEvent): VoiceEndpointUtterance | undefined {
    if (event.type !== 'final' || !event.transcript.trim()) return undefined;
    if (event.epoch <= this.highestCompletedEpoch) return undefined;
    if (this.completedEpochs.has(event.epoch)) return undefined;
    this.completedEpochs.add(event.epoch);
    this.highestCompletedEpoch = event.epoch;
    this.completedOrder.push(event.epoch);
    while (this.completedOrder.length > this.completedEpochLimit) {
      const evicted = this.completedOrder.shift();
      if (evicted !== undefined) this.completedEpochs.delete(evicted);
    }
    return Object.freeze({ epoch: event.epoch, transcript: event.transcript });
  }

  reset(): void {
    this.completedEpochs.clear();
    this.completedOrder.length = 0;
    this.highestCompletedEpoch = Number.NEGATIVE_INFINITY;
  }
}
