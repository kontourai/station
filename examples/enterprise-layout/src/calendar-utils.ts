const CACHE_PREFIX = 'enterprise-cal-';

/** A session-cache key scoped to one kind of cached data. */
export function getCacheKey(namespace: string, key: string): string {
  return `${CACHE_PREFIX}${namespace}-${key}`;
}

export function getFromCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { data, expires } = JSON.parse(raw);
    if (Date.now() > expires) {
      sessionStorage.removeItem(key);
      return null;
    }
    return data as T;
  } catch {
    return null;
  }
}

export function setCache<T>(key: string, data: T, ttlMs = 5 * 60 * 1000): void {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({ data, expires: Date.now() + ttlMs }),
    );
  } catch {
    // storage full — ignore
  }
}

export interface MeetingLink {
  /** Display name of the meeting service, e.g. "Zoom". */
  provider: string;
  /** The join URL found in the meeting's location or body. */
  url: string;
}

const MEETING_SERVICES: ReadonlyArray<{ provider: string; host: RegExp }> = [
  { provider: 'Teams', host: /(^|\.)teams\.(microsoft|live)\.com$/ },
  { provider: 'Zoom', host: /(^|\.)zoom\.us$/ },
  { provider: 'Chime', host: /(^|\.)chime\.aws$/ },
  { provider: 'Google Meet', host: /^meet\.google\.com$/ },
  { provider: 'Webex', host: /(^|\.)webex\.com$/ },
];

/**
 * The first join link for a known meeting service in a meeting's location or
 * body, or null when neither names one. The host is matched on the parsed
 * URL, not as a substring, so `https://evil.example/?zoom.us` is not a Zoom
 * link.
 */
export function detectMeetingProvider(
  location?: string,
  body?: string,
): MeetingLink | null {
  const text = `${location ?? ''} ${body ?? ''}`;
  for (const candidate of text.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    let host: string;
    try {
      host = new URL(candidate).hostname.toLowerCase();
    } catch {
      continue;
    }
    const service = MEETING_SERVICES.find((s) => s.host.test(host));
    if (service) return { provider: service.provider, url: candidate };
  }
  return null;
}
