import { z } from 'zod/v3';

export const CalendarEventSchema = z.object({
  id: z.string(),
  subject: z.string(),
  start: z.string(),
  end: z.string(),
  location: z.string().optional(),
  organizer: z.string().optional(),
  isCancelled: z.boolean().default(false),
  categories: z.array(z.string()).default([]),
  isAllDay: z.boolean().default(false),
});

export interface CalendarEvent {
  id: string;
  subject: string;
  start: Date;
  end: Date;
  location?: string;
  organizer?: string;
  isCancelled: boolean;
  categories: string[];
  isAllDay: boolean;
}

export interface MeetingDetails extends CalendarEvent {
  body?: string;
  responseStatus?: string;
  attendees: { email: string; name?: string; status: string }[];
}

export interface SFDCContext {
  accountId?: string;
  accountName?: string;
  opportunityId?: string;
  opportunityName?: string;
}

export interface CalendarProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
}

const CACHE_PREFIX = 'enterprise-cal-';

export function getCacheKey(date: Date): string {
  return CACHE_PREFIX + date.toISOString().split('T')[0];
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

export function parseCalendarResponse(raw: unknown): CalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const parsed = CalendarEventSchema.safeParse(item);
      if (!parsed.success) return null;
      const d = parsed.data;
      return {
        ...d,
        start: new Date(d.start),
        end: new Date(d.end),
      };
    })
    .filter(Boolean) as CalendarEvent[];
}

export function formatOrganizerName(organizer: string | undefined): string {
  if (!organizer) return 'Unknown';
  // "Last, First" → "First Last"
  if (organizer.includes(',')) {
    const [last, first] = organizer.split(',').map((s) => s.trim());
    return `${first} ${last}`;
  }
  return organizer;
}

type MeetingProvider = 'teams' | 'zoom' | 'chime' | 'meet' | 'webex' | 'other';

export function detectMeetingProvider(event: {
  location?: string;
  body?: string;
}): MeetingProvider {
  const text = `${event.location ?? ''} ${event.body ?? ''}`.toLowerCase();
  if (text.includes('teams.microsoft') || text.includes('teams.live'))
    return 'teams';
  if (text.includes('zoom.us')) return 'zoom';
  if (text.includes('chime.aws')) return 'chime';
  if (text.includes('meet.google')) return 'meet';
  if (text.includes('webex.com')) return 'webex';
  return 'other';
}
