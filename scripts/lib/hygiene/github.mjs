/**
 * GitHub reads for the code hygiene checks, through the `gh` CLI.
 *
 * Every failure to reach GitHub (no `gh`, no token, no network, a refused or
 * malformed response) raises {@link GithubUnavailableError}. The checks turn
 * that into NOT_VERIFIED; it is never read as "no findings".
 *
 * `STATION_HYGIENE_GH` replaces the command with a JSON array such as
 * `["node","/path/fake-gh.mjs"]`, so tests run the real query and parsing
 * path offline against a recorded response.
 */
import { spawnSyncBounded } from '../bounded-capture.mjs';

export const DEFAULT_REPOSITORY = 'kontourai/station';
/** GraphQL aliases per request; GitHub's node limit leaves ample headroom. */
const BATCH = 100;

export class GithubUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GithubUnavailableError';
  }
}

function ghCommand(env) {
  const override = env.STATION_HYGIENE_GH;
  if (!override) return ['gh'];
  let parsed;
  try {
    parsed = JSON.parse(override);
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    !parsed.every((part) => typeof part === 'string')
  )
    throw new Error('STATION_HYGIENE_GH must be a JSON array of strings');
  return parsed;
}

function parseRepository(repository) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository ?? '');
  if (!match) throw new Error(`repository must be owner/name: ${repository}`);
  return { owner: match[1], name: match[2] };
}

/**
 * @param {{ repository?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function createGithub({
  repository = DEFAULT_REPOSITORY,
  env = process.env,
} = {}) {
  const { owner, name } = parseRepository(repository);
  const [command, ...prefix] = ghCommand(env);
  const issueCache = new Map();
  let maxNumber;

  /**
   * One GraphQL request. `gh` exits 1 when the response carries any error,
   * including the NOT_FOUND an absent number produces, so the body is parsed
   * whatever the exit status and only errors other than NOT_FOUND on a
   * requested alias are refusals.
   */
  function graphql(query) {
    const result = spawnSyncBounded(
      command,
      [...prefix, 'api', 'graphql', '-f', `query=${query}`],
      {
        encoding: 'utf8',
        windowsHide: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (result.error)
      throw new GithubUnavailableError(
        `cannot run ${command}: ${result.error.message}`,
      );
    let body;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      const detail = (result.stderr || result.stdout || '')
        .trim()
        .split('\n')[0];
      throw new GithubUnavailableError(
        `the GitHub query exited ${result.status} without a JSON response${detail ? `: ${detail}` : ''}`,
      );
    }
    const refusals = (body.errors ?? []).filter(
      (error) => error?.type !== 'NOT_FOUND' || error?.path?.length !== 2,
    );
    if (refusals.length || !body.data?.repository)
      throw new GithubUnavailableError(
        `GitHub refused the query: ${refusals.map((error) => error?.message ?? 'unknown error').join('; ') || 'no repository in the response'}`,
      );
    return body.data.repository;
  }

  return {
    repository: `${owner}/${name}`,
    /**
     * Resolve issue/pull request numbers. Each entry is
     * `{ kind: 'issue'|'pull'|'missing', state?, title? }`.
     * @param {Iterable<number>} numbers
     * @returns {Map<number, { kind: string, state?: string, title?: string }>}
     */
    resolve(numbers) {
      const wanted = [...new Set(numbers)].filter((n) => !issueCache.has(n));
      for (let start = 0; start < wanted.length; start += BATCH) {
        const chunk = wanted.slice(start, start + BATCH);
        const fields = chunk
          .map(
            (number) =>
              `n${number}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { state title } ... on PullRequest { state title } }`,
          )
          .join(' ');
        const data = graphql(
          `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`,
        );
        for (const number of chunk) {
          const node = data[`n${number}`];
          if (node === undefined)
            throw new GithubUnavailableError(`the response omitted #${number}`);
          issueCache.set(
            number,
            node === null
              ? { kind: 'missing' }
              : {
                  kind: node.__typename === 'PullRequest' ? 'pull' : 'issue',
                  state: node.state,
                  title: node.title,
                },
          );
        }
      }
      return new Map([...new Set(numbers)].map((n) => [n, issueCache.get(n)]));
    },
    /** The highest issue or pull request number in the repository. */
    maxNumber() {
      if (maxNumber !== undefined) return maxNumber;
      const data = graphql(
        `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { issues(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number } } pullRequests(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number } } } }`,
      );
      const values = [
        data.issues?.nodes?.[0]?.number,
        data.pullRequests?.nodes?.[0]?.number,
      ].filter((value) => Number.isInteger(value));
      if (!values.length)
        throw new GithubUnavailableError(
          'the response named no issue or pull request number',
        );
      maxNumber = Math.max(...values);
      return maxNumber;
    },
  };
}
