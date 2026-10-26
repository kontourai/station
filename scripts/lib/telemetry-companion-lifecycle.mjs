import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  selectArtifact,
  verifyReleaseManifest,
} from '../../packages/shared/src/release-manifest.mjs';
import {
  readCompanionFile,
  verifyTelemetryCompanion,
} from '../../src-server/services/telemetry-companion-artifact.mjs';

export function parsePriorCompanionOptions(args) {
  const names = [
    '--prior-companion',
    '--prior-parent-archive',
    '--prior-signed-manifest',
  ];
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert(
      names.includes(args[i]) &&
        args[i + 1] &&
        !args[i + 1].startsWith('--') &&
        !options[args[i]],
      'Unknown, duplicate or incomplete prior option',
    );
    options[args[i]] = resolve(args[i + 1]);
  }
  assert(
    args.length === 0 || Object.keys(options).length === names.length,
    'All prior authentication options are required',
  );
  return args.length ? options : undefined;
}

/** Authenticate the archive bytes, then compare the supplied payload to its signed parent. */
export async function authenticatePriorCompanion({
  options,
  output,
  command,
  env,
}) {
  const envelope = JSON.parse(
    (
      await readCompanionFile(options['--prior-signed-manifest'], 1024 * 1024)
    ).toString(),
  );
  const keys = JSON.parse(
    await readFile(
      new URL('../../config/release-manifest-keys.json', import.meta.url),
      'utf8',
    ),
  );
  const release = verifyReleaseManifest(envelope, keys, {
    expectedChannel: 'nightly',
  });
  const artifact = selectArtifact(release, 'linux', process.arch);
  assert.equal(artifact.format, 'tar.gz');
  const archive = join(output, 'prior-parent.tar.gz');
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    createReadStream(options['--prior-parent-archive'], {
      flags: constants.O_RDONLY | constants.O_NOFOLLOW,
    }),
    async function* boundedArchive(chunks) {
      for await (const chunk of chunks) {
        size += chunk.length;
        assert(
          size <= artifact.size && size <= 512 * 1024 * 1024,
          'Prior archive size bound',
        );
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(archive, { mode: 0o600, flags: 'wx' }),
    { signal: AbortSignal.timeout(90_000) },
  );
  assert.equal(size, artifact.size);
  assert.equal(hash.digest('hex'), artifact.sha256);
  const extracted = join(output, 'authenticated-prior');
  await mkdir(extracted, { mode: 0o700 });
  await command(
    'tar',
    ['-xzf', archive, '-C', extracted, 'station/telemetry-companion'],
    'extract authenticated prior companion only',
    env,
    90_000,
  );
  const directory = join(extracted, 'station/telemetry-companion');
  const manifest = await verifyTelemetryCompanion(directory);
  assert.equal(manifest.source, release.sourceSha);
  assert.deepEqual(
    await verifyTelemetryCompanion(options['--prior-companion']),
    manifest,
    'Explicit prior companion differs from authenticated parent',
  );
  return {
    directory,
    source: manifest.source,
    artifact,
    version: release.version,
    signature: 'pinned-key-verified',
    installationAuthority: false,
    qualification: 'build-only',
  };
}

const migrationTables = [
  'station_telemetry.migrations',
  'station_private_usage.migrations',
];

export function assertMigrationTransition(prior, upgraded, current) {
  for (const table of migrationTables) {
    assert(Array.isArray(prior[table]) && prior[table].length > 0);
    assert(Array.isArray(current[table]) && current[table].length > 0);
    assert.deepEqual(
      upgraded[table],
      current[table],
      `${table}: unsupported current history`,
    );
    for (const row of prior[table]) {
      assert.deepEqual(
        current[table].find((entry) => entry.version === row.version),
        row,
        `${table}: prior migration changed or missing`,
      );
    }
  }
}

/** Fresh volumes only; never mutates a user project or starts an old binary on schema 9. */
export async function exerciseCompanionLifecycle({
  output,
  snapshot,
  project,
  env,
  compose,
  ports,
  operator,
  sourceKey,
  receiptId,
  trendsPath,
  retainedProduct,
  command,
  request,
  mutate,
  poll,
  check,
  report,
  save,
  unusedPort,
  ownedProjects,
  retireProject,
  previous,
}) {
  const lifecycle = {
    protocol: 'station-companion-product-lifecycle/v2',
    scope: 'product-diagnostic-only-permanent-publication-suppression',
    installationAuthority: false,
    versionTransition: {
      state: previous ? 'pending' : 'NOT_VERIFIED',
      rollback: 'NOT_SUPPORTED',
      reason:
        'Schema 8 prior binary cannot serve schema 9; backup-before-upgrade rollback has not been qualified',
    },
  };
  report.lifecycle = lifecycle;
  const docker = (args, label, environment = env, stdin, refusal) =>
    command(
      'docker',
      ['--host', env.DOCKER_HOST, ...args],
      label,
      environment,
      150_000,
      stdin,
      refusal,
    );
  const sql = (comp, environment, query, label) =>
    docker(
      [
        ...comp,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'station_telemetry',
        '-d',
        'station_telemetry',
        '-At',
        '-c',
        query,
      ],
      label,
      environment,
    );
  async function digests(comp, environment) {
    const tables = (
      await sql(
        comp,
        environment,
        "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname LIKE 'station_%' ORDER BY 1",
        'inventory all owned application tables',
      )
    )
      .split('\n')
      .filter(Boolean);
    assert(
      tables.length >= 14 &&
        tables.every((name) =>
          /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(name),
        ),
      'Complete application table inventory required',
    );
    const result = {};
    for (const table of tables)
      result[table] = await sql(
        comp,
        environment,
        `SELECT count(*)||':'||md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) FROM ${table} t`,
        `digest ${table}`,
      );
    return result;
  }
  async function migrationHistory(comp, environment) {
    const history = {};
    for (const table of migrationTables) {
      history[table] = JSON.parse(
        await sql(
          comp,
          environment,
          `SELECT coalesce(json_agg(t ORDER BY version),'[]'::json) FROM (SELECT version,digest FROM ${table}) t`,
          `capture exact migration history ${table}`,
        ),
      );
    }
    return history;
  }
  async function fresh(name) {
    const owned = `${project}-${name}`;
    ownedProjects.push(owned);
    const selected = await Promise.all([
      unusedPort(),
      unusedPort(),
      unusedPort(),
    ]);
    assert.equal(new Set([...selected, ...ports]).size, 6);
    const environment = {
      ...env,
      COMPOSE_PROJECT_NAME: owned,
      TELEMETRY_PRODUCT_PORT: String(selected[0]),
      TELEMETRY_OTLP_PORT: String(selected[1]),
      TELEMETRY_GRAFANA_PORT: String(selected[2]),
    };
    const comp = [
      'compose',
      '-p',
      owned,
      '-f',
      join(snapshot, 'deployment/compose.yaml'),
    ];
    assert.equal(
      await docker(
        ['ps', '-aq', '--filter', `label=com.docker.compose.project=${owned}`],
        'require unused project identity',
      ),
      '',
    );
    assert.equal(
      await docker(
        [
          'volume',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${owned}`,
        ],
        'require fresh volume identity',
      ),
      '',
    );
    await docker(
      [
        ...comp,
        'up',
        '-d',
        '--no-build',
        '--pull',
        'never',
        '--wait',
        '--wait-timeout',
        '120',
        'postgres',
      ],
      'create fresh isolated database only',
      environment,
    );
    return { comp, environment, port: selected[0], project: owned };
  }
  const restore = (target, backup) =>
    docker(
      [
        ...target.comp,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-v',
        'ON_ERROR_STOP=1',
        '-U',
        'station_telemetry',
        '-d',
        'station_telemetry',
        '-f',
        '-',
      ],
      'restore private SQL before receiver activation',
      target.environment,
      backup,
    );
  const fence = (target, refusal) =>
    docker(
      [
        ...target.comp,
        'run',
        '--rm',
        '--no-deps',
        'receiver',
        'node',
        'dist/main.mjs',
        '--fence-managed-restore',
      ],
      'managed preactivation restore fence',
      target.environment,
      undefined,
      refusal,
    );
  const activate = async (target, label) => {
    await docker(
      [
        ...target.comp,
        'up',
        '-d',
        '--force-recreate',
        '--no-build',
        '--pull',
        'never',
        '--wait',
        '--wait-timeout',
        '120',
        'receiver',
      ],
      label,
      target.environment,
    );
    await poll(
      'restored operator storage',
      async () =>
        (await request(target.port, '/v1/operator/storage', operator))
          .status === 200,
    );
  };
  await docker(
    [...compose, 'stop', '--timeout', '15', 'receiver'],
    'quiesce original receiver before backup',
  );
  // Controlled retained-history fixture, not evidence of privacy-safe publication.
  await sql(
    compose,
    env,
    `
    INSERT INTO station_telemetry.publisher_keys(publisher,credential_hash)
      VALUES('publisher:qualification',decode('${createHash('sha256')
        .update(`stq_${'q'.repeat(43)}`)
        .digest('hex')}','hex'));
    INSERT INTO station_telemetry.lite_publications(week,publisher)
      VALUES(date_trunc('week',current_date)::date-7,'publisher:qualification');
    INSERT INTO station_telemetry.lite_published(week,publisher,dimension,value,estimate)
      VALUES(date_trunc('week',current_date)::date-7,'publisher:qualification','channel','stable',37);
  `,
    'seed explicit synthetic sealed-history and copied publisher-key controls',
  );
  lifecycle.historyFixture =
    'synthetic sealed row; does not establish privacy reconciliation';
  const before = await digests(compose, env);
  lifecycle.before = before;
  const currentMigrations = await migrationHistory(compose, env);
  lifecycle.currentMigrations = currentMigrations;
  const backup = `${await docker([...compose, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'station_telemetry', '-d', 'station_telemetry', '--no-owner', '--no-privileges'], 'bounded fresh logical backup')}\n`;
  const backupPath = join(output, 'fresh-backup.sql');
  await writeFile(backupPath, backup, { mode: 0o600, flag: 'wx' });
  lifecycle.backupSha256 = createHash('sha256')
    .update(await readFile(backupPath))
    .digest('hex');
  await save();
  await retireProject(project);
  const target = await fresh('restore');
  lifecycle.restoreProject = target.project;
  await restore(target, backup);
  lifecycle.restored = await digests(target.comp, target.environment);
  assert.deepEqual(
    lifecycle.restored,
    before,
    'Fresh restore must retain every application table',
  );
  const activeSources = Number(
    await sql(
      target.comp,
      target.environment,
      "SELECT count(*) FROM station_telemetry.sources WHERE namespace='product' AND revoked_at IS NULL",
      'count copied product authority',
    ),
  );
  assert(Number.isSafeInteger(activeSources) && activeSources > 0);
  lifecycle.fence = JSON.parse(await fence(target));
  assert.deepEqual(lifecycle.fence, {
    protocol: 'station-managed-restore-fence/v1',
    scope: 'product-diagnostic-only',
    revokedSources: activeSources,
    publisherState: 'publication permanently suppressed; history unreconciled',
  });
  assert.equal(
    await sql(
      target.comp,
      target.environment,
      'SELECT count(*) FROM station_telemetry.publisher_keys',
      'copied publisher credentials withdrawn',
    ),
    '0',
  );
  const fenced = await digests(target.comp, target.environment);
  lifecycle.fenced = fenced;
  for (const [table, digest] of Object.entries(before)) {
    if (
      ![
        'station_telemetry.sources',
        'station_telemetry.publisher_keys',
        'station_telemetry.lite_publication_fence',
      ].includes(table)
    )
      assert.equal(
        fenced[table],
        digest,
        `${table}: fence changed retained state`,
      );
  }
  const publisher = { key: `stq_${'q'.repeat(43)}`, operator: true };
  async function observe() {
    assert.equal(
      (
        await request(target.port, `/v1/product/receipts/${receiptId}`, {
          key: sourceKey,
        })
      ).status,
      401,
    );
    assert.deepEqual(
      await request(target.port, trendsPath, operator),
      retainedProduct,
    );
    for (const [path, credentials] of [
      ['/v1/public/aggregates', {}],
      ['/v1/public/aggregates?cursor=1', {}],
      ['/v1/publishers/publisher%3Aqualification/aggregates', publisher],
    ]) {
      const result = await request(target.port, path, credentials);
      assert.equal(result.status, 200);
      assert.equal(result.cacheControl, 'no-store');
      assert.deepEqual(result.body.cells, []);
      assert.equal(result.body.nextCursor, null);
      assert.equal(
        result.body.publicationState,
        'publication permanently suppressed; history unreconciled',
      );
    }
  }
  await activate(target, 'activate managed fenced product receiver');
  await observe();
  await activate(target, 'recreate fenced process and its caches');
  await observe();
  const recreated = await digests(target.comp, target.environment);
  lifecycle.recreated = recreated;
  for (const [table, digest] of Object.entries(fenced))
    assert.equal(
      recreated[table],
      digest,
      `${table}: recreation changed retained state`,
    );
  await check(
    'fresh isolated PostgreSQL backup SHA and all-table row digests; managed fence; copied key 401; permanent publication suppression across recreation; operator query retained',
  );
  // A separate restored database keeps the negative control out of the accepted restore.
  await retireProject(target.project);
  const negative = await fresh('private-negative');
  await restore(negative, backup);
  await sql(
    negative.comp,
    negative.environment,
    "INSERT INTO station_private_usage.vaults(id,revoked) VALUES(repeat('c',64),true); UPDATE station_private_usage.capacity SET vaults=vaults+1 WHERE singleton",
    'seed copied revoked private custody negative',
  );
  const negativeBefore = await digests(negative.comp, negative.environment);
  await fence(negative, 'private_restore_unsupported');
  assert.deepEqual(
    await digests(negative.comp, negative.environment),
    negativeBefore,
    'Refused private restore must be atomic',
  );
  assert.equal(
    await docker(
      [
        'ps',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${negative.project}`,
        '--filter',
        'label=com.docker.compose.service=receiver',
      ],
      'private custody must never activate',
    ),
    '',
  );
  lifecycle.privateCustody = 'refused-before-activation';
  await check(
    'copied private custody refuses managed fence atomically without activation',
  );
  await retireProject(negative.project);
  if (previous) {
    lifecycle.previousRelease = previous;
    assert.notEqual(
      previous.source,
      report.source,
      'Prior release must differ from current source',
    );
    const transition = await fresh('transition');
    const oldImage = `${project}-prior`;
    await docker(
      [
        'build',
        '--label',
        `station.telemetry.qualifier=${project}`,
        '-t',
        oldImage,
        previous.directory,
      ],
      'build authenticated exact prior payload',
    );
    lifecycle.previousImage = await docker(
      ['image', 'inspect', oldImage, '--format', '{{.Id}}'],
      'bind prior image identity',
    );
    const old = {
      ...transition,
      environment: {
        ...transition.environment,
        TELEMETRY_RECEIVER_IMAGE: oldImage,
      },
    };
    await activate(old, 'start authenticated prior on its own fresh database');
    const oldKey = `stp_${'t'.repeat(43)}`;
    const sourceId = '12345678-1234-4234-8234-123456789abc';
    assert.equal(
      (
        await mutate(
          old.port,
          '/v1/operator/sources',
          {
            ...operator,
            body: {
              id: sourceId,
              label: 'version-transition',
              credentialHash: createHash('sha256').update(oldKey).digest('hex'),
            },
          },
          'provision authenticated prior product source',
        )
      ).status,
      201,
    );
    const inventory = (await request(old.port, '/health/live')).body
      .inventoryRevision;
    const now = new Date().toISOString();
    const committed = await mutate(
      old.port,
      '/v1/product/events',
      {
        key: oldKey,
        body: {
          schema_version: 1,
          inventory_revision: inventory,
          distinct_id: 'd'.repeat(64),
          events: [
            {
              event_id: '22345678-1234-4234-8234-123456789abc',
              event: 'engine_turn',
              occurred_at: now,
              observed_at: now,
              build: {
                version: '1.2.3',
                platform: 'linux',
                arch: process.arch,
              },
              properties: { engine: 'codex', outcome: 'completed' },
            },
          ],
        },
      },
      'commit prior version product observation',
    );
    assert.equal(committed.status, 202);
    assert.equal(committed.body.receipt.inserted, 1);
    const priorReceipt = await request(
      old.port,
      `/v1/product/receipts/${committed.body.receipt.receiptId}`,
      { key: oldKey },
    );
    assert.equal(priorReceipt.status, 200);
    const window = new URLSearchParams({
      from: new Date(Date.now() - 86400000).toISOString(),
      to: new Date(Date.now() + 300000).toISOString(),
    });
    const queryPath = `/v1/operator/trends?${window}`;
    const oldQuery = await request(old.port, queryPath, operator);
    assert.equal(oldQuery.status, 200);
    assert(oldQuery.body.rows.length > 0);
    await docker(
      [...old.comp, 'stop', '--timeout', '15', 'receiver'],
      'stop prior before upgrade',
      old.environment,
    );
    const oldTables = await digests(old.comp, old.environment);
    lifecycle.priorDigests = oldTables;
    const priorMigrations = await migrationHistory(old.comp, old.environment);
    lifecycle.priorMigrations = priorMigrations;
    const originalBackup = `${await docker([...old.comp, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'station_telemetry', '-d', 'station_telemetry', '--no-owner', '--no-privileges'], 'capture original pre-upgrade backup', old.environment)}\n`;
    await writeFile(join(output, 'prior-before-upgrade.sql'), originalBackup, {
      mode: 0o600,
      flag: 'wx',
    });
    lifecycle.priorBackupSha256 = createHash('sha256')
      .update(originalBackup)
      .digest('hex');
    await activate(transition, 'upgrade prior database to exact current image');
    assert.deepEqual(
      await request(transition.port, queryPath, operator),
      oldQuery,
    );
    assert.deepEqual(
      await request(
        transition.port,
        `/v1/product/receipts/${committed.body.receipt.receiptId}`,
        { key: oldKey },
      ),
      priorReceipt,
    );
    const upgraded = await digests(transition.comp, transition.environment);
    lifecycle.upgradedDigests = upgraded;
    for (const [table, digest] of Object.entries(oldTables)) {
      if (!migrationTables.includes(table))
        assert.equal(
          upgraded[table],
          digest,
          `${table}: upgrade changed retained rows`,
        );
    }
    const upgradedMigrations = await migrationHistory(
      transition.comp,
      transition.environment,
    );
    lifecycle.upgradedMigrations = upgradedMigrations;
    assertMigrationTransition(
      priorMigrations,
      upgradedMigrations,
      currentMigrations,
    );
    await retireProject(transition.project);
    lifecycle.versionTransition.state =
      'upgrade-executed-rollback-NOT_SUPPORTED';
    lifecycle.versionTransition.reason =
      'Prior to current product protocol executed; schema 9 cannot be downgraded in place to schema 8. Original backup retained but restore rollback NOT_VERIFIED';
    await check(
      'authenticated prior product protocol upgrades to current image retaining query receipt and preexisting table rows; rollback NOT_SUPPORTED',
    );
  }
  await save();
  return lifecycle;
}
