/**
 * A fake `gh` at the process seam (#4003), shared by every test that drives
 * `GitHubWorkItemObserver` through the real process-group runner: a real
 * executable that records how it was started and answers like `gh api` does,
 * with the REST payload on stdout and, on failure, the error body on stdout
 * plus gh's `gh: <message> (HTTP <status>)` line on stderr. Payloads keep the
 * exact key set GitHub's REST API returns (captured from `gh api` 2.x
 * against github.com); the values are synthetic.
 *
 * The fixture directory is read from `FAKE_GH_DIR` when set, else the
 * directory the fake was installed in, so a test that cannot pass the
 * observer an environment (the runtime's own observer) still reaches it.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function user(login: string) {
  return {
    login,
    id: 1001,
    node_id: 'MDQ6VXNlcjEwMDE=',
    avatar_url: 'https://avatars.githubusercontent.com/u/1001?v=4',
    gravatar_id: '',
    url: `https://api.github.com/users/${login}`,
    html_url: `https://github.com/${login}`,
    followers_url: `https://api.github.com/users/${login}/followers`,
    following_url: `https://api.github.com/users/${login}/following{/other_user}`,
    gists_url: `https://api.github.com/users/${login}/gists{/gist_id}`,
    starred_url: `https://api.github.com/users/${login}/starred{/owner}{/repo}`,
    subscriptions_url: `https://api.github.com/users/${login}/subscriptions`,
    organizations_url: `https://api.github.com/users/${login}/orgs`,
    repos_url: `https://api.github.com/users/${login}/repos`,
    events_url: `https://api.github.com/users/${login}/events{/privacy}`,
    received_events_url: `https://api.github.com/users/${login}/received_events`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

export function issue(overrides: Record<string, unknown> = {}) {
  const api = 'https://api.github.com/repos/acme/widgets';
  return {
    url: `${api}/issues/42`,
    repository_url: api,
    labels_url: `${api}/issues/42/labels{/name}`,
    comments_url: `${api}/issues/42/comments`,
    events_url: `${api}/issues/42/events`,
    html_url: 'https://github.com/acme/widgets/issues/42',
    id: 3500000042,
    node_id: 'I_kwDOAcmeWidgets42',
    number: 42,
    title: 'Widgets jam on Tuesdays',
    user: user('reporter'),
    labels: [
      {
        id: 11981532053,
        node_id: 'LA_kwDOAcme',
        url: `${api}/labels/bug`,
        name: 'bug',
        color: 'd73a4a',
        default: true,
        description: "Something isn't working",
        archived_at: null,
        archived_by: null,
      },
      {
        id: 11981532054,
        node_id: 'LA_kwDOAcmf',
        url: `${api}/labels/P1`,
        name: 'P1',
        color: 'b60205',
        default: false,
        description: null,
        archived_at: null,
        archived_by: null,
      },
    ],
    state: 'open',
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: '2026-10-01T09:00:00Z',
    updated_at: '2026-10-20T12:00:00Z',
    closed_at: null,
    author_association: 'MEMBER',
    type: null,
    active_lock_reason: null,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    issue_dependencies_summary: {
      blocked_by: 0,
      total_blocked_by: 0,
      blocking: 0,
      total_blocking: 0,
    },
    body: 'Steps:\n1. Wait for Tuesday.\n2. Observe the jam.',
    closed_by: null,
    reactions: {
      url: `${api}/issues/42/reactions`,
      total_count: 0,
      '+1': 0,
      '-1': 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    timeline_url: `${api}/issues/42/timeline`,
    performed_via_github_app: null,
    state_reason: null,
    pinned_comment: null,
    issue_field_values: [],
    ...overrides,
  };
}

export function comment(
  index: number,
  createdAt: string,
  body = `comment ${index}`,
) {
  const api = 'https://api.github.com/repos/acme/widgets';
  return {
    url: `${api}/issues/comments/${9000 + index}`,
    html_url: `https://github.com/acme/widgets/issues/42#issuecomment-${9000 + index}`,
    issue_url: `${api}/issues/42`,
    id: 9000 + index,
    node_id: `IC_kwDO${index}`,
    user: user(`commenter${index}`),
    created_at: createdAt,
    updated_at: createdAt,
    body,
    author_association: 'CONTRIBUTOR',
    reactions: {
      url: `${api}/issues/comments/${9000 + index}/reactions`,
      total_count: 0,
      '+1': 0,
      '-1': 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
    performed_via_github_app: null,
    minimized: null,
  };
}

/** gh's key for one endpoint in the fake's fixture directory. */
const key = (endpoint: string) => endpoint.replace(/[/?&=]/g, '_');

/** Answer `endpoint` with `payload`. */
export function answer(dir: string, endpoint: string, payload: unknown) {
  writeFileSync(join(dir, `${key(endpoint)}.json`), JSON.stringify(payload));
}

/** Fail `endpoint` the way `gh api` does for an HTTP error. */
export function fail(
  dir: string,
  endpoint: string,
  status: number,
  message: string,
) {
  writeFileSync(
    join(dir, `${key(endpoint)}.stdout`),
    JSON.stringify({
      message,
      documentation_url: 'https://docs.github.com/rest',
      status: String(status),
    }),
  );
  writeFileSync(
    join(dir, `${key(endpoint)}.stderr`),
    `gh: ${message} (HTTP ${status})\n`,
  );
  writeFileSync(join(dir, `${key(endpoint)}.exit`), '1');
}

/** One line per gh start: `cwd|GH_PROMPT_DISABLED|GH_HOST|args`. */
export function calls(dir: string): string[] {
  const log = join(dir, 'calls.log');
  return existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    : [];
}

/** Write an executable named `gh` into `dir` and return its path. */
export function installFakeGh(dir: string): string {
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      `dir="\${FAKE_GH_DIR:-${dir}}"`,
      'printf \'%s|%s|%s|%s\\n\' "$(pwd -P)" "$GH_PROMPT_DISABLED" "$GH_HOST" "$*" >> "$dir/calls.log"',
      'if [ -f "$dir/sleep" ]; then sleep 5; fi',
      'if [ -f "$dir/nologin" ]; then',
      "  echo 'To get started with GitHub CLI, please run:  gh auth login' >&2",
      "  echo 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.' >&2",
      '  exit 4',
      'fi',
      'endpoint=""',
      'for a in "$@"; do endpoint="$a"; done',
      "k=$(printf '%s' \"$endpoint\" | tr '/?&=' '____')",
      'if [ -f "$dir/$k.exit" ]; then',
      '  cat "$dir/$k.stdout"; cat "$dir/$k.stderr" >&2; exit "$(cat "$dir/$k.exit")"',
      'fi',
      'if [ -f "$dir/$k.json" ]; then cat "$dir/$k.json"; exit 0; fi',
      'printf \'{"message":"Not Found","status":"404"}\'',
      "echo 'gh: Not Found (HTTP 404)' >&2",
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  return gh;
}
