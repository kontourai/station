/**
 * View Models — Shared data shapes consumed by UI components.
 *
 * These are intentionally decoupled from the raw MCP tool responses.
 * Provider implementations map raw data into these shapes.
 */

export interface CalendarEventVM {
  id: string;
  changeKey?: string;
  subject: string;
  start: Date;
  end: Date;
  location?: string;
  organizer?: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  isCancelled: boolean;
  categories: string[];
  isAllDay: boolean;
}

export interface AttendeeVM {
  email: string;
  name?: string;
  status: 'accepted' | 'declined' | 'tentative' | 'none';
}

export interface MeetingDetailsVM extends CalendarEventVM {
  body?: string;
  responseStatus?: string;
  attendees: AttendeeVM[];
}

export interface ContactVM {
  email: string;
  name?: string;
}

export interface AccountVM {
  id: string;
  name: string;
  owner?: { id: string; name: string };
  website?: string;
  segment?: string;
  territory?: string;
}

export interface OpportunityVM {
  id: string;
  name: string;
  accountId?: string;
  amount?: number;
  closeDate?: Date;
  stage?: string;
  probability?: number;
  owner?: { id: string; name: string; email?: string };
}

export interface TaskVM {
  id: string;
  subject: string;
  status: 'open' | 'completed' | 'deferred';
  dueDate?: Date;
  description?: string;
  priority?: 'high' | 'normal' | 'low';
  activityType?: string;
  relatedTo?: { type: string; id: string; name: string };
}

export interface TerritoryVM {
  id: string;
  name: string;
  region?: string;
}

export interface UserProfileVM {
  id: string;
  name: string;
  email: string;
  alias: string;
  role?: string;
  title?: string;
  manager?: string;
}

export interface EmailVM {
  id: string;
  subject: string;
  from: { name: string; email: string };
  date: Date;
  preview: string;
  isRead: boolean;
  importance?: 'high' | 'normal' | 'low';
  hasAttachments: boolean;
}

export interface EmailDetailVM extends EmailVM {
  body: string;
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  attachments: { name: string; size: number; contentType: string }[];
}

export interface PersonVM {
  alias: string;
  name: string;
  title?: string;
  team?: string;
  manager?: string;
  location?: string;
  email?: string;
}
