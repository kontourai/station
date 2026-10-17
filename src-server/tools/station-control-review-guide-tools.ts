import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const target = z
  .object({
    project: z.string().min(1).max(255),
    provider: z.enum(['github', 'gitlab']),
    host: z.string().min(1).max(255),
    owner: z.string().min(1).max(255),
    repository: z.string().min(1).max(255),
    ref: z
      .string()
      .regex(/^[1-9]\d*$/)
      .max(32),
  })
  .strict();
function path(value: z.infer<typeof target>) {
  return `/api/pull-requests/${[value.provider, value.host, value.owner, value.repository, value.ref].map(encodeURIComponent).join('/')}/guide?${new URLSearchParams({ project: value.project })}`;
}
export function registerReviewGuideTools(registry: StationControlToolRegistry) {
  registry.tool(
    'read_pull_request_guide',
    'Read the shared guide and Running/Failed state for one exact pull request in a project. currentHeadSha identifies stale guides; obsolete excerpts are hidden.',
    { target },
    async ({ target }) => jsonToolResult(await api(path(target))),
  );
  registry.tool(
    'write_pull_request_guides',
    'Start or rewrite guides for 1–20 pull requests. Over-limit batches are rejected. At most two guides run on the server; each result reports admission or refusal. Requires operator authority and enabled review guides. Read each guide later to see completion.',
    { targets: z.array(target).min(1).max(20) },
    async ({ targets }) => {
      const results = [];
      for (const target of targets) {
        try {
          results.push({
            target,
            result: await api(path(target), { method: 'POST', body: '{}' }),
          });
        } catch {
          results.push({
            target,
            error:
              'Guide request refused. Check server capacity, project access, model settings and provider access.',
          });
        }
      }
      return jsonToolResult({ results });
    },
  );
}
