import { agentId } from '@kontourai/station-contracts/agent-identity';

export const CRM_BASE_URL = 'https://crm.example.com';

export const WORKSPACE = 'enterprise';
export const LAYOUT_SLUG = 'enterprise-assistant';
// useSendToChat takes a branded AgentId. agentId() validates the slug and
// brands it; the SDK does not re-export it, so it comes from contracts.
export const AGENT_SLUG = agentId('enterprise-assistant');
