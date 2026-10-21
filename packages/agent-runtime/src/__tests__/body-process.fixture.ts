import { DatabaseSync } from 'node:sqlite';
import { encode } from '../encoding.js';
import { DEFAULT_MODEL_POLICY } from '../index.js';
import { openSqliteRuntimeBodies } from '../sqlite.js';

const path = process.argv[2];
const phase = process.argv[3];
if (!path) throw Error('host path required');
const database = new DatabaseSync(path);
database.exec(
  'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;',
);
const bodies = openSqliteRuntimeBodies({
  database,
  policy: DEFAULT_MODEL_POLICY,
});
const hold = () => {
  process.send?.({ phase }, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
};
if (phase === 'before-commit') {
  database.function('hold_runtime_body', () => {
    hold();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return 0;
  });
  database.exec(
    'CREATE TRIGGER fixture_hold_body AFTER INSERT ON agent_runtime_bodies BEGIN SELECT hold_runtime_body();END;',
  );
}
const ref = await bodies.put(
  'runtime-ai-sdk-v3-part/1',
  encode({ type: 'text-delta', id: 'a', delta: 'PROCESS-DURABLE' }),
);
if (phase === 'after-commit')
  process.send?.({ phase, ref }, () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  });
