/**
 * The JS-side entry point for the native share-target → conversation-picker
 * flow.
 *
 * This is deliberately a pure function, not a live subscription: the OS
 * receiver that would eventually call it (Android `ACTION_SEND` intent filter,
 * iOS share extension) is a separate, security-reviewed follow-up. Keeping the
 * intake as a single function makes the whole contract unit-testable with a
 * mocked adapter and payload, without any native host.
 *
 * The path is gated OFF by the `share-intake` capability. Until a reviewed
 * native receiver reports that capability as `enabled`, {@link receiveSharedImages}
 * short-circuits to an inert `disabled` outcome and never opens the picker, so
 * this ships dead-inert in production while remaining fully exercisable in
 * tests.
 */
import {
  type NativeSharedImagePayload,
  parseNativeSharedImagePayload,
  sharedImagesToFiles,
} from './share-image';
import type { NativeCapabilityStatus } from './types';

/** The subset of the native adapter the intake needs: the capability gate. */
export interface ShareIntakeCapabilitySource {
  capability(id: 'share-intake'): NativeCapabilityStatus;
}

export type ShareIntakeOutcome =
  | { status: 'disabled'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'opened'; fileCount: number };

export interface ReceiveSharedImagesParams {
  /** Reports whether the `share-intake` capability is enabled on this host. */
  adapter: ShareIntakeCapabilitySource;
  /** The untrusted payload delivered by the native receiver. */
  payload: unknown;
  /** Opens the conversation picker pre-loaded with the shared images. */
  openPicker: (files: File[], payload: NativeSharedImagePayload) => void;
}

/**
 * Receive an incoming shared-image payload and, when permitted, open the
 * conversation picker staged with those images.
 *
 * Order of checks is load-bearing: the capability gate is evaluated before the
 * payload is even parsed, so a disabled host can never be probed with crafted
 * payloads.
 */
export function receiveSharedImages({
  adapter,
  payload,
  openPicker,
}: ReceiveSharedImagesParams): ShareIntakeOutcome {
  const capability = adapter.capability('share-intake');
  if (capability.state !== 'enabled') {
    return {
      status: 'disabled',
      reason:
        capability.reason ||
        'The share-intake capability is not enabled on this host.',
    };
  }

  const parsed = parseNativeSharedImagePayload(payload);
  if (!parsed) {
    return {
      status: 'rejected',
      reason: 'The shared payload was not a valid set of images.',
    };
  }

  const files = sharedImagesToFiles(parsed.files);
  openPicker(files, parsed);
  return { status: 'opened', fileCount: files.length };
}
