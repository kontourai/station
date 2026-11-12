/**
 * The JS-side gate for the native share-target → conversation-picker flow.
 *
 * The receiver is the station-media-intake plugin's Android `ACTION_SEND`/
 * `ACTION_SEND_MULTIPLE` image filter; `ShareIntakeController` takes its
 * pending share and hands the payload here. Keeping the gate a pure function
 * makes the contract unit-testable with a mocked adapter and payload.
 *
 * The path is gated by the `image-share-intake` capability, which the native
 * host reports enabled only on Android. It is distinct from `share-intake`,
 * which the web adapter reports for PWA text shares. Without it
 * {@link receiveSharedImages} short-circuits to `disabled` and never opens
 * the picker.
 */
import {
  type NativeSharedImagePayload,
  parseNativeSharedImagePayload,
  sharedImagesToFiles,
} from './share-image';
import type { NativeCapabilityStatus } from './types';

/** The subset of the native adapter the intake needs: the capability gate. */
export interface ShareIntakeCapabilitySource {
  capability(id: 'image-share-intake'): NativeCapabilityStatus;
}

type ShareIntakeOutcome =
  | { status: 'disabled'; reason: string }
  | { status: 'rejected'; reason: string }
  | { status: 'opened'; fileCount: number };

interface ReceiveSharedImagesParams {
  /** Reports whether the `image-share-intake` capability is enabled on this host. */
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
  const capability = adapter.capability('image-share-intake');
  if (capability.state !== 'enabled') {
    return {
      status: 'disabled',
      reason:
        capability.reason ||
        'The image-share-intake capability is not enabled on this host.',
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
