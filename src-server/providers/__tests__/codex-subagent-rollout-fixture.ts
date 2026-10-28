import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A scrubbed codex-cli 0.162.1 rollout of a spawned subagent thread, in the
 * exact record shapes Codex writes (copied from a real
 * `~/.codex/sessions/**\/rollout-*.jsonl` whose `session_meta.source` is
 * `subagent.thread_spawn`): `session_meta`, then the turn's `event_msg`,
 * `response_item`, `world_state`, `turn_context` and `token_usage_record`
 * records in their real order. Ids, paths, account ids, model and client
 * names and all free text are scrubbed; a few texts are readable
 * placeholders the tests assert.
 *
 * Read by a LITERAL module-anchored URL (the path-read pin boundary cannot
 * see a read through a helper parameter).
 */
const FIXTURE = readFileSync(
  fileURLToPath(
    new URL('./fixtures/codex-0.162.1-subagent-rollout.jsonl', import.meta.url),
  ),
  'utf8',
);

/** A UUIDv7 child thread id: its timestamp names its day directory. */
export const CODEX_ROLLOUT_THREAD_ID = '01a15c8b-0000-7000-8000-000000000003';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The local day Codex files a thread under: its UUIDv7 time. */
export function codexRolloutDay(threadId: string): [string, string, string] {
  const ms = Number.parseInt(threadId.replaceAll('-', '').slice(0, 12), 16);
  const date = new Date(ms);
  return [
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ];
}

/**
 * Writes the fixture as Codex lays it out under a fresh `CODEX_HOME`:
 * `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl`. The
 * `session_meta` names `metaThreadId` (default: the file's own thread id).
 * `extraRecords` are appended, as Codex appends while the child runs.
 */
export function installCodexSubagentRollout(
  makeTempDir: (prefix: string) => string,
  options: {
    threadId?: string;
    metaThreadId?: string;
    day?: [string, string, string];
    home?: string;
    extraRecords?: readonly Record<string, unknown>[];
  } = {},
): { home: string; file: string; threadId: string } {
  const threadId = options.threadId ?? CODEX_ROLLOUT_THREAD_ID;
  const home = options.home ?? makeTempDir('station-codex-home-');
  const [year, month, day] = options.day ?? codexRolloutDay(threadId);
  const directory = join(home, 'sessions', year, month, day);
  mkdirSync(directory, { recursive: true });
  const records = FIXTURE.trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const meta = records[0] as { type: string; payload: { id: string } };
  if (meta.type !== 'session_meta') throw new Error('fixture lost its meta');
  meta.payload.id = options.metaThreadId ?? threadId;
  const file = join(
    directory,
    `rollout-${year}-${month}-${day}T00-00-00-${threadId}.jsonl`,
  );
  writeFileSync(
    file,
    `${[...records, ...(options.extraRecords ?? [])]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  );
  return { home, file, threadId };
}
