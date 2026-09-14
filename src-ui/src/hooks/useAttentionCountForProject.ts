import {
  attentionCountForProject,
  attentionProjectCounts,
} from '@kontourai/station-contracts/attention';
import { useAttentionQuery } from '@kontourai/station-sdk';
import { useApiBase } from '../contexts/ApiBaseContext';

/**
 * #2064 (D4): how many pending attention items belong to one project — the
 * number D3's project row renders beside the project name.
 *
 * It reads the SAME `['attention', apiBase]` cache entry the footer bell
 * badge renders from (`useAttentionInbox.pendingCount`, `HeaderActions`), so
 * no extra request is made and the two numbers are the one array counted
 * under two scopes. The counting itself is
 * `attentionCountForProject` in the CONTRACT, imported directly rather than
 * through the SDK barrel for the reason `utils/attention.ts` gives: the
 * barrel is mocked wholesale by a dozen suites, and routing a pure function
 * through it makes each of them declare an export it does not care about.
 *
 * The sidebar rendering that consumes this is #2059's; this slice exposes the
 * data and deliberately edits no `project-sidebar/` file.
 *
 * `0` while the projection has not loaded. That is the honest reading of "no
 * pending item is known", and it matches the bell badge, which renders
 * nothing at 0 rather than a placeholder — a spinner in a count is a claim
 * that there is something to show.
 */
export function useAttentionCountForProject(projectSlug: string): number {
  const { apiBase } = useApiBase();
  const { data } = useAttentionQuery(apiBase);
  return attentionCountForProject(data?.items ?? [], projectSlug);
}

/**
 * Every project with at least one pending item, in one pass — for a caller
 * rendering a LIST of project rows, where calling
 * {@link useAttentionCountForProject} per row would re-scan the same array
 * once per project.
 */
export function useAttentionProjectCounts(): Map<string, number> {
  const { apiBase } = useApiBase();
  const { data } = useAttentionQuery(apiBase);
  return attentionProjectCounts(data?.items ?? []);
}
