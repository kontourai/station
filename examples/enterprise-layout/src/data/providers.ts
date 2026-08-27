/**
 * Provider Interfaces — Contracts for data fetching.
 *
 * Each interface maps to a provider type that the layout declares in
 * `requiredProviders`. Implementations live in `./providers/` and call
 * MCP tools via `callTool` from the SDK.
 */

import type {
  AccountVM,
  CalendarEventVM,
  ContactVM,
  EmailDetailVM,
  EmailVM,
  MeetingDetailsVM,
  OpportunityVM,
  PersonVM,
  TaskVM,
  TerritoryVM,
  UserProfileVM,
} from './viewmodels';

export interface CreateEventInput {
  subject: string;
  start: string;
  end: string;
  body?: string;
  location?: string;
  attendees?: string[];
  isAllDay?: boolean;
}

export interface UpdateEventInput extends Partial<CreateEventInput> {
  meetingId: string;
  meetingChangeKey?: string;
}

export interface SearchCondition {
  field: string;
  operator: 'EXACT_MATCH' | 'CONTAINS' | 'STARTS_WITH';
  value: string;
}

export interface CreateOpportunityInput {
  name: string;
  accountId: string;
  amount?: number;
  closeDate?: string;
  stage?: string;
}

export interface ICalendarProvider {
  getEvents(date: Date): Promise<CalendarEventVM[]>;
  getMeetingDetails(
    meetingId: string,
    changeKey?: string,
  ): Promise<MeetingDetailsVM>;
  createEvent(input: CreateEventInput): Promise<CalendarEventVM>;
  updateEvent(input: UpdateEventInput): Promise<CalendarEventVM>;
  deleteEvent(meetingId: string): Promise<void>;
  searchContacts(query: string): Promise<ContactVM[]>;
}

export interface ICRMProvider {
  getMyAccounts(userId: string): Promise<AccountVM[]>;
  getMyTerritories(userId: string): Promise<TerritoryVM[]>;
  getTerritoryAccounts(territoryId: string): Promise<AccountVM[]>;
  searchAccounts(condition: SearchCondition): Promise<AccountVM[]>;
  getAccountDetails(accountId: string): Promise<AccountVM>;
  getAccountOpportunities(accountId: string): Promise<OpportunityVM[]>;
  searchOpportunities(condition: SearchCondition): Promise<OpportunityVM[]>;
  getMyOpportunities(userId: string): Promise<OpportunityVM[]>;
  getUserTasks(
    userId: string,
    filters?: { limit?: number },
  ): Promise<{ tasks: TaskVM[]; hasNextPage: boolean }>;
  getMyTasks(userId: string): Promise<TaskVM[]>;
  getTaskDetails(taskId: string): Promise<TaskVM>;
  createTask(data: Omit<TaskVM, 'id'>): Promise<TaskVM>;
  updateTask(taskId: string, data: Partial<TaskVM>): Promise<TaskVM>;
  createOpportunity(data: CreateOpportunityInput): Promise<OpportunityVM>;
}

export interface IEmailProvider {
  getInbox(options?: { count?: number; filter?: string }): Promise<EmailVM[]>;
  searchEmails(query: string): Promise<EmailVM[]>;
  readEmail(id: string): Promise<EmailDetailVM>;
}

export interface IInternalProvider {
  lookupPerson(alias: string): Promise<PersonVM>;
  searchPeople(query: string): Promise<PersonVM[]>;
}

export interface IUserProvider {
  getMyProfile(): Promise<UserProfileVM>;
}
