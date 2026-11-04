// A local preview of /insights and /public/ with synthetic data: the real
// Worker handler and LiteReceiver over in-memory SQLite, seeded with about
// four months of generated pings through the receiver's own ingest and
// maintenance. Nothing leaves this machine. Run from the repository root:
//
//   npx tsx deploy/telemetry-worker/test/preview-server.ts [port] [--with-tokens]
//
// It prints a throwaway operator key for the /insights sign-in.
// `--with-tokens` adds a simulated per-engine token dimension to the insights
// answer, to preview that panel before the contract carries the field.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { LiteReceiver, LiteReceiverStore } from '../src/receiver.ts';
import { handleRequest } from '../src/worker.ts';
import { allow, dailyPing, fakeStorage } from './helpers.ts';

const port = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? 48792);
const withTokens = process.argv.includes('--with-tokens');
const key = `sto_${randomBytes(32).toString('base64url')}`;
const storage = fakeStorage(new DatabaseSync(':memory:'));
const store = new LiteReceiverStore(storage);

// A deterministic generator, so every preview looks the same.
let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(weighted: [T, number][]): T => {
  let r = random() * weighted.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, w] of weighted) {
    r -= w;
    if (r <= 0) return value;
  }
  return weighted[0][0];
};
const address = () =>
  `10.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}`;

const channels = ['nightly', 'preview', 'stable'] as const;
store.createSource({
  id: 'station',
  publisher: 'kontour',
  channels: [...channels],
  registryIds: [],
  releaseVersions: [],
  versionPolicy: 'semver',
});

const DAY = 86_400_000;
const now = Date.now();
const today = Math.floor(now / DAY) * DAY;
const start = today - 125 * DAY;
for (let day = start; day <= today; day += DAY) {
  const d = (day - start) / DAY;
  const date = new Date(day);
  const weekday = (date.getUTCDay() + 6) % 7;
  const weekend = weekday >= 5 ? 0.72 : 1;
  const partial = day === today ? (now - today) / DAY : 1;
  const actives = Math.round(
    (60 + d * 2.1 + random() * 12) * weekend * partial,
  );
  const fresh = Math.round((4 + d * 0.09 + random() * 4) * partial);
  const nightly = `0.11.0-nightly.${2380 + Math.floor(d / 1.1)}`;
  for (let i = 0; i < actives; i++) {
    const channel = pick<(typeof channels)[number]>([
      ['nightly', 5],
      ['preview', 3],
      ['stable', 2],
    ]);
    const version =
      channel === 'nightly'
        ? random() < 0.7
          ? nightly
          : `0.11.0-nightly.${2380 + Math.floor(d / 1.1) - 1 - Math.floor(random() * 6)}`
        : channel === 'preview'
          ? d > 70
            ? pick([
                ['0.11.0-preview.3', 6],
                ['0.11.0-preview.2', 2],
              ])
            : '0.11.0-preview.2'
          : d > 90
            ? pick([
                ['0.10.4', 5],
                ['0.10.3', 2],
              ])
            : pick([
                ['0.10.3', 5],
                ['0.10.2', 1],
              ]);
    const engines = [
      ...(random() < 0.68 ? ['claude'] : []),
      ...(random() < 0.47 ? ['codex'] : []),
      ...(random() < 0.12 ? ['ollama'] : []),
      ...(random() < 0.08 ? ['acp'] : []),
      ...(random() < 0.05 ? ['bedrock'] : []),
    ];
    const platform = pick([
      ['darwin', 6],
      ['linux', 3],
      ['win32', 2],
      ['android', 1],
    ]);
    store.ingest(
      'station',
      {
        ...dailyPing(),
        event_id: randomUUID(),
        channel,
        version,
        platform,
        arch:
          platform === 'darwin' || platform === 'android'
            ? 'arm64'
            : pick([
                ['x64', 4],
                ['arm64', 1],
              ]),
        surfaces_today: [
          ...(random() < 0.8 ? ['desktop'] : []),
          ...(random() < 0.45 ? ['web'] : []),
          ...(random() < 0.3 ? ['cli'] : []),
          ...(random() < 0.18 ? ['ios'] : []),
          ...(random() < 0.1 ? ['android'] : []),
        ],
        first_active_this_week:
          random() < [0.92, 0.3, 0.22, 0.18, 0.15, 0.12, 0.1][weekday],
        first_active_this_month:
          random() < (date.getUTCDate() === 1 ? 0.9 : 0.06),
        install_age_bucket:
          i < fresh
            ? '0d'
            : pick([
                ['1-7d', 2],
                ['8-30d', 3],
                ['31-90d', 4],
                ['91d+', 2],
              ]),
        engines_used_today: engines,
        public_plugins_enabled: [],
        engine_connect_failures: engines
          .filter(() => random() < 0.1)
          .map((engine) => ({
            engine,
            bucket: pick([
              ['1', 4],
              ['2-3', 2],
              ['4+', 1],
            ]),
          })),
        safe_mode_entered: random() < 0.03 ? 1 : 0,
        plugin_disabled_after_crash: 0,
      },
      address(),
      true,
      day + Math.floor(random() * DAY * partial),
    );
  }
  if (random() < 0.15)
    store.ingest(
      'station',
      {
        publisher: 'kontour',
        action: 'tier-lowered',
        reason: pick([
          ['privacy', 2],
          ['not-useful', 1],
        ]),
      },
      address(),
      true,
      day + 1000,
    );
  if (day < today) store.maintain(day + DAY + 60_000);
}

const object = new LiteReceiver({ storage });
const env = {
  LITE_RECEIVER: {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        const response = await object.fetch(request);
        if (!withTokens) return response;
        const data = await response
          .clone()
          .json()
          .catch(() => null);
        if (data?.scope !== 'operator-insights') return response;
        // Simulated: the contract does not carry this field yet.
        const share = (engine: string, bucket: string, p: number) => [
          `${engine}:${bucket}`,
          data.dimensions.engines_used_today?.[engine]?.map((n: number) =>
            Math.round(n * p),
          ) ?? [],
        ];
        data.dimensions.engine_tokens_today = Object.fromEntries([
          share('claude', '10k-100k', 0.25),
          share('claude', '100k-1M', 0.45),
          share('claude', '1M-10M', 0.25),
          share('claude', '10M+', 0.05),
          share('codex', '10k-100k', 0.35),
          share('codex', '100k-1M', 0.45),
          share('codex', '1M-10M', 0.2),
          share('ollama', '1-10k', 0.3),
          share('ollama', '10k-100k', 0.6),
          share('ollama', '100k-1M', 0.1),
        ]);
        return Response.json(data);
      },
    }),
  },
  OPERATOR_KEY: key,
  LITE_PER_IP_LIMITER: allow,
  LITE_GLOBAL_LIMITER: allow,
  READ_PER_IP_LIMITER: allow,
};

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === 'string') headers.set(name, value);
  const response = await handleRequest(
    new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    }),
    env,
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `Preview on http://127.0.0.1:${port}/insights and /public/\nOperator key: ${key}\n`,
  );
});
