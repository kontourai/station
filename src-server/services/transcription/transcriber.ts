/**
 * Local speech-to-text (docs/design/walkthroughs.md, "Local transcription").
 *
 * One Interface, two consumers: the Walkthrough video importer and the
 * "Station (local)" voice provider. The input is any audio or video file
 * ffmpeg can decode; the adapter owns conversion and segmentation. Times are
 * milliseconds from the start of the input.
 *
 * A missing tool or model is `unavailable`, never an empty transcript: an
 * empty `segments` array with status `transcribed` means the engine ran and
 * heard no speech.
 */

import type { MediaToolDownloadItem } from '../media-tools/media-tools-resolver.js';

export interface TranscriptToken {
  readonly startMs: number;
  readonly endMs: number;
  /** Token text as the engine emitted it, including any leading space. */
  readonly text: string;
}

export interface TranscriptSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** Empty when the engine reports no token timing for this segment. */
  readonly tokens: readonly TranscriptToken[];
}

export interface TranscriptionEngine {
  /** e.g. `sherpa-onnx@2.0.0` */
  readonly runtime: string;
  /** e.g. `parakeet-tdt-110m-int8` */
  readonly model: string;
}

export type TranscriptionResult =
  | {
      readonly status: 'transcribed';
      readonly engine: TranscriptionEngine;
      readonly durationMs: number;
      readonly segments: readonly TranscriptSegment[];
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'needs-consent';
      readonly downloads: readonly MediaToolDownloadItem[];
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'unsupported-platform';
      readonly platform: string;
    }
  | {
      readonly status: 'failed';
      readonly reason:
        | 'invalid-input'
        | 'too-long'
        | 'timeout'
        | 'aborted'
        | 'engine-error';
      readonly message: string;
    };

export interface TranscribeFileRequest {
  /** Absolute path to a local audio or video file. */
  readonly inputPath: string;
  readonly signal?: AbortSignal;
}

export interface Transcriber {
  transcribeFile(request: TranscribeFileRequest): Promise<TranscriptionResult>;
}
