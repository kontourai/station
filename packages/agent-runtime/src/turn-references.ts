import type { DatabaseSync } from 'node:sqlite';

const permits = new WeakMap<DatabaseSync, { depth: number }>();
export function installAgentReferences(database: DatabaseSync) {
  const state = { depth: 0 };
  permits.set(database, state);
  database.function('station_agent_refs_allowed', () =>
    Number(state.depth > 0),
  );
}
export function withAgentReferences<T>(
  database: DatabaseSync,
  work: () => T,
): T {
  const state = permits.get(database);
  if (!state) throw new Error('DURABLE_AGENT_REFERENCE_WRITE_REFUSED');
  state.depth++;
  try {
    return work();
  } finally {
    state.depth--;
  }
}
const refs = (kind: string, row: string) => {
  if (kind === 'effects')
    return `SELECT DISTINCT 0 AS kind,unhex(substr(j.value,8)) AS digest FROM json_tree(${row}.record) j WHERE j.type='text' AND length(j.value)=71 AND j.value GLOB 'sha256:*' AND unhex(substr(j.value,8)) IS NOT NULL`;
  const digest =
    kind === 'body_nodes' ? 'unhex(j.value)' : 'unhex(substr(j.value,8))';
  const source =
    kind === 'body_nodes'
      ? `json_each(${row}.refs)`
      : `json_each(${row}.wire,'$.chunks')`;
  return `SELECT DISTINCT CASE WHEN EXISTS(SELECT 1 FROM agent_steps_body_nodes n WHERE n.digest=${digest}) THEN 1 ELSE 2 END AS kind,${digest} AS digest FROM ${source} j WHERE ${digest} IS NOT NULL`;
};
const add = (query: string) =>
  `INSERT INTO agent_steps_body_counts SELECT kind,digest,1 FROM (${query}) WHERE true ON CONFLICT(kind,digest) DO UPDATE SET n=n+1;`;
const subtract = (query: string) =>
  `UPDATE agent_steps_body_counts SET n=n-1 WHERE (kind,digest) IN (${query});`;
const ownDigest = (kind: string) =>
  kind === 'body_nodes' ? 'NEW.digest' : 'unhex(substr(NEW.digest,8))';
const targetKind = (kind: string) =>
  kind === 'bodies' ? 0 : kind === 'body_nodes' ? 1 : 2;
export const referenceDefinitions = [
  'CREATE TABLE agent_steps_body_counts(kind INTEGER NOT NULL CHECK(kind IN (0,1,2)), digest BLOB NOT NULL CHECK(length(digest)=32), n INTEGER NOT NULL CHECK(n>=0), PRIMARY KEY(kind,digest)) STRICT, WITHOUT ROWID',
  'CREATE INDEX agent_steps_body_counts_dead ON agent_steps_body_counts(kind,digest) WHERE n=0',
  ...['INSERT', 'UPDATE', 'DELETE'].map(
    (op) =>
      `CREATE TRIGGER agent_steps_body_counts_${op.toLowerCase()} BEFORE ${op} ON agent_steps_body_counts WHEN station_agent_refs_allowed()=0 BEGIN SELECT RAISE(ABORT,'DURABLE_AGENT_REFERENCE_WRITE_REFUSED'); END`,
  ),
  ...['bodies', 'body_nodes', 'body_chunks'].map(
    (kind) =>
      `CREATE TRIGGER agent_steps_ref_${kind}_own AFTER INSERT ON agent_steps_${kind} BEGIN INSERT INTO agent_steps_body_counts VALUES(${targetKind(kind)},${ownDigest(kind)},0) ON CONFLICT(kind,digest) DO NOTHING; END`,
  ),
  ...['effects', 'bodies', 'body_nodes'].flatMap((kind) => [
    `CREATE TRIGGER agent_steps_ref_${kind}_insert AFTER INSERT ON agent_steps_${kind} BEGIN ${add(refs(kind, 'NEW'))} END`,
    `CREATE TRIGGER agent_steps_ref_${kind}_delete AFTER DELETE ON agent_steps_${kind} BEGIN ${subtract(refs(kind, 'OLD'))} END`,
    `CREATE TRIGGER agent_steps_ref_${kind}_update AFTER UPDATE ON agent_steps_${kind} BEGIN ${subtract(`${refs(kind, 'OLD')} EXCEPT ${refs(kind, 'NEW')}`)} ${add(`${refs(kind, 'NEW')} EXCEPT ${refs(kind, 'OLD')}`)} END`,
  ]),
];
export const indexedBodyGuards = [
  "CREATE TRIGGER agent_steps_bodies_no_delete BEFORE DELETE ON agent_steps_bodies WHEN coalesce((SELECT n FROM agent_steps_body_counts WHERE kind=0 AND digest=unhex(substr(OLD.digest,8))),1)>0 BEGIN SELECT RAISE(ABORT,'immutable agent body'); END",
  "CREATE TRIGGER agent_steps_body_chunks_no_delete BEFORE DELETE ON agent_steps_body_chunks WHEN coalesce((SELECT n FROM agent_steps_body_counts WHERE kind=2 AND digest=unhex(substr(OLD.digest,8))),1)>0 BEGIN SELECT RAISE(ABORT,'immutable agent chunk'); END",
  "CREATE TRIGGER agent_steps_body_nodes_no_delete BEFORE DELETE ON agent_steps_body_nodes WHEN coalesce((SELECT n FROM agent_steps_body_counts WHERE kind=1 AND digest=OLD.digest),1)>0 BEGIN SELECT RAISE(ABORT,'immutable agent node'); END",
];
export function seedAgentReferences(database: DatabaseSync) {
  withAgentReferences(database, () => {
    database.exec(
      'INSERT INTO agent_steps_body_counts SELECT 0,unhex(substr(digest,8)),0 FROM agent_steps_bodies UNION SELECT 2,unhex(substr(digest,8)),0 FROM agent_steps_body_chunks UNION SELECT 1,digest,0 FROM agent_steps_body_nodes;',
    );
    for (const kind of ['effects', 'bodies', 'body_nodes']) {
      const query = refs(kind, 't');
      const source = query
        .replace('SELECT DISTINCT', 'SELECT DISTINCT t.rowid AS owner,')
        .replace(
          / FROM (json_tree|json_each)/,
          ` FROM agent_steps_${kind} t,$1`,
        );
      database.exec(
        `INSERT INTO agent_steps_body_counts SELECT kind,digest,count(*) FROM (${source}) GROUP BY kind,digest HAVING true ON CONFLICT(kind,digest) DO UPDATE SET n=n+excluded.n;`,
      );
    }
  });
}
