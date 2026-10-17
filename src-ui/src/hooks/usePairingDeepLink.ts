import {
  type PairingDeepLinkChannel,
  parseBrowserPairingLink,
  parsePairingDeepLink,
} from '@kontourai/station-connect/pairing-deep-link';
import { useEffect } from 'react';
import { nativePlatformPromise } from '../platform/native';

interface UsePairingDeepLinkOptions {
  enabled: boolean;
  clientChannel?: PairingDeepLinkChannel;
  devScheme?: string;
  onPairingPayload: (payload: string) => void;
  onError: (message: string) => void;
}

/** Bridges only the reviewed native pairing association into the Join UI. */
export function usePairingDeepLink({
  enabled,
  clientChannel,
  devScheme,
  onPairingPayload,
  onError,
}: UsePairingDeepLinkOptions): void {
  useEffect(() => {
    const parsed = parseBrowserPairingLink(window.location.href);
    if (!parsed) return;
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    hash.delete('station-pairing');
    url.hash = hash.toString();
    window.history.replaceState(
      null,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    if (parsed.status === 'ok') onPairingPayload(parsed.payload);
    else onError(parsed.message);
  }, [onPairingPayload, onError]);

  useEffect(() => {
    if (!enabled || !clientChannel) return;
    let disposed = false;
    let disposeSubscription: (() => void) | undefined;
    void nativePlatformPromise
      .then((platform) => {
        if (
          disposed ||
          platform.capability('pairing-deep-link').state !== 'enabled'
        ) {
          return;
        }
        const subscription = platform.subscribeToPairingDeepLinks(
          ({ url }) => {
            const parsed = parsePairingDeepLink(url, {
              clientChannel,
              devScheme,
            });
            if (parsed.status === 'ok') onPairingPayload(parsed.payload);
            else onError(parsed.message);
          },
          (error) => onError(error.message),
        );
        disposeSubscription = () => subscription.dispose();
      })
      .catch(() => {
        if (!disposed) onError('Station could not initialize pairing links.');
      });
    return () => {
      disposed = true;
      disposeSubscription?.();
    };
  }, [clientChannel, devScheme, enabled, onError, onPairingPayload]);
}
