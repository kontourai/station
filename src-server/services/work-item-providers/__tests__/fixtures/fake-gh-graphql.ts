/**
 * A fake `gh` for `gh api graphql` at the process seam (#4508): a real
 * executable, started by the real process-group runner, that records each
 * call's variables and answers from a table keyed by the item number and the
 * two cursors the follow-up reader sends. A call with no answer fails the way
 * gh does, so a test cannot pass on a read it never set up.
 *
 * The answers in `github-follow-ups/*.json` are github.com GraphQL answers to
 * `FOLLOW_UP_QUERY`'s shape, captured with gh 2.x on 2026-11-04 from a public
 * repository and sanitized: every key, `__typename`, enum, id, cursor and
 * time is as GitHub sent it; the repository, human logins, URLs' repository
 * path, file paths and all body text are replaced. Two edits on top: the
 * page-1 pull request answer keeps three check runs and one of them reports
 * FAILURE (its real conclusion was SUCCESS), and page 2 omits `commits`, as
 * GitHub does for `@include(if: false)`.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'github-follow-ups');

export function fixture(name: string): any {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

export interface GraphqlCall {
  hostname: string;
  number: string;
  commentsAfter: string | null;
  reviewsAfter: string | null;
  withChecks: string;
  cwd: string;
}

const key = (number: number, comments?: string, reviews?: string) =>
  `${number}|${comments ?? ''}|${reviews ?? ''}`;

/** Answer the read of item `number` after these cursors with `payload`. */
export function answer(
  dir: string,
  request: { number: number; commentsAfter?: string; reviewsAfter?: string },
  payload: unknown,
): void {
  const path = join(dir, 'answers.json');
  const table = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  table[key(request.number, request.commentsAfter, request.reviewsAfter)] =
    payload;
  writeFileSync(path, JSON.stringify(table));
}

/** Every later call hangs until killed. */
export function hang(dir: string): void {
  writeFileSync(join(dir, 'hang'), '');
}

/** Every later call fails as gh does with no login: exit 4. */
export function noLogin(dir: string): void {
  writeFileSync(join(dir, 'nologin'), '');
}

export function calls(dir: string): GraphqlCall[] {
  const log = join(dir, 'calls.log');
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

/** Write an executable named `gh` into `dir` and return its path. */
export function installFakeGhGraphql(dir: string): string {
  const gh = join(dir, 'gh');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const vars = {};
let hostname = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--hostname') hostname = args[i + 1];
  if (args[i] === '-f' || args[i] === '-F') {
    const pair = args[i + 1];
    const at = pair.indexOf('=');
    vars[pair.slice(0, at)] = pair.slice(at + 1);
  }
}
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({
  hostname,
  number: vars.number,
  commentsAfter: vars.commentsAfter ?? null,
  reviewsAfter: vars.reviewsAfter ?? null,
  withChecks: vars.withChecks,
  cwd: process.cwd(),
}) + '\\n');
if (fs.existsSync(path.join(dir, 'hang'))) {
  // Never answers; only a kill (the caller's deadline) ends it.
  setInterval(() => {}, 1000);
  return;
}
if (fs.existsSync(path.join(dir, 'nologin'))) {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n');
  process.exit(4);
}
const table = fs.existsSync(path.join(dir, 'answers.json'))
  ? JSON.parse(fs.readFileSync(path.join(dir, 'answers.json'), 'utf8'))
  : {};
const k = [vars.number, vars.commentsAfter ?? '', vars.reviewsAfter ?? ''].join('|');
if (args[0] !== 'api' || args[1] !== 'graphql' || !(k in table)) {
  process.stderr.write('gh: no fake answer for ' + k + '\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify(table[k]));
`;
  writeFileSync(gh, script);
  chmodSync(gh, 0o755);
  return gh;
}
