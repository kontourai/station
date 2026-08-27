/**
 * Calendar Provider — implements ICalendarProvider using calendar-mcp tools.
 *
 * This demonstrates the pattern: each provider method calls an MCP tool via
 * `callTool`, unwraps the response envelope, and maps raw data into view models.
 */

import { callTool } from '@kontourai/station-sdk';
import type {
  CreateEventInput,
  ICalendarProvider,
  UpdateEventInput,
} from '../providers';
import type { AttendeeVM, CalendarEventVM, ContactVM } from '../viewmodels';

const AGENT = 'enterprise-assistant';

/** Unwrap MCP tool response envelope */
function unwrap(raw: any): any {
  const payload = raw?.content ?? raw?.response ?? raw;
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload.trim());
  } catch {
    return payload;
  }
}

function mapEvent(raw: any): CalendarEventVM {
  return {
    id: raw.meetingId,
    changeKey: raw.meetingChangeKey,
    subject: raw.subject,
    start: new Date(raw.start),
    end: new Date(raw.end),
    location: raw.location || undefined,
    organizer: raw.organizer?.name || raw.organizer,
    status: raw.isCanceled
      ? 'cancelled'
      : raw.status === 'tentative'
        ? 'tentative'
        : 'confirmed',
    isCancelled: raw.isCanceled || false,
    categories: raw.categories || [],
    isAllDay: raw.isAllDay || false,
  };
}

function mapAttendeeStatus(status: string): AttendeeVM['status'] {
  if (!status || status === 'Unknown') return 'none';
  if (status === 'Accept' || status === 'Accepted') return 'accepted';
  if (status === 'Decline' || status === 'Declined') return 'declined';
  return 'tentative';
}

export const calendarProvider: ICalendarProvider = {
  async getEvents(date: Date) {
    const dateStr = date.toISOString().split('T')[0];
    const raw = await callTool(AGENT, 'calendar-mcp_calendar_view', {
      view: 'day',
      start_date: dateStr,
    });
    const data = unwrap(raw);
    return (Array.isArray(data) ? data : (data?.value ?? [])).map(mapEvent);
  },

  async getMeetingDetails(meetingId: string, changeKey?: string) {
    const raw = await callTool(AGENT, 'calendar-mcp_calendar_meeting', {
      operation: 'read',
      meetingId,
      meetingChangeKey: changeKey,
    });
    const data = unwrap(raw);
    return {
      ...mapEvent(data),
      body: data.body,
      responseStatus: data.responseStatus,
      attendees: (data.attendees || []).map(
        (a: any): AttendeeVM => ({
          email: a.emailAddress?.address || a.email,
          name: a.emailAddress?.name || a.name,
          status: mapAttendeeStatus(a.responseStatus || a.status),
        }),
      ),
    };
  },

  async createEvent(input: CreateEventInput) {
    const raw = await callTool(AGENT, 'calendar-mcp_calendar_meeting', {
      operation: 'create',
      ...input,
    });
    return mapEvent(unwrap(raw));
  },

  async updateEvent(input: UpdateEventInput) {
    const { meetingId, meetingChangeKey, ...rest } = input;
    const raw = await callTool(AGENT, 'calendar-mcp_calendar_meeting', {
      operation: 'update',
      meetingId,
      meetingChangeKey,
      ...rest,
    });
    return mapEvent(unwrap(raw));
  },

  async deleteEvent(meetingId: string) {
    await callTool(AGENT, 'calendar-mcp_calendar_meeting', {
      operation: 'delete',
      meetingId,
    });
  },

  async searchContacts(query: string): Promise<ContactVM[]> {
    const raw = await callTool(AGENT, 'calendar-mcp_email_contacts', {
      query,
      limit: 10,
    });
    const data = unwrap(raw);
    const contacts = data?.contacts || (Array.isArray(data) ? data : []);
    return contacts
      .map(
        (c: any): ContactVM => ({
          email: c.email || c.emailAddress || '',
          name: c.name || c.displayName,
        }),
      )
      .filter((c: ContactVM) => c.email);
  },
};
