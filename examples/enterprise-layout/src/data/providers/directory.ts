/**
 * Directory Provider — implements IInternalProvider for people lookup.
 *
 * In a real deployment this would call an LDAP, Active Directory, or
 * corporate directory MCP server. Stubbed here to show the pattern.
 */

import type { IInternalProvider } from '../providers';
import type { PersonVM } from '../viewmodels';

function _mapPerson(raw: any, fallbackAlias?: string): PersonVM {
  return {
    alias: raw.alias || raw.login || fallbackAlias || '',
    name: raw.name || raw.displayName || fallbackAlias || '',
    title: raw.jobTitle || raw.title,
    team: raw.team || raw.department,
    manager: raw.manager?.name || raw.manager,
    location: raw.location,
    email:
      raw.email || (fallbackAlias ? `${fallbackAlias}@example.com` : undefined),
  };
}

export const directoryProvider: IInternalProvider = {
  async lookupPerson(alias) {
    // Stub: in production, call your directory MCP tool here
    // e.g. await callTool(AGENT, 'ldap-mcp_lookup_user', { alias });
    return { alias, name: alias, email: `${alias}@example.com` };
  },
  async searchPeople(_query) {
    // Stub: in production, call your directory MCP tool here
    // e.g. await callTool(AGENT, 'ldap-mcp_search_users', { query });
    return [];
  },
};
