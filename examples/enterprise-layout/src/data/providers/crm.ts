/**
 * CRM Provider — implements ICRMProvider and IUserProvider using crm-mcp tools.
 */

import { callTool } from '@kontourai/station-sdk';
import type {
  CreateOpportunityInput,
  ICRMProvider,
  IUserProvider,
  SearchCondition,
} from '../providers';
import type {
  AccountVM,
  OpportunityVM,
  TaskVM,
  TerritoryVM,
} from '../viewmodels';

const AGENT = 'enterprise-assistant';

function mapAccount(raw: any): AccountVM {
  const acct = raw.account || raw.data || raw;
  return {
    id: acct.id,
    name: acct.name,
    owner: acct.owner
      ? { id: acct.owner.id || '', name: acct.owner.name }
      : undefined,
    website: acct.website,
    segment: acct.segment || acct.industry,
    territory: acct.territory?.name || acct.territory,
  };
}

function mapOpportunity(raw: any): OpportunityVM {
  return {
    id: raw.id,
    name: raw.name,
    accountId: raw.accountId,
    amount: raw.amount,
    closeDate: raw.closeDate ? new Date(raw.closeDate) : undefined,
    stage: raw.stageName,
    probability: raw.probability,
    owner: raw.owner
      ? {
          id: raw.owner.id || '',
          name: raw.owner.name || '',
          email: raw.owner.email,
        }
      : undefined,
  };
}

function mapTask(raw: any): TaskVM {
  return {
    id: raw.id,
    subject: raw.subject,
    status: raw.isClosed
      ? 'completed'
      : raw.status === 'Deferred'
        ? 'deferred'
        : 'open',
    dueDate: raw.activityDate ? new Date(raw.activityDate) : undefined,
    description: raw.description,
    priority: raw.priority?.toLowerCase() as TaskVM['priority'],
    activityType: raw.activityType || raw.taskSubtype,
    relatedTo: raw.what
      ? { type: raw.what.__typename, id: raw.whatId, name: raw.what.name }
      : undefined,
  };
}

function mapTerritory(raw: any): TerritoryVM {
  return {
    id: raw.id,
    name: raw.name,
    region: raw.region,
  };
}

export const crmProvider: ICRMProvider & IUserProvider = {
  async getMyProfile() {
    const raw = await callTool(AGENT, 'crm-mcp_get_my_personal_details', {});
    const r = raw?.data || raw;
    return {
      id: r.id,
      name: r.name || r.alias,
      email: r.email || '',
      alias: r.alias,
      role: r.role,
      title: r.title,
    };
  },

  async getMyAccounts(userId: string) {
    const raw = await callTool(AGENT, 'crm-mcp_list_user_assigned_accounts', {
      userId,
    });
    return (raw?.data?.accounts || raw?.accounts || []).map(mapAccount);
  },

  async getMyTerritories(userId: string) {
    const raw = await callTool(AGENT, 'crm-mcp_list_user_territories', {
      userId,
    });
    return (raw?.data?.territories || raw?.territories || []).map(mapTerritory);
  },

  async getTerritoryAccounts(territoryId: string) {
    const raw = await callTool(AGENT, 'crm-mcp_list_territory_accounts', {
      territoryId,
    });
    return (raw?.data?.accounts || raw?.accounts || []).map(mapAccount);
  },

  async searchAccounts(condition: SearchCondition) {
    const raw = await callTool(AGENT, 'crm-mcp_search_accounts', {
      queryTerm: condition.value,
    });
    return (raw?.data?.accounts || raw?.accounts || []).map(mapAccount);
  },

  async getAccountDetails(accountId: string) {
    const raw = await callTool(AGENT, 'crm-mcp_fetch_account_details', {
      accountId,
    });
    return mapAccount(raw?.data || raw);
  },

  async getAccountOpportunities(accountId: string) {
    const raw = await callTool(AGENT, 'crm-mcp_search_opportunities', {
      accountId,
    });
    return (raw?.data?.opportunities || raw?.opportunities || []).map(
      mapOpportunity,
    );
  },

  async searchOpportunities(condition: SearchCondition) {
    const raw = await callTool(AGENT, 'crm-mcp_search_opportunities', {
      queryTerm: condition.value,
    });
    return (raw?.data?.opportunities || raw?.opportunities || []).map(
      mapOpportunity,
    );
  },

  async getMyOpportunities(userId: string) {
    const raw = await callTool(AGENT, 'crm-mcp_search_opportunities', {
      userId,
    });
    return (raw?.data?.opportunities || raw?.opportunities || []).map(
      mapOpportunity,
    );
  },

  async getUserTasks(userId: string, filters?) {
    const raw = await callTool(AGENT, 'crm-mcp_search_tasks', {
      userId,
      limit: filters?.limit || 25,
    });
    const tasks = (raw?.data?.tasks || raw?.tasks || []).map(mapTask);
    return { tasks, hasNextPage: false };
  },

  async getMyTasks(userId: string) {
    const raw = await callTool(AGENT, 'crm-mcp_search_tasks', {
      userId,
      limit: 50,
    });
    return (raw?.data?.tasks || raw?.tasks || []).map(mapTask);
  },

  async getTaskDetails(taskId: string) {
    const raw = await callTool(AGENT, 'crm-mcp_get_task', { taskId });
    return mapTask(raw?.data || raw);
  },

  async createTask(data: Omit<TaskVM, 'id'>) {
    const raw = await callTool(AGENT, 'crm-mcp_create_task', data);
    return mapTask(raw?.data || raw);
  },

  async updateTask(taskId: string, data: Partial<TaskVM>) {
    const raw = await callTool(AGENT, 'crm-mcp_update_task', {
      taskId,
      ...data,
    });
    return mapTask(raw?.data || raw);
  },

  async createOpportunity(data: CreateOpportunityInput) {
    const raw = await callTool(AGENT, 'crm-mcp_create_opportunity', data);
    return mapOpportunity(raw?.data || raw);
  },
};
