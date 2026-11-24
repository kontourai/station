import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveHomeDir } from '../../utils/paths.js';
import {
  type AcpIdentityHandshake,
  matchesAcpHandshakeIdentity,
} from './acp-handshake-facts.js';

const USER_INPUT = 14;
const MODEL_RESPONSE = 15;
const ERROR_MESSAGE = 17;
const MAX_NEW_STEPS = 4096;
const MAX_ERROR_BYTES = 16_384;
const ACP_PROFILE_DATA_DIR = 'antigravity-acp';

export class AntigravityPromptFailure extends Error {
  constructor(
    readonly code:
      | 'antigravity_upstream_not_found'
      | 'antigravity_upstream_bad_gateway',
    readonly kind: 'unavailable' | 'model_unavailable',
    message: string,
  ) {
    super(message);
  }
}

/** Local evidence travels out of band from the untrusted JSON-RPC response. */
export const antigravityPromptFailure = Symbol('antigravity prompt failure');

function privateEntry(path: string, directory: boolean): Stats | undefined {
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      stat.uid !== uid ||
      (stat.mode & 0o022) !== 0 ||
      !(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
    )
      return undefined;
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameEntry(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

/** Bind an explicit Station profile opt-in to the native CLI launch. */
export function antigravityOutcomeProfile(input: {
  command: string;
  args: readonly string[];
  geminiHome: string | undefined;
}): { path: string; identity: Stats; args: readonly string[] } | undefined {
  if (
    !input.geminiHome ||
    !isAbsolute(input.geminiHome) ||
    basename(input.command) !== 'agy' ||
    input.args.length !== 2 ||
    input.args[0] !== 'acp' ||
    input.args[1] !== '--process-per-session'
  )
    return undefined;
  const home = resolveHomeDir();
  if (
    resolve(input.geminiHome) !== join(home, 'engine-profiles', 'antigravity')
  )
    return undefined;
  try {
    const parent = join(realpathSync(home), 'engine-profiles');
    const profile = join(parent, 'antigravity');
    const stat = privateEntry(profile, true);
    if (privateEntry(parent, true) && stat && (stat.mode & 0o077) === 0)
      return {
        path: profile,
        identity: stat,
        args: [
          `--gemini-dir=${profile}`,
          `--app-data-dir=${ACP_PROFILE_DATA_DIR}`,
        ],
      };
  } catch {
    // The opted-in launch must stay in the dedicated profile.
  }
  throw new Error(
    'The dedicated Antigravity profile must be an owner-only directory in this Station home.',
  );
}

function readDatabase<T>(
  file: string,
  read: (db: DatabaseSync) => T,
): T | undefined {
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.enableDefensive(true);
    db.exec('PRAGMA trusted_schema = OFF; BEGIN');
    const table = db.prepare("PRAGMA table_list('steps')").get();
    const columns = db.prepare("PRAGMA table_xinfo('steps')").all();
    const index = columns.find((column) => column.name === 'idx');
    if (
      table?.type !== 'table' ||
      table.wr !== 0 ||
      index?.type !== 'INTEGER' ||
      index.pk !== 1 ||
      columns.some((column) => typeof column.pk === 'number' && column.pk > 1)
    )
      return undefined;
    return read(db);
  } finally {
    db.close();
  }
}

function databaseFilesSafe(file: string): boolean {
  let wal = false;
  let shm = false;
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (!lstatSync(file + suffix, { throwIfNoEntry: false })) continue;
    if (!privateEntry(file + suffix, false)) return false;
    if (suffix === '-wal') wal = true;
    if (suffix === '-shm') shm = true;
  }
  // SQLite can create a shared-memory index even on read-only WAL opens.
  return !wal || shm;
}

type PromptWatch = {
  failure: () => AntigravityPromptFailure | undefined;
  release: () => void;
};

const active = new Map<string, { count: number; ambiguous: boolean }>();

function checkFailure(
  db: DatabaseSync,
  start: number,
): AntigravityPromptFailure | undefined {
  const last = db
    .prepare(
      'SELECT idx, step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps ORDER BY idx DESC LIMIT 1',
    )
    .get(MAX_ERROR_BYTES);
  if (
    !last ||
    typeof last.idx !== 'number' ||
    last.idx <= start ||
    last.idx - start > MAX_NEW_STEPS ||
    last.type !== ERROR_MESSAGE ||
    !(last.payload instanceof Uint8Array)
  )
    return undefined;
  const inputs = db
    .prepare(
      'SELECT idx FROM steps WHERE idx > ? AND idx < ? AND step_type = ? ORDER BY idx LIMIT 2',
    )
    .all(start, last.idx, USER_INPUT);
  const inputIndex = inputs[0]?.idx;
  if (inputs.length !== 1 || typeof inputIndex !== 'number') return undefined;

  const text = new TextDecoder().decode(last.payload);
  const legacy =
    /\bError (\d{3}), Message: [^\n]{1,4096}?, Status: ([A-Z_]+|\d{3})\b/u.exec(
      text,
    );
  const current = /\b([A-Z_]+) \(code (\d{3})\):/u.exec(text);
  const useCurrent = current && (!legacy || current.index < legacy.index);
  const httpCode = useCurrent ? current[2] : legacy?.[1];
  const status = useCurrent ? current[1] : legacy?.[2];
  if (httpCode === '502' && (status === '502' || status === 'BAD_GATEWAY'))
    return new AntigravityPromptFailure(
      'antigravity_upstream_bad_gateway',
      'unavailable',
      'Antigravity could not reach its model service (502).',
    );
  if (httpCode !== '404' || status !== 'NOT_FOUND') return undefined;
  const modelResponded =
    db
      .prepare(
        'SELECT 1 FROM steps WHERE idx > ? AND idx < ? AND step_type = ? LIMIT 1',
      )
      .get(inputIndex, last.idx, MODEL_RESPONSE) !== undefined;
  return new AntigravityPromptFailure(
    'antigravity_upstream_not_found',
    modelResponded ? 'unavailable' : 'model_unavailable',
    modelResponded
      ? 'Antigravity lost access to its model service during this turn (404).'
      : 'Antigravity could not find the selected model or endpoint (404).',
  );
}

export function watchAntigravityPrompt(
  profile: ReturnType<typeof antigravityOutcomeProfile>,
  handshake: AcpIdentityHandshake | null,
  sessionId: string,
  fresh: boolean,
): PromptWatch | undefined {
  if (
    !profile ||
    !handshake ||
    !matchesAcpHandshakeIdentity(handshake, {
      agentInfoName: 'Antigravity ACP Server',
    }) ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)
  )
    return undefined;
  const engine = join(profile.path, ACP_PROFILE_DATA_DIR);
  const conversations = join(engine, 'conversations');
  const file = join(conversations, `${sessionId}.db`);
  const flight = active.get(file) ?? { count: 0, ambiguous: false };
  // A prompt handoff shares a database with the original prompt.
  if (flight.count > 0) flight.ambiguous = true;
  flight.count += 1;
  active.set(file, flight);
  const release = () => {
    flight.count -= 1;
    if (flight.count === 0) active.delete(file);
  };
  const unavailable = { failure: () => undefined, release };
  if (flight.ambiguous) return unavailable;
  try {
    const root = privateEntry(profile.path, true);
    const native = privateEntry(engine, true);
    const directory = privateEntry(conversations, true);
    const database = privateEntry(file, false);
    if (
      !root ||
      !sameEntry(profile.identity, root) ||
      !native ||
      !directory ||
      (!database && (!fresh || lstatSync(file, { throwIfNoEntry: false }))) ||
      !databaseFilesSafe(file)
    )
      return unavailable;
    const start = database
      ? readDatabase(
          file,
          (db) =>
            db.prepare('SELECT coalesce(max(idx), -1) AS idx FROM steps').get()
              ?.idx,
        )
      : -1;
    return {
      release,
      failure: () => {
        if (flight.ambiguous || typeof start !== 'number') return undefined;
        try {
          const current = privateEntry(file, false);
          const currentRoot = privateEntry(profile.path, true);
          const currentNative = privateEntry(engine, true);
          const currentDirectory = privateEntry(conversations, true);
          if (
            !current ||
            !currentRoot ||
            !currentNative ||
            !currentDirectory ||
            !sameEntry(root, currentRoot) ||
            !sameEntry(native, currentNative) ||
            !sameEntry(directory, currentDirectory) ||
            (database && !sameEntry(database, current)) ||
            !databaseFilesSafe(file)
          )
            return undefined;
          const failure = readDatabase(file, (db) => checkFailure(db, start));
          const after = privateEntry(file, false);
          if (after && sameEntry(current, after) && databaseFilesSafe(file))
            return failure;
          return undefined;
        } catch {
          return undefined;
        }
      },
    };
  } catch {
    return unavailable;
  }
}
