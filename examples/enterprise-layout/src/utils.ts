const ACCESS_KEY = 'enterprise-account-access';
const RECENT_WINDOW_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

interface AccessRecord {
  accountId: string;
  count: number;
  lastVisited: number;
}

export function getAccountAccess(): AccessRecord[] {
  try {
    return JSON.parse(localStorage.getItem(ACCESS_KEY) || '[]');
  } catch {
    return [];
  }
}

export function recordAccountAccess(accountId: string): void {
  const records = getAccountAccess();
  const existing = records.find((r) => r.accountId === accountId);
  if (existing) {
    existing.count += 1;
    existing.lastVisited = Date.now();
  } else {
    records.push({ accountId, count: 1, lastVisited: Date.now() });
  }
  localStorage.setItem(ACCESS_KEY, JSON.stringify(records));
}

export function isRecentlyVisited(accountId: string): boolean {
  const records = getAccountAccess();
  const record = records.find((r) => r.accountId === accountId);
  if (!record) return false;
  return Date.now() - record.lastVisited < RECENT_WINDOW_MS;
}

export function sortByAccessFrequency<T extends { id: string }>(
  items: T[],
): T[] {
  const records = getAccountAccess();
  const scoreMap = new Map(records.map((r) => [r.accountId, r.count]));
  return [...items].sort(
    (a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0),
  );
}

export function relTime(date: Date | string | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const prefix = future ? 'in ' : '';
  const suffix = future ? '' : ' ago';

  if (abs < 60_000) return 'just now';
  if (abs < 3_600_000) return `${prefix}${Math.round(abs / 60_000)}m${suffix}`;
  if (abs < 86_400_000)
    return `${prefix}${Math.round(abs / 3_600_000)}h${suffix}`;
  if (abs < 7 * 86_400_000)
    return `${prefix}${Math.round(abs / 86_400_000)}d${suffix}`;
  return d.toLocaleDateString();
}
