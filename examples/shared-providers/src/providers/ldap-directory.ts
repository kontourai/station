/**
 * LDAP Directory Provider — user lookup via a directory service.
 */

import type { UserDetailVM } from '@kontourai/station-shared';

export default function createLdapDirectoryProvider() {
  const port = process.env.PORT || 3141;
  const base = `http://localhost:${port}`;

  async function findAgent(): Promise<any> {
    try {
      const r = await fetch(`${base}/api/agents`);
      const { data: agents } = (await r.json()) as any;
      return agents?.find((a: any) =>
        a.toolsConfig?.mcpServers?.includes('directory-mcp'),
      );
    } catch {
      return null;
    }
  }

  async function callTool(
    agentSlug: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<any> {
    const slug = encodeURIComponent(agentSlug);
    const r = await fetch(`${base}/agents/${slug}/tool/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolArgs: args }),
    });
    const d = (await r.json()) as any;
    return d.success ? d.response : null;
  }

  function mapPerson(raw: any, fallbackAlias?: string): UserDetailVM {
    return {
      alias: raw?.login || raw?.alias || fallbackAlias || '',
      name: raw?.name || raw?.displayName || fallbackAlias || '',
      title: raw?.jobTitle || raw?.title,
      team: raw?.department || raw?.team,
      manager: raw?.manager
        ? { alias: raw.manager.login || raw.manager, name: raw.manager.name }
        : undefined,
      email:
        raw?.email ||
        (fallbackAlias ? `${fallbackAlias}@example.com` : undefined),
      location: raw?.office || raw?.location,
      profileUrl: `https://directory.example.com/users/${raw?.login || fallbackAlias}`,
    };
  }

  return {
    async lookupPerson(alias: string): Promise<UserDetailVM> {
      const agent = await findAgent();
      if (!agent) return { alias, name: alias };
      try {
        const raw = await callTool(agent.slug, 'directory-mcp_lookup_user', {
          alias,
        });
        return mapPerson(raw, alias);
      } catch {
        return { alias, name: alias };
      }
    },

    async searchPeople(query: string): Promise<UserDetailVM[]> {
      const agent = await findAgent();
      if (!agent) return [];
      try {
        const raw = await callTool(agent.slug, 'directory-mcp_search_users', {
          query,
        });
        return Array.isArray(raw) ? raw.map((p: any) => mapPerson(p)) : [];
      } catch {
        return [];
      }
    },
  };
}
