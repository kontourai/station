import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR_ID =
  'pane:builtin:workspace-pull-request';
export const WORKSPACE_PULL_REQUEST_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-pull-request';
export const WORKSPACE_PULL_REQUEST_PANE_RENDERER_NAME =
  'workspace-pull-request';
export const WORKSPACE_PULL_REQUEST_PANE_SOURCE_ID =
  'builtin:workspace-pull-request';

/**
 * The prefix every pull-request pane's instance id carries (#2049). The id IS
 * the pane's identity in `RegionState.panes`, so it must stay free of the one
 * character that list forbids (`,`, which `regionStatesEqual` joins on);
 * `workspacePullRequestPaneId` builds it only from a validated host, owner,
 * repository and number, none of which admit one.
 */
export const WORKSPACE_PULL_REQUEST_PANE_ID_PREFIX = 'pr:';

function descriptor(value: unknown): WorkspacePaneDescriptor {
  const parsed = parseWorkspacePaneDescriptor(value);
  if (!parsed) throw new Error('Invalid built-in Pull request Workspace Pane');
  return parsed;
}

/**
 * One pull request, declared as a Workspace Pane (#2049).
 *
 * The pane a chat's pull-request link opens: the review surface the Diff
 * pane already mounts (`PullRequestReviewPanel`), placed as a dock tab of its
 * own rather than reached through the Diff pane's list.
 *
 * `docked` is declared because #2049's link handler is its reader — the same
 * condition `workspace-file-preview` waited on. It is NOT offered by the
 * region's "+" catalog: like a File Preview it has no blank canonical
 * instance (an occurrence is keyed by a repository and a number), so a card
 * could be listed but never opened. `RegionPaneCatalog` filters both out and
 * says so.
 *
 * `project: true` because the review route is project-scoped
 * (`PullRequestReviewTarget.project`): the server resolves the repository
 * against a Project's checkout, so an occurrence with no Project binding has
 * nothing to fetch.
 */
export const WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR = descriptor({
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR_ID,
  name: 'Pull request',
  description: 'Review one pull request from the chat that linked it.',
  rendererId: WORKSPACE_PULL_REQUEST_PANE_RENDERER_ID,
  renderer: {
    kind: 'builtin-component',
    name: WORKSPACE_PULL_REQUEST_PANE_RENDERER_NAME,
  },
  placement: {
    supportedRegions: ['docked', 'secondary'],
    preferredRegion: 'secondary',
  },
  modes: [
    { id: 'default', contextRequirement: { project: true, source: true } },
  ],
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
});

/** The exact pull request one pane shows. `provider` is derived from `host`. */
export interface WorkspacePullRequestPaneKey {
  host: string;
  owner: string;
  repository: string;
  /** The pull request / merge request number, as digits. */
  ref: string;
}

/**
 * Station's two pull-request providers, by host, mirroring the server's two
 * `canServeHost` rules in one place a client may read
 * (`GitLabPullRequestProvider.canServeHost` claims `gitlab.com` only;
 * `GitHubPullRequestProvider.canServeHost` claims everything else). Both
 * canonicalize the host the same way first — lowercase, no port, no trailing
 * dot — so this does too.
 */
export function pullRequestProviderForHost(host: string): 'github' | 'gitlab' {
  return canonicalPullRequestHost(host) === 'gitlab.com' ? 'gitlab' : 'github';
}

/** Lowercase, port-stripped, trailing-dot-stripped — the providers' rule. */
export function canonicalPullRequestHost(host: string): string {
  return host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const PATH_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const REF = /^[0-9]{1,12}$/;

/**
 * The pane id for one pull request: `pr:<host>/<owner>/<repository>#<ref>`,
 * or null when any part is not a shape the id may carry.
 *
 * Case is folded on every part, not just the host. GitHub and GitLab both
 * treat owner and repository case-insensitively, so `owner/Repo#1` and
 * `Owner/repo#1` are one pull request — and the id is the pane's IDENTITY
 * (`openSurfaceInRegion` focuses an already-held pane by string equality),
 * so two spellings of one pull request must not mint two tabs.
 */
export function workspacePullRequestPaneId(
  key: WorkspacePullRequestPaneKey,
): string | null {
  const host = canonicalPullRequestHost(key.host);
  const owner = key.owner.toLowerCase();
  const repository = key.repository.toLowerCase();
  if (
    !HOST.test(host) ||
    !PATH_SEGMENT.test(owner) ||
    !PATH_SEGMENT.test(repository) ||
    !REF.test(key.ref)
  )
    return null;
  return `${WORKSPACE_PULL_REQUEST_PANE_ID_PREFIX}${host}/${owner}/${repository}#${key.ref}`;
}

/** The pull request a pane id names, or null when the id is not one. */
export function parseWorkspacePullRequestPaneId(
  id: string,
): WorkspacePullRequestPaneKey | null {
  if (!id.startsWith(WORKSPACE_PULL_REQUEST_PANE_ID_PREFIX)) return null;
  const rest = id.slice(WORKSPACE_PULL_REQUEST_PANE_ID_PREFIX.length);
  const hash = rest.indexOf('#');
  if (hash === -1) return null;
  const segments = rest.slice(0, hash).split('/');
  const ref = rest.slice(hash + 1);
  if (segments.length !== 3) return null;
  const [host, owner, repository] = segments as [string, string, string];
  const key = { host, owner, repository, ref };
  // Round-trip rather than re-testing the parts: the id the parse accepts is
  // exactly the id the factory mints, so a differently-cased or
  // differently-spelled variant is not "a pull request pane with an odd id",
  // it is not this id at all.
  return workspacePullRequestPaneId(key) === id ? key : null;
}

function instance(value: unknown): WorkspacePaneInstance | null {
  return parseWorkspacePaneInstance(value);
}

/**
 * One pull-request pane occurrence, bound to the Project whose checkout the
 * review resolves against. Its instance id IS its pane id, so the region
 * arrangement, the host document and the tab strip all name it the same way
 * and a second open of the same pull request is a reveal, not a duplicate.
 */
export function createWorkspacePullRequestPaneInstance(
  key: WorkspacePullRequestPaneKey,
  projectId: string,
): WorkspacePaneInstance | null {
  const identity = workspacePullRequestPaneId(key);
  if (!identity || !projectId || projectId !== projectId.trim()) return null;
  return instance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR_ID,
    instanceId: identity,
    stateKey: identity,
    boundContext: {
      projectId,
      sourceId: WORKSPACE_PULL_REQUEST_PANE_SOURCE_ID,
    },
  });
}

export function isCanonicalWorkspacePullRequestPaneInstance(
  candidate: WorkspacePaneInstance,
): boolean {
  const identity = String(candidate.instanceId);
  const context = candidate.boundContext;
  return (
    candidate.descriptorId === WORKSPACE_PULL_REQUEST_PANE_DESCRIPTOR_ID &&
    identity === String(candidate.stateKey) &&
    parseWorkspacePullRequestPaneId(identity) !== null &&
    typeof context?.projectId === 'string' &&
    context.projectId.length > 0 &&
    context.projectId === context.projectId.trim() &&
    context.sourceId === WORKSPACE_PULL_REQUEST_PANE_SOURCE_ID &&
    context.taskId === undefined &&
    context.sessionId === undefined &&
    context.runId === undefined &&
    context.workspaceId === undefined &&
    context.layoutId === undefined &&
    context.contribution === undefined &&
    Object.keys(context).length === 2
  );
}
