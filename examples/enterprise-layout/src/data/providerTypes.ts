/**
 * Provider Type Map — Correlates string identifiers to interfaces.
 *
 * This is the glue between the layout's `requiredProviders` array and the
 * typed provider instances the data hooks consume.
 */

import type {
  ICalendarProvider,
  ICRMProvider,
  IEmailProvider,
  IInternalProvider,
  IUserProvider,
} from './providers';

export type ProviderTypeMap = {
  calendar: ICalendarProvider;
  crm: ICRMProvider;
  user: IUserProvider;
  email: IEmailProvider;
  internal: IInternalProvider;
};

export type ProviderType = keyof ProviderTypeMap;

export const requiredProviders: ProviderType[] = ['calendar', 'crm', 'user'];
