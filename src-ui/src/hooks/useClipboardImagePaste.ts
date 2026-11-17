import {
  CHAT_IMAGE_MIME_TYPES,
  type ChatImageMimeType,
} from '@kontourai/station-contracts/chat-attachment';
import { useCallback, useEffect, useRef, useState } from 'react';
import { nativePlatformPromise } from '../platform/native';
import { sharedImagesToFiles } from '../platform/native/share-image';
import type { NativePlatformAdapter } from '../platform/native/types';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { useCoarsePointer } from './useCoarsePointer';

export const NO_CLIPBOARD_IMAGE_MESSAGE =
  'The clipboard has no image to paste.';
const CLIPBOARD_READ_FAILED_MESSAGE = 'Station could not read the clipboard.';

type ClipboardImageResult =
  | { status: 'ok'; files: File[] }
  | { status: 'empty' }
  | { status: 'error'; message: string };

export interface ClipboardImageSources {
  native: () => Promise<
    Pick<NativePlatformAdapter, 'capability' | 'readClipboardImages'>
  >;
  clipboard: () => Pick<Clipboard, 'read'> | undefined;
}

const DEFAULT_SOURCES: ClipboardImageSources = {
  native: () => nativePlatformPromise,
  clipboard: () =>
    typeof navigator === 'undefined' ? undefined : navigator.clipboard,
};

const EXTENSIONS: Record<ChatImageMimeType, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

async function readBrowserClipboard(
  clipboard: Pick<Clipboard, 'read'>,
): Promise<ClipboardImageResult> {
  let items: ClipboardItems;
  try {
    items = await clipboard.read();
  } catch {
    return { status: 'error', message: CLIPBOARD_READ_FAILED_MESSAGE };
  }
  const files: File[] = [];
  for (const item of items) {
    const type = CHAT_IMAGE_MIME_TYPES.find((candidate) =>
      item.types.includes(candidate),
    );
    if (!type) continue;
    try {
      const blob = await item.getType(type);
      files.push(
        new File(
          [blob],
          `pasted-image-${files.length + 1}.${EXTENSIONS[type]}`,
          {
            type,
          },
        ),
      );
    } catch {
      return { status: 'error', message: CLIPBOARD_READ_FAILED_MESSAGE };
    }
  }
  return files.length ? { status: 'ok', files } : { status: 'empty' };
}

/**
 * The clipboard's images as `File`s for a composer's own select path. A
 * mobile native host reads the system clipboard (`clipboard-image`), because
 * its WebView offers no Paste for an image-only clipboard; elsewhere the
 * browser's `navigator.clipboard.read()` does. Bounds are the composer's:
 * these files enter the same intake as Attach, paste and drop.
 */
export async function readClipboardImageFiles(
  sources: ClipboardImageSources = DEFAULT_SOURCES,
): Promise<ClipboardImageResult> {
  const native = await sources.native().catch(() => null);
  if (native?.capability('clipboard-image').state === 'enabled') {
    const result = await native.readClipboardImages();
    if (result.status === 'ok') {
      return result.value.files.length
        ? { status: 'ok', files: sharedImagesToFiles(result.value.files) }
        : { status: 'empty' };
    }
    if (result.status === 'error')
      return { status: 'error', message: result.message };
  }
  const clipboard = sources.clipboard();
  if (typeof clipboard?.read !== 'function')
    return { status: 'error', message: CLIPBOARD_READ_FAILED_MESSAGE };
  return readBrowserClipboard(clipboard);
}

/**
 * Whether this surface should offer Paste image: a mobile native host that
 * reports `clipboard-image`, or a touch browser with `navigator.clipboard.read`
 * (a desktop pointer pastes into the field itself).
 */
function useClipboardImagePasteAvailable(): boolean {
  const { isMobile } = usePlatformProfile();
  const coarsePointer = useCoarsePointer();
  const [nativeEnabled, setNativeEnabled] = useState(false);
  useEffect(() => {
    if (!isMobile) {
      setNativeEnabled(false);
      return;
    }
    let disposed = false;
    void nativePlatformPromise.then((adapter) => {
      if (!disposed)
        setNativeEnabled(
          adapter.capability('clipboard-image').state === 'enabled',
        );
    });
    return () => {
      disposed = true;
    };
  }, [isMobile]);
  const browserRead =
    coarsePointer &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.read === 'function';
  return nativeEnabled || browserRead;
}

/**
 * The Paste image action beside a composer's Attach control. `onFiles` is the
 * composer's own select function; `onMessage` shows why nothing was attached.
 */
export function useClipboardImagePaste({
  onFiles,
  onMessage,
  sources,
}: {
  onFiles: (files: File[]) => void | Promise<void>;
  onMessage: (message: string) => void;
  sources?: ClipboardImageSources;
}) {
  const available = useClipboardImagePasteAvailable();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const paste = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      const result = await readClipboardImageFiles(sources);
      if (result.status === 'ok') await onFiles(result.files);
      else
        onMessage(
          result.status === 'empty'
            ? NO_CLIPBOARD_IMAGE_MESSAGE
            : result.message,
        );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [onFiles, onMessage, sources]);
  return { available, pending, paste };
}
