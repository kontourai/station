import { useFeaturePreviewsQuery } from '@kontourai/station-sdk';
import { authenticatedFetch, getJson } from '@kontourai/station-sdk/client';
import { Badge, Empty } from '@kontourai/ui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { userFacingErrorMessage } from '../../utils/errorText';

const PATH = '/config/delegation-grants';
const PREVIEW_ID = 'delegation-grants';
type Authority = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;

interface GrantRow {
  id: string;
  access: 'confined' | 'full-access';
  scope: { kind: string; conversationId?: string };
  agents: string[];
  models: string[];
  projects: string[];
  ownWorktree: boolean;
  network: { mode: string; allowedHosts?: string[] };
  expiry: { kind: string; seconds?: number };
  createdAt: number;
  createdBy: string;
  extraGitWritePaths: Record<string, string[]>;
  children: string[];
}

interface Posture {
  scope: string;
  access: GrantRow['access'] | 'expired';
  ownWorktree: boolean;
  network: 'open';
  expiresAt: number | null;
}

async function grantResponse<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error ?? 'Unable to read delegation grants.');
  }
  return result.data;
}

function useGrantAuthority() {
  const authority = useHostRequestAuthorityScope();
  const previews = useFeaturePreviewsQuery();
  return previews.data?.some(({ id, enabled }) => id === PREVIEW_ID && enabled)
    ? authority
    : undefined;
}

export function DelegationGrantPostureBadge({
  apiBase,
  sessionId,
}: {
  apiBase: string;
  sessionId?: string;
}) {
  const host = useGrantAuthority();
  const authority = host?.apiBase === apiBase ? host : undefined;
  const query = useQuery({
    enabled: Boolean(authority && sessionId),
    queryKey: ['delegation-grant-posture', authority?.authorityKey, sessionId],
    queryFn: async ({ signal }): Promise<Posture | null> => {
      if (!authority || !sessionId) return null;
      return grantResponse<Posture | null>(
        getJson(
          `${authority.apiBase}${PATH}/sessions/${encodeURIComponent(sessionId)}`,
          { requestScope: authority, signal },
        ),
      );
    },
    retry: false,
    refetchInterval: 10_000,
  });
  if (!authority || !query.data || query.isError) return null;
  const { access, scope, ownWorktree, expiresAt } = query.data;
  if (access === 'expired')
    return <Badge value="Delegation grant ended" tone="caution" />;
  const posture =
    access === 'full-access'
      ? 'Full access'
      : ownWorktree
        ? 'Confined worktree'
        : 'Confined workspace';
  const expiry = expiresAt
    ? ` · Expires ${new Date(expiresAt).toLocaleTimeString()}`
    : '';
  return (
    <Badge value={`${posture} · Open network · ${scope} grant${expiry}`} />
  );
}

export function DelegationGrantSettings() {
  const authority = useGrantAuthority();
  return authority ? <GrantControls authority={authority} /> : null;
}

function GrantControls({ authority }: { authority: Authority }) {
  const [scope, setScope] = useState('project');
  const [expiry, setExpiry] = useState('parent-session');
  const [network, setNetwork] = useState('default');
  const client = useQueryClient();
  const key = ['delegation-grants', authority.apiBase, authority.authorityKey];
  const endpoint = `${authority.apiBase}${PATH}`;
  const grants = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      grantResponse<GrantRow[]>(
        getJson(endpoint, { requestScope: authority, signal }),
      ),
    retry: false,
    refetchInterval: 10_000,
  });
  const save = useMutation({
    mutationFn: async (change: { id: string } | { fields: FormData }) => {
      const options =
        'id' in change
          ? { method: 'DELETE' }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(settings(change.fields)),
            };
      const result = await authenticatedFetch(
        'id' in change
          ? `${endpoint}/${encodeURIComponent(change.id)}`
          : endpoint,
        { ...options, requestScope: authority },
      );
      if (!result.ok) {
        const failure = await result.json().catch(() => null);
        throw new Error(failure?.error ?? 'Unable to save delegation grant.');
      }
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  return (
    <PageSection title="Delegation grants">
      {grants.isPending && <SkeletonBlock />}
      {grants.isError && (
        <ErrorState
          title="Unable to load delegation grants"
          description={userFacingErrorMessage(grants.error)}
          action={<Button onClick={() => void grants.refetch()}>Retry</Button>}
        />
      )}
      {grants.data?.length === 0 && (
        <Empty variant="compact" label="Grants appear here once added" />
      )}
      {grants.data?.map((grant) => (
        <section key={grant.id} className="content-stack">
          <h4>
            {grant.access === 'full-access' ? 'Full access' : 'Confined coding'}{' '}
            · {grant.scope.kind}
          </h4>
          <dl>
            {grant.scope.conversationId && (
              <>
                <dt>Parent conversation</dt>
                <dd>{grant.scope.conversationId}</dd>
              </>
            )}
            <dt>Agents</dt>
            <dd>{grant.agents.join(', ') || 'None'}</dd>
            <dt>Models</dt>
            <dd>{grant.models.join(', ') || 'None'}</dd>
            <dt>Projects</dt>
            <dd>{grant.projects.join(', ') || 'None'}</dd>
            <dt>Network</dt>
            <dd>
              {grant.network.mode}
              {grant.network.allowedHosts?.length
                ? ` · ${grant.network.allowedHosts.join(', ')}`
                : ''}
            </dd>
            <dt>Own worktree</dt>
            <dd>{grant.ownWorktree ? 'On' : 'Off'}</dd>
            {Object.entries(grant.extraGitWritePaths).map(
              ([project, paths]) => (
                <div key={project}>
                  <dt>Extra Git paths in {project}</dt>
                  <dd>{paths.join(', ')}</dd>
                </div>
              ),
            )}
            <dt>Expiry</dt>
            <dd>
              {grant.expiry.seconds
                ? new Date(
                    grant.createdAt + grant.expiry.seconds * 1000,
                  ).toLocaleString()
                : grant.expiry.kind === 'parent-session'
                  ? 'When the parent session ends'
                  : 'Until revoked'}
            </dd>
            <dt>Set by</dt>
            <dd>
              {grant.createdBy} · {new Date(grant.createdAt).toLocaleString()}
            </dd>
            <dt>Running children</dt>
            <dd>{grant.children.join(', ') || 'None'}</dd>
          </dl>
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate({ id: grant.id })}
          >
            Revoke
          </Button>
        </section>
      ))}
      {grants.isSuccess && (
        <form
          className="content-stack"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate({ fields: new FormData(event.currentTarget) });
          }}
        >
          <h4>Add a grant</h4>
          <label>
            Access{' '}
            <select name="access">
              <option value="confined">Confined coding</option>
              <option value="full-access">Full access</option>
            </select>
          </label>
          <label>
            Scope{' '}
            <select
              name="scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="project">Project</option>
              <option value="station">Station</option>
              <option value="conversation">Parent conversation</option>
            </select>
          </label>
          {scope === 'conversation' && (
            <label>
              Parent conversation ID <input name="conversationId" required />
            </label>
          )}
          <label>
            Agents, comma-separated <input name="agents" />
          </label>
          <label>
            Models, comma-separated <input name="models" />
          </label>
          <label>
            Projects, comma-separated <input name="projects" />
          </label>
          <label>
            Network{' '}
            <select
              name="network"
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
            >
              <option value="default">Engine default</option>
              <option value="open">Open</option>
              <option value="allowlist">Allowlist</option>
            </select>
          </label>
          {network === 'allowlist' && (
            <label>
              Allowed hosts, comma-separated <input name="allowedHosts" />
            </label>
          )}
          <label>
            <input name="ownWorktree" type="checkbox" defaultChecked /> Own
            worktree
          </label>
          <label>
            Extra Git paths by project (JSON map){' '}
            <textarea
              name="extraGitWritePaths"
              placeholder='{"project":["hooks"]}'
            />
          </label>
          <label>
            Expiry{' '}
            <select
              name="expiry"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            >
              <option value="parent-session">
                When the parent session ends
              </option>
              <option value="duration">After a duration</option>
              <option value="revoked">Until revoked</option>
            </select>
          </label>
          {expiry === 'duration' && (
            <label>
              Duration in minutes{' '}
              <input
                name="duration"
                type="number"
                min="1"
                max="525600"
                required
              />
            </label>
          )}
          <Button type="submit" disabled={save.isPending}>
            Add grant
          </Button>
        </form>
      )}
      {save.isError && (
        <ErrorState
          title="Unable to save delegation grant"
          description={userFacingErrorMessage(save.error)}
        />
      )}
    </PageSection>
  );
}

function settings(fields: FormData) {
  const field = (key: string) => String(fields.get(key) ?? '');
  const list = (key: string) =>
    field(key)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  const scope = field('scope');
  const expiry = field('expiry');
  const mode = field('network');
  return {
    access: field('access'),
    scope:
      scope === 'conversation'
        ? { kind: scope, conversationId: field('conversationId') }
        : { kind: scope },
    agents: list('agents'),
    models: list('models'),
    projects: list('projects'),
    ownWorktree: fields.has('ownWorktree'),
    network:
      mode === 'allowlist'
        ? { mode, allowedHosts: list('allowedHosts') }
        : { mode },
    expiry:
      expiry === 'duration'
        ? { kind: expiry, seconds: Number(field('duration')) * 60 }
        : { kind: expiry },
    extraGitWritePaths: JSON.parse(field('extraGitWritePaths').trim() || '{}'),
  };
}
