import { createLayoutContext } from '@kontourai/station-sdk';
import type {
  AccountVM,
  TaskVM,
  TerritoryVM,
  UserProfileVM,
} from './data/viewmodels';

interface EnterpriseState {
  myDetails: UserProfileVM | null;
  myTerritories: TerritoryVM[];
  myAccounts: AccountVM[];
  myTasks: TaskVM[];
  sfdcCache: Record<string, unknown>;
  loggedActivities: Record<string, { id: string; subject: string }>;
  lastRefresh: number | null;
  contextLoaded: boolean;
}

const defaultState: EnterpriseState = {
  myDetails: null,
  myTerritories: [],
  myAccounts: [],
  myTasks: [],
  sfdcCache: {},
  loggedActivities: {},
  lastRefresh: null,
  contextLoaded: false,
};

const { Provider, useContext } = createLayoutContext<EnterpriseState>({
  layoutSlug: 'enterprise-assistant',
  defaultState,
  persist: true,
});

export const EnterpriseProvider = Provider;
export const useEnterpriseContext = useContext;

/** Alias for components that use the old useSales name */
export const useSales = useContext;
export const SalesProvider = Provider;
