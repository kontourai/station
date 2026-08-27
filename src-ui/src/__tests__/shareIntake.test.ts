// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import {
  parseNativeSharedImagePayload,
  sharedImagesToFiles,
} from '../platform/native/share-image';
import {
  receiveSharedImages,
  type ShareIntakeCapabilitySource,
} from '../platform/native/share-intake';
import type { NativeCapabilityState } from '../platform/native/types';

// "abc" encoded — a real, canonical base64 image data URL the shared
// attachment pipeline accepts (mirrors chatAttachments.test.ts fixtures).
const PNG_DATA_URL = 'data:image/png;base64,YWJj';

function adapterWithShareIntake(
  state: NativeCapabilityState,
): ShareIntakeCapabilitySource {
  return {
    capability: (id) => ({
      id,
      state,
      reason: `share-intake is ${state}`,
    }),
  };
}

function validPayload(fileCount = 1) {
  return {
    files: Array.from({ length: fileCount }, (_, index) => ({
      name: `shared-${index}.png`,
      mimeType: 'image/png',
      dataUrl: PNG_DATA_URL,
    })),
  };
}

describe('parseNativeSharedImagePayload', () => {
  test('accepts a bounded set of supported images', () => {
    const parsed = parseNativeSharedImagePayload(validPayload(2));
    expect(parsed?.files).toHaveLength(2);
    expect(parsed?.files[0].mimeType).toBe('image/png');
  });

  test('rejects an empty file list', () => {
    expect(parseNativeSharedImagePayload({ files: [] })).toBeNull();
  });

  test('rejects a non-image mime type', () => {
    expect(
      parseNativeSharedImagePayload({
        files: [
          { name: 'notes.txt', mimeType: 'text/plain', dataUrl: PNG_DATA_URL },
        ],
      }),
    ).toBeNull();
  });

  test('rejects a payload whose data url mime disagrees with the declared type', () => {
    expect(
      parseNativeSharedImagePayload({
        files: [
          {
            name: 'x.png',
            mimeType: 'image/png',
            dataUrl: 'data:image/webp;base64,YWJj',
          },
        ],
      }),
    ).toBeNull();
  });

  test('rejects malformed input', () => {
    expect(parseNativeSharedImagePayload(null)).toBeNull();
    expect(parseNativeSharedImagePayload({})).toBeNull();
    expect(parseNativeSharedImagePayload({ files: 'nope' })).toBeNull();
  });
});

describe('sharedImagesToFiles', () => {
  test('materializes File objects the attachment pipeline can read', () => {
    const parsed = parseNativeSharedImagePayload(validPayload(1));
    const files = sharedImagesToFiles(parsed?.files ?? []);
    expect(files).toHaveLength(1);
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0].name).toBe('shared-0.png');
    expect(files[0].type).toBe('image/png');
    expect(files[0].size).toBe(3);
  });
});

describe('receiveSharedImages', () => {
  test('opens the picker staged with files when share-intake is enabled', () => {
    const openPicker = vi.fn();
    const outcome = receiveSharedImages({
      adapter: adapterWithShareIntake('enabled'),
      payload: validPayload(1),
      openPicker,
    });

    expect(outcome).toEqual({ status: 'opened', fileCount: 1 });
    expect(openPicker).toHaveBeenCalledTimes(1);
    const [files] = openPicker.mock.calls[0];
    expect(files).toHaveLength(1);
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0].type).toBe('image/png');
  });

  test('is inert when the share-intake capability is disabled', () => {
    const openPicker = vi.fn();
    const outcome = receiveSharedImages({
      adapter: adapterWithShareIntake('disabled'),
      payload: validPayload(1),
      openPicker,
    });

    expect(outcome.status).toBe('disabled');
    expect(openPicker).not.toHaveBeenCalled();
  });

  test('checks the capability gate before parsing the payload', () => {
    const openPicker = vi.fn();
    // A crafted, invalid payload must not even be inspected on a disabled host.
    const outcome = receiveSharedImages({
      adapter: adapterWithShareIntake('disabled'),
      payload: { files: [{ hostile: true }] },
      openPicker,
    });

    expect(outcome.status).toBe('disabled');
    expect(openPicker).not.toHaveBeenCalled();
  });

  test('rejects an invalid payload on an enabled host without opening the picker', () => {
    const openPicker = vi.fn();
    const outcome = receiveSharedImages({
      adapter: adapterWithShareIntake('enabled'),
      payload: { files: [] },
      openPicker,
    });

    expect(outcome.status).toBe('rejected');
    expect(openPicker).not.toHaveBeenCalled();
  });
});
