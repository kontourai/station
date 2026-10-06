import { createContext, useContext } from 'react';
import type { UsePushNotificationsResult } from '../hooks/usePushNotifications';

const PushNotificationsContext =
  createContext<UsePushNotificationsResult | null>(null);

export const PushNotificationsProvider = PushNotificationsContext.Provider;

export function usePushNotificationsState(): UsePushNotificationsResult {
  const state = useContext(PushNotificationsContext);
  if (!state)
    throw new Error('Browser push lifecycle must be mounted by the app shell');
  return state;
}
