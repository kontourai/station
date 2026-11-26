import { setTimeout as delay } from 'node:timers/promises';

/**
 * Retry a transient GitHub evidence read under the original request deadline.
 * Writes can have an effect even when their response is lost.
 * @param {string} url
 * @param {RequestInit} options
 */
export async function fetchGitHubEvidence(url, options) {
  const signal = AbortSignal.timeout(30_000);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...options, signal });
    if (
      options.method !== 'GET' ||
      ![502, 503, 504].includes(response.status) ||
      attempt === 2
    ) {
      return response;
    }
    await response.body?.cancel();
    await delay(250 * 2 ** attempt, undefined, { signal });
  }
}
