import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  type ShareTarget,
  useShareToConversation,
} from '../../hooks/useShareToConversation';
import { nativePlatformPromise } from '../../platform/native';
import { receiveSharedImages } from '../../platform/native/share-intake';
import type { FileAttachment } from '../../types';
import { LazyBoundary } from '../LazyBoundary';

/** Custom-event name a future native receiver would dispatch with a payload. */
const SHARE_IMAGE_EVENT = 'station://share-image';

// Lazy so the picker (and its query/attachment code) is a separate chunk that
// is never fetched until an intake actually fires — which, with `share-intake`
// disabled, never happens in production. Keeps this feature off the main bundle
// budget.
const loadShareTargetPickerModal = () =>
  import('./ShareTargetPickerModal').then((module) => ({
    default: module.ShareTargetPickerModal,
  }));

/**
 * Owns the native share-target → conversation-picker flow and mounts it once in
 * the chat dock.
 *
 * This is inert in production: the `station://share-image` intake listener is
 * only registered when the `share-intake` capability reports `enabled`, and no
 * reviewed native receiver enables it yet. Until then nothing dispatches the
 * event, the picker never opens, and the lazy chunk is never fetched. The JS
 * intake contract ({@link receiveSharedImages}) and the picker are exercised
 * directly in unit tests.
 */
export function ShareIntakeController() {
  const agents = useAgents();
  const { apiBase } = useApiBase();
  const shareToConversation = useShareToConversation(apiBase);
  const [sharedFiles, setSharedFiles] = useState<File[] | null>(null);

  const openPicker = useCallback((files: File[]) => {
    setSharedFiles(files);
  }, []);
  // Keep the latest opener without re-subscribing the (gated) listener.
  const openPickerRef = useRef(openPicker);
  openPickerRef.current = openPicker;

  useEffect(() => {
    let disposed = false;
    let detach: (() => void) | undefined;

    void nativePlatformPromise.then((adapter) => {
      if (disposed) return;
      // The gate: without an enabled, reviewed native receiver this listener is
      // never attached, so the whole path stays dead-inert.
      if (adapter.capability('share-intake').state !== 'enabled') return;

      const handleShareImage = (event: Event) => {
        receiveSharedImages({
          adapter,
          payload: (event as CustomEvent<unknown>).detail,
          openPicker: (files) => openPickerRef.current(files),
        });
      };
      window.addEventListener(SHARE_IMAGE_EVENT, handleShareImage);
      detach = () =>
        window.removeEventListener(SHARE_IMAGE_EVENT, handleShareImage);
    });

    return () => {
      disposed = true;
      detach?.();
    };
  }, []);

  const handleShareToConversation = useCallback(
    async (target: ShareTarget, attachments: FileAttachment[]) => {
      await shareToConversation(target, attachments);
    },
    [shareToConversation],
  );

  if (sharedFiles === null) return null;

  return (
    <LazyBoundary
      load={loadShareTargetPickerModal}
      componentProps={{
        isOpen: true,
        agents: agents.map((agent) => ({
          slug: agent.slug,
          name: agent.name,
        })),
        sharedFiles,
        attachmentCapabilities: { images: true, files: true },
        onShareToConversation: handleShareToConversation,
        onClose: () => setSharedFiles(null),
      }}
      pending={null}
    />
  );
}
