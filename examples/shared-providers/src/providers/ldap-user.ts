/**
 * LDAP User Identity Provider — enriches user identity via directory lookup.
 */

import { userInfo as osUserInfo } from 'node:os';
import type { UserIdentity } from '@kontourai/station-shared';

export default function createLdapUserProvider() {
  return {
    async getIdentity(): Promise<UserIdentity> {
      const alias = osUserInfo().username;
      return {
        alias,
        profileUrl: `https://directory.example.com/users/${alias}`,
        email: `${alias}@example.com`,
      };
    },

    async enrichIdentity(user: UserIdentity): Promise<UserIdentity> {
      const port = process.env.PORT || 3141;
      const base = `http://localhost:${port}`;

      try {
        const agentsRes = await fetch(`${base}/api/agents`);
        const { data: agents } = (await agentsRes.json()) as any;
        const agent = agents?.find((a: any) =>
          a.toolsConfig?.mcpServers?.includes('crm-mcp'),
        );
        if (!agent) return user;

        const slug = encodeURIComponent(agent.slug);
        const r = await fetch(
          `${base}/agents/${slug}/tool/crm-mcp_search_users`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toolArgs: { alias: user.alias } }),
          },
        );
        const d = (await r.json()) as any;
        const me = d.success ? d.response : null;

        if (me) {
          return {
            ...user,
            name: me.name || user.alias,
            title: me.title,
            email: me.email || user.email,
          };
        }
      } catch {
        /* enrichment failed — keep base identity */
      }
      return user;
    },
  };
}
