import { hasTauriRuntime, nativePlatformPromise } from './index';

interface RequesterReviewSurface {
  show(requestId: string, reviewUrl: string): Promise<string | undefined>;
  close(): void;
}

/** Browser activation is synchronous; native requester authority stays host-held. */
export function prepareRequesterConsentReview(): RequesterReviewSurface | null {
  if (hasTauriRuntime()) {
    return {
      async show(requestId) {
        const adapter = await nativePlatformPromise;
        await adapter.getCapabilityReport();
        const result = await adapter.reviewConsentNatively(
          requestId,
          'requester-session',
        );
        if (result.status !== 'ok')
          throw new Error(
            result.status === 'error' ? result.message : result.reason,
          );
        return result.value.status;
      },
      close() {},
    };
  }
  const popup = window.open(
    'about:blank',
    'station-analytics-requester-review',
    'popup,width=620,height=760',
  );
  if (!popup) return null;
  try {
    popup.opener = null;
  } catch {
    popup.close();
    return null;
  }
  return {
    async show(_requestId, reviewUrl) {
      popup.location.replace(reviewUrl);
      return undefined;
    },
    close() {
      popup.close();
    },
  };
}
