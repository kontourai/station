export interface CalendarEvent {
  meetingId: string;
  meetingChangeKey: string;
  subject: string;
  start: string;
  end: string;
  location?: string;
  organizer?: string;
  status?: string;
  isCanceled?: boolean;
  categories?: string[];
  isAllDay?: boolean;
}

export interface MeetingDetails extends CalendarEvent {
  body?: string;
  attendees?: Array<{ email: string; name?: string; status: string }>;
  responseStatus?: string;
  isCanceled?: boolean;
}

export interface SFDCContext {
  accounts?: any[];
  campaigns?: any[];
  opportunities?: any[];
  tasks?: any[];
  suggestedKeyword?: string;
  selectedAccountId?: string;
}

export interface CalendarProps {
  activeTab?: any;
}
