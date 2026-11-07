import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useToast } from '../../contexts/ToastContext';
import {
  type ShareTarget,
  useShareToConversation,
} from '../../hooks/useShareToConversation';
import { nativePlatformPromise } from '../../platform/native';
import { receiveSharedImages } from '../../platform/native/share-intake';
import type {
  NativeEventSubscription,
  NativePlatformAdapter,
} from '../../platform/native/types';
import type { FileAttachment } from '../../types';
import { LazyBoundary } from '../LazyBoundary';

// Lazy so the picker (and its query/attachment code) is a separate chunk that
// is fetched only when images are actually shared into Station. Keeps this
// feature off the main bundle budget.
const loadShareTargetPickerModal = () =>
  import('./ShareTargetPickerModal').then((module) => ({
    default: module.ShareTargetPickerModal,
  }));

type ShareIntakeAdapter = Pick<
  NativePlatformAdapter,
  'capability' | 'takeSharedImages' | 'subscribeToSharedImages'
>;

/**
 * Listen for images shared into Station, then take any already pending: a
 * share that launched the app is kept natively until taken, and one that
 * arrives while it runs is announced. Listening first means a share between
 * the two is either already pending or announced (the
 * `AgentActivityLaunchRoutes` pattern). Nothing is subscribed unless the host
 * reports `image-share-intake` enabled (not `share-intake`, which is PWA
 * text on the web); {@link receiveSharedImages} checks the gate again before
 * parsing.
 */
export function subscribeToSharedImageIntake(
  adapter: ShareIntakeAdapter,
  openPicker: (files: File[]) => void,
  reportError: (message: string) => void,
): () => void {
  if (adapter.capability('image-share-intake').state !== 'enabled')
    return () => {};
  let disposed = false;
  const take = () => {
    void adapter.takeSharedImages().then((result) => {
      if (disposed) return;
      if (result.status === 'error') {
        reportError(result.message);
        return;
      }
      if (result.status !== 'ok' || result.value.files.length === 0) return;
      const outcome = receiveSharedImages({
        adapter,
        payload: result.value,
        openPicker,
      });
      if (outcome.status === 'rejected') reportError(outcome.reason);
    });
  };
  const subscription: NativeEventSubscription & { ready: Promise<void> } =
    adapter.subscribeToSharedImages(take);
  void subscription.ready.then(() => {
    if (!disposed) take();
  });
  return () => {
    disposed = true;
    subscription.dispose();
  };
}

/**
 * Owns the native share-target → conversation-picker flow and mounts it once in
 * the chat dock. The Android app reports `image-share-intake` enabled;
 * elsewhere the subscription is never made and the lazy picker chunk is never
 * fetched.
 */
export function ShareIntakeController() {
  const agents = useAgents();
  const { apiBase } = useApiBase();
  const toast = useToast(true);
  const shareToConversation = useShareToConversation(apiBase);
  // Shares wait their turn: one arriving while a picker is open (and may be
  // mid-share) is queued, never swapped into that picker.
  const [shares, setShares] = useState<Array<{ id: number; files: File[] }>>(
    [],
  );
  const nextShareId = useRef(0);

  // Keep the latest callbacks without re-subscribing.
  const openPickerRef = useRef((files: File[]) => {
    nextShareId.current += 1;
    const id = nextShareId.current;
    setShares((queued) => [...queued, { id, files }]);
  });
  const reportErrorRef = useRef<(message: string) => void>(() => {});
  reportErrorRef.current = (message: string) => {
    toast?.showToast(message);
  };

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void nativePlatformPromise.then((adapter) => {
      if (disposed) return;
      unsubscribe = subscribeToSharedImageIntake(
        adapter,
        (files) => openPickerRef.current(files),
        (message) => reportErrorRef.current(message),
      );
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const handleShareToConversation = useCallback(
    async (target: ShareTarget, attachments: FileAttachment[]) => {
      await shareToConversation(target, attachments);
    },
    [shareToConversation],
  );

  const current = shares[0];
  if (!current) return null;

  return (
    <LazyBoundary
      // A fresh picker per share: no search, mode or pending state carries over.
      key={current.id}
      load={loadShareTargetPickerModal}
      componentProps={{
        isOpen: true,
        agents: agents.map((agent) => ({
          slug: agent.slug,
          name: agent.name,
        })),
        sharedFiles: current.files,
        attachmentCapabilities: { images: true, files: true },
        onShareToConversation: handleShareToConversation,
        // Closes only this share's picker, even when it finishes late.
        onClose: () =>
          setShares((queued) =>
            queued.filter((share) => share.id !== current.id),
          ),
      }}
      pending={null}
    />
  );
}
