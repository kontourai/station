/**
 * LDAP User Identity Provider — enriches user identity via directory lookup.
 */
import { userInfo as osUserInfo } from 'node:os';
export default function createLdapUserProvider() {
  return {
    async getIdentity() {
      const alias = osUserInfo().username;
      return {
        alias,
        profileUrl: `https://directory.example.com/users/${alias}`,
        email: `${alias}@example.com`,
      };
    },
    async enrichIdentity(user) {
      const port = process.env.PORT || 3141;
      const base = `http://localhost:${port}`;
      try {
        const agentsRes = await fetch(`${base}/api/agents`);
        const { data: agents } = await agentsRes.json();
        const agent = agents?.find((a) =>
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
        const d = await r.json();
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
