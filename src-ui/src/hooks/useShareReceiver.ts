/**
 * useShareReceiver — handles incoming share intents from the OS share sheet.
 *
 * The native platform adapter owns host event wiring. Its web implementation
 * preserves the PWA `?share=`, `?text=`, `?url=`, and `?title=` URL shape.
 *
 * The caller provides an `onShare(text)` callback to pre-fill the chat input.
 *
 * Native inbound shares remain disabled until a reviewed receiver is selected.
 */
import { useEffect } from 'react';
import { useToast } from '../contexts/ToastContext';
import { nativePlatformPromise } from '../platform/native';

interface UseShareReceiverOptions {
  /** Whether to watch for incoming shares. */
  enabled: boolean;
  /** Called with the shared text/URL when a share intent arrives. */
  onShare: (text: string) => void;
}

export function useShareReceiver({
  enabled,
  onShare,
}: UseShareReceiverOptions): void {
  const { showToast } = useToast();

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let disposeSubscription: (() => void) | undefined;
    void nativePlatformPromise
      .then((nativePlatform) => {
        if (disposed) return;
        const subscription = nativePlatform.subscribeToShare(
          (event) => {
            onShare(event.text);
          },
          (error) => {
            showToast(error.message);
          },
        );
        disposeSubscription = () => subscription.dispose();
      })
      .catch(() => {
        if (!disposed)
          showToast('Station could not initialize native sharing.');
      });
    return () => {
      disposed = true;
      disposeSubscription?.();
    };
  }, [enabled, onShare, showToast]);
}
