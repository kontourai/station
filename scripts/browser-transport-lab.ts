import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { serveApplicationChannel } from '@kontourai/station-connect/application-channel';
import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import {
  connectionDescriptionDigest,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { chromium, type Page } from '@playwright/test';
import { build, stop as stopBundler } from 'esbuild';
import datachannel from 'node-datachannel';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { ensureStationHomeSchemaSync } from '../src-server/domain/home-schema-gate.js';
import type { createStationConnectionProofIssuer } from '../src-server/services/ssh/connection-proof-issuer.js';
import { ConnectionSigningKeyStore } from '../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../src-server/services/ssh/environment-security-service.js';
import { bridgeApplicationChannels } from './lib/application-ipc.js';
import {
  runBrowserAccountScenario,
  runBrowserCookieAdoptionScenario,
} from './lib/browser-account-scenario.js';
import {
  browserApplicationAccountPrincipal,
  browserApplicationAccountRequest,
  browserBeginFreshRelayEnrollment,
  browserFinalizeAndActivateFreshRelayEnrollment,
  browserFreshProfileState,
  browserFreshRelayProjectRead,
} from './lib/browser-application-account.mjs';
import { browserCheckApplicationChannel } from './lib/browser-application-channel.mjs';
import { installRelayCandidatePairRecorder } from './lib/browser-relay-candidate-pair.mjs';
import {
  browserBrokerAdmitApplicationTransport,
  browserBrokerAdoptApplicationTransport,
  browserBrokerClose,
  browserBrokerConnect,
  browserBrokerConnectionId,
  browserBrokerProbeOrigin,
  browserBrokerReadStatus,
  browserBrokerReconnect,
  browserBrokerSelectedCandidatePair,
  browserBrokerTamperProof,
} from './lib/browser-self-hosted-broker.mjs';
import {
  browserAccept,
  browserChannelOpen,
  browserConnectionContext,
  browserFailed,
  browserHasNoRemoteDescription,
  browserOffer,
  browserReceived,
  browserRevokeConnectionTrust,
  browserSend,
  browserSetConnectionTrust,
  browserStats as readBrowserStats,
} from './lib/browser-transport-page.mjs';
import { startPionFixture } from './lib/browser-transport-pion.js';
import {
  runLabCommand,
  startLabRelay,
} from './lib/local-collaboration-process.mjs';
import { startRelayAccountStation } from './lib/local-collaboration-relay-account.js';
import { nodeApplicationChannel } from './lib/node-application-channel.js';
import { startSelfHostedBrokerProcess } from './lib/self-hosted-broker-process.js';

// Isolated transport evaluation; the opt-in account mode uses a real Station.
import { createTurnFixture, TURN_FIXTURE_IMAGE } from './lib/turn-fixture.js';

const args = process.argv.slice(2);
if (
  args.some(
    (arg) =>
      ![
        '--browser-turn=udp',
        '--browser-turn=tcp',
        '--keep',
        '--peer=pion',
        '--peer=node',
        '--fail-after-create',
        '--application-protocol',
        '--application-accounts',
        '--self-hosted-broker',
        '--station-ui',
      ].includes(arg),
  ) ||
  args.filter((arg) => arg.startsWith('--browser-turn=')).length > 1 ||
  args.filter((arg) => arg.startsWith('--peer=')).length > 1
)
  throw new Error(
    'Use --browser-turn=udp or --browser-turn=tcp and optional --keep',
  );
const peerAdapter = args.includes('--peer=pion') ? 'pion' : 'node';
const selfHostedBroker = args.includes('--self-hosted-broker');
const stationUi = args.includes('--station-ui');
const fixtureDocumentUrl = (origin: string) =>
  stationUi ? new URL('/__fixture', origin).href : origin;
if (
  selfHostedBroker &&
  (peerAdapter !== 'pion' || !args.includes('--application-accounts'))
)
  throw new Error(
    '--self-hosted-broker requires --peer=pion --application-accounts',
  );
if (stationUi && !selfHostedBroker)
  throw new Error('--station-ui requires --self-hosted-broker');
if (
  args.includes('--application-protocol') &&
  args.includes('--application-accounts')
)
  throw new Error('Choose one application fixture profile per run');
let accountStation:
  | Awaited<ReturnType<typeof startRelayAccountStation>>
  | undefined;
let brokerLab:
  | Awaited<ReturnType<typeof startSelfHostedBrokerProcess>>
  | undefined;
let accountReport: Record<string, unknown> | undefined;
let cookieAdoptionReport: Record<string, unknown> | undefined;
let cookieAdoptionSecrets: string[] = [];
const applicationObservations: Array<Record<string, unknown>> = [];
let freshRelayReport: Record<string, unknown> | undefined;
let freshRelayJourney:
  | Awaited<ReturnType<typeof runFreshRelayScenario>>
  | undefined;
let applicationProtocol:
  | { status: string; requestMarker: string; responseBytes: number }
  | undefined;
let sourceCommitSha: string | undefined;
let sourceWorktreeClean: boolean | undefined;
let pionExecutableSha256: string | undefined;
const browserTransport = args.includes('--browser-turn=tcp') ? 'tcp' : 'udp';
const pionExecutable = join(
  process.cwd(),
  '.kontourai/browser-transport',
  process.platform === 'win32' ? 'pion-peer.exe' : 'pion-peer',
);
process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), 'station-browser-transport-'));
const errors: unknown[] = [];
const abort = new AbortController();
const interrupt = () =>
  abort.abort(new Error('Browser transport lab interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
let report: Record<string, unknown> | undefined;
const username = 'station-fixture';
const password = randomBytes(24).toString('hex');
const turnFixture = createTurnFixture({
  directory: root,
  username,
  password,
  signal: abort.signal,
  failAfterCreate: args.includes('--fail-after-create'),
});
let turnUdpPort: number | undefined;
let turnTcpPort: number | undefined;
let relay: Awaited<ReturnType<typeof startLabRelay>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let viteServer: ViteDevServer | undefined;
type LabPeer = {
  close(): void | Promise<void>;
  getSelectedCandidatePair(): {
    local: { type: string };
    remote: { type: string };
  } | null;
};
const peers: LabPeer[] = [];
let pionProvenance:
  | Awaited<ReturnType<typeof startPionFixture>>['provenance']
  | undefined;
let stationUiRelayJourney: Record<string, unknown> | undefined;
let stationUiFailure: Record<string, unknown> | undefined;

function firstOwnedFailureLocation(error: unknown) {
  const stack = error instanceof Error ? error.stack : undefined;
  if (!stack) return undefined;
  for (const line of stack.split('\n')) {
    const frame = line.match(
      /(?:\(|\bat\s+)(file:\/\/\/[^)\s]+|\/[^)\s]+):(\d+):(\d+)\)?$/u,
    );
    if (!frame) continue;
    let absolute: string;
    try {
      absolute = frame[1].startsWith('file://')
        ? fileURLToPath(frame[1])
        : frame[1];
    } catch {
      continue;
    }
    const sourceFile = relative(process.cwd(), absolute);
    if (
      !sourceFile ||
      sourceFile === '..' ||
      sourceFile.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(sourceFile) ||
      sourceFile.length > 240
    )
      continue;
    const lineNumber = Number(frame[2]);
    const columnNumber = Number(frame[3]);
    if (
      !Number.isSafeInteger(lineNumber) ||
      !Number.isSafeInteger(columnNumber)
    )
      continue;
    return {
      file: sourceFile.replaceAll('\\', '/'),
      line: lineNumber,
      column: columnNumber,
    };
  }
  return undefined;
}
let clientProofScript = '';
let connectionTrust: ApprovedStationConnectionTrust;
let proofIssuer: ReturnType<typeof createStationConnectionProofIssuer>;
const admittedConnections = new Set<string>();
let securePageServer: ReturnType<typeof createHttpsServer> | undefined;
let secondarySecurePageServer: ReturnType<typeof createHttpsServer> | undefined;
let stationUpstreamPort: number | undefined;
function serveBrowserDocument(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  if (request.url === '/connection-proof.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(clientProofScript);
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    '<!doctype html><title>Station browser transport fixture</title><script src="/connection-proof.js"></script>',
  );
}
const server = createServer(serveBrowserDocument);

async function runFreshRelayScenario(input: {
  approvedPage: Page;
  pageOrigin: string;
}): Promise<{
  report: Record<string, unknown>;
  routingGrantId: string;
  readFreshProject(): Promise<number>;
  readRouteStatus(): Promise<unknown>;
  close(): Promise<void>;
}> {
  assert(accountStation && brokerLab && relay && browser);
  const station = accountStation;
  const broker = brokerLab;
  const activeRelay = relay;
  const browserOwner = browser;
  const freshContext = await browserOwner.newContext();
  const freshPage = await freshContext.newPage();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await freshPage.evaluate(browserBrokerClose).catch(() => {});
    await freshPage.close();
    await freshContext.close();
  };
  try {
    await freshPage.goto(fixtureDocumentUrl(input.pageOrigin));
    assert.notEqual(
      new URL(input.approvedPage.url()).origin,
      new URL(freshPage.url()).origin,
      'Fresh client must use a different HTTPS Origin',
    );
    const directStationHttpAttempts: string[] = [];
    freshPage.on('request', (request) => {
      try {
        if (new URL(request.url()).origin === station.station.base)
          directStationHttpAttempts.push(request.url());
      } catch {
        directStationHttpAttempts.push('invalid-request-url');
      }
    });
    await freshPage.evaluate(browserSetConnectionTrust, {
      trust: connectionTrust,
      approvedKeyId: await stationConnectionSigningKeyId(connectionTrust),
    });
    const turnPort =
      browserTransport === 'udp' ? turnUdpPort : activeRelay.port;
    assert(turnPort);
    const invitation = broker.issueInvitation({
      clientOrigin: input.pageOrigin,
      stationSigningKeyId: await stationConnectionSigningKeyId(connectionTrust),
      stationSigningGeneration: connectionTrust.generation,
    });
    const connected = await bounded(
      freshPage.evaluate(browserBrokerConnect, {
        brokerOrigin: broker.brokerOrigin,
        scope: invitation.scope,
        invitation,
        applicationOrigin: station.station.base,
        port: turnPort,
        username,
        password,
        transport: browserTransport,
      }),
      'fresh-device relay broker connect',
    );
    const previousGrantId = await input.approvedPage.evaluate(
      () =>
        (
          globalThis as unknown as {
            stationBrokerLab?: { credentials: { capture(): { id: string } } };
          }
        ).stationBrokerLab?.credentials.capture().id,
    );
    assert(previousGrantId);
    assert.notEqual(
      connected.routingGrantId,
      previousGrantId,
      'Independent browser profiles must receive distinct routing grants',
    );
    await freshPage.evaluate(browserBrokerAdmitApplicationTransport);
    const freshBrowserState = await freshPage.evaluate(
      browserFreshProfileState,
    );
    assert.equal(freshBrowserState.cookieJar, '');
    assert.equal(freshBrowserState.hasPriorAccountState, false);
    const cookiesBeforeBegin = await freshContext.cookies(station.station.base);
    assert.deepEqual(
      cookiesBeforeBegin,
      [],
      'Fresh browser context must have no cookies, including HttpOnly cookies, before begin',
    );
    const pending = await bounded(
      freshPage.evaluate(browserBeginFreshRelayEnrollment, {
        apiBase: station.station.base,
        stationId: station.station.stationId,
        username: station.browser.username,
        password: station.browser.password,
      }),
      'fresh relay begin/login over browser DataChannel',
    );
    assert.equal(pending.state, 'pending');
    assert.equal(pending.keyExtractable, false);
    assert.equal(pending.priorAccountStatePresent, false);
    assert.equal(pending.cookieJarEmpty, true);
    assert.deepEqual(pending.requestHeaderEvidence, [
      ['content-type', 'origin'],
      ['content-type', 'origin'],
    ]);
    await station.confirmFreshRelayRequest(pending.requestId);
    const activated = await bounded(
      freshPage.evaluate(browserFinalizeAndActivateFreshRelayEnrollment),
      'fresh relay finalize and signed activation ACK over browser DataChannel',
    );
    assert.equal(activated.status, 'passed');
    assert.equal(activated.enrollmentId, pending.enrollmentId);
    assert.equal(activated.beforeAckStatus, 401);
    assert.equal(activated.afterAckStatus, 200);
    assert.equal(activated.keyExtractable, false);
    assert.equal(activated.cookieJarEmpty, true);
    assert.equal(activated.priorAccountStateAbsent, true);
    const cookiesAfterAck = await freshContext.cookies(station.station.base);
    assert.deepEqual(
      cookiesAfterAck,
      [],
      'Fresh relay ceremony must not adopt or mint Station cookies',
    );
    assert.deepEqual(activated.enrollmentRequestHeaderEvidence, [
      ['content-type', 'origin'],
      ['content-type', 'origin'],
      ['content-type', 'origin'],
      ['content-type', 'origin'],
    ]);
    assert.deepEqual(
      directStationHttpAttempts,
      [],
      'Fresh browser account requests must stay on the encrypted broker DataChannel',
    );
    assert(activated.resourceHeaderNames.includes('authorization'));
    assert.equal(activated.resourceHeaderNames.includes('cookie'), false);

    const previousPrincipalId = await input.approvedPage.evaluate(
      browserApplicationAccountPrincipal,
    );
    assert.equal(
      activated.principalId,
      previousPrincipalId,
      'Fresh login must resolve to the same issuer-qualified person',
    );
    const approvedDeviceRead = await input.approvedPage.evaluate(
      browserApplicationAccountRequest,
      { path: '/api/projects/relay-shared' },
    );
    const freshDeviceRead = await freshPage.evaluate(
      browserFreshRelayProjectRead,
      { path: '/api/projects/relay-shared' },
    );
    assert.equal(approvedDeviceRead.status, 200);
    assert.equal(freshDeviceRead.status, 200);

    const report: Record<string, unknown> = {
      status: 'passed',
      transport: 'Chromium -> self-hosted broker -> StationRuntime Pion -> VAI',
      distinctClientOrigins: true,
      distinctRoutingGrants: true,
      connectionId: connected.connectionId,
      enrollmentId: activated.enrollmentId,
      deviceId: activated.deviceId,
      previousDeviceId: station.browser.deviceId,
      principalId: activated.principalId,
      cookieJarEmpty: freshBrowserState.cookieJar === '',
      browserContextCookiesBeforeBegin: cookiesBeforeBegin.map(
        ({ name, domain, path, httpOnly, secure }) => ({
          name,
          domain,
          path,
          httpOnly,
          secure,
        }),
      ),
      priorBrowserAccountStateAbsent:
        freshBrowserState.hasPriorAccountState === false,
      loginRequestHeaderEvidence: pending.requestHeaderEvidence,
      requestHeaderEvidence: activated.enrollmentRequestHeaderEvidence,
      directStationHttpAttempts: directStationHttpAttempts.length,
      simultaneousDeviceProjectReads: {
        previousDevice: approvedDeviceRead.status,
        freshDevice: freshDeviceRead.status,
      },
      protectedReadBeforeAck: activated.beforeAckStatus,
      protectedReadAfterAck: activated.afterAckStatus,
      privateKeyExtractable: activated.keyExtractable,
      accountCookieJarEmpty: activated.cookieJarEmpty,
      browserContextCookiesAfterAck: cookiesAfterAck.map(
        ({ name, domain, path, httpOnly, secure }) => ({
          name,
          domain,
          path,
          httpOnly,
          secure,
        }),
      ),
      postAckHeaderNames: activated.resourceHeaderNames,
      passwordMarkerSha256: createHash('sha256')
        .update(station.browser.password)
        .digest('hex'),
    };
    return {
      report,
      routingGrantId: connected.routingGrantId,
      async readFreshProject() {
        const result = await freshPage.evaluate(browserFreshRelayProjectRead, {
          path: '/api/projects/relay-shared',
        });
        return result.status;
      },
      readRouteStatus: () => freshPage.evaluate(browserBrokerReadStatus),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function offer(page: Page, port: number) {
  const transport = browserTransport;
  await page.evaluate(browserSetConnectionTrust, {
    trust: connectionTrust,
    approvedKeyId: await stationConnectionSigningKeyId(connectionTrust),
  });
  return page.evaluate(browserOffer, {
    port: transport === 'udp' ? (turnUdpPort ?? port) : (turnTcpPort ?? port),
    username,
    password,
    transport,
  });
}

async function acceptSignedAnswer(
  page: Page,
  offer: string,
  sdp: string,
  pin: string,
  candidates: { candidate: string; sdpMid: string }[],
  revokeTrust = false,
) {
  const context = await page.evaluate(browserConnectionContext);
  const clientFingerprint = offer
    .match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]
    ?.trim();
  const stationFingerprint = sdp
    .match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]
    ?.trim();
  assert(clientFingerprint && stationFingerprint);
  const binding = {
    ...context,
    stationId: connectionTrust.stationId,
    enrollmentId: connectionTrust.enrollmentId,
    generation: connectionTrust.generation,
    clientFingerprint,
    stationFingerprint,
    offerSha256: await connectionDescriptionDigest(offer),
    answerSha256: await connectionDescriptionDigest(sdp),
  };
  admittedConnections.add(binding.connectionId);
  let proof: string;
  try {
    proof = await proofIssuer.issue(binding);
  } finally {
    admittedConnections.delete(binding.connectionId);
  }
  const [header, payload, signature] = proof.split('.');
  const invalid = `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
  await assert.rejects(
    page.evaluate(browserAccept, { sdp, pin, candidates, proof: invalid }),
    /Station connection proof refused/,
  );
  if (revokeTrust) {
    const revoker = await page.context().newPage();
    try {
      await revoker.goto(page.url());
      await revoker.evaluate(
        browserRevokeConnectionTrust,
        connectionTrust.stationId,
      );
      await assert.rejects(
        page.evaluate(browserAccept, { sdp, pin, candidates, proof }),
        /Device signing trust changed before accepting the connection/,
      );
      assert.equal(await page.evaluate(browserHasNoRemoteDescription), true);
    } finally {
      await revoker.close();
    }
    return;
  }
  await page.evaluate(browserAccept, { sdp, pin, candidates, proof });
  await assert.rejects(
    page.evaluate(browserAccept, { sdp, pin, candidates, proof }),
    /Connection proof already consumed/,
  );
}

async function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${phase} did not settle within its liveness bound`),
            ),
          20000,
        );
      }),
    ]);
    abort.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function candidateTypeCounts(sdp: unknown) {
  const counts = { host: 0, srflx: 0, relay: 0, other: 0 };
  if (typeof sdp !== 'string') return counts;
  for (const match of sdp.matchAll(/\btyp\s+(host|srflx|relay)\b/gu)) {
    const candidateType = match[1];
    if (
      candidateType === 'host' ||
      candidateType === 'srflx' ||
      candidateType === 'relay'
    )
      counts[candidateType]++;
  }
  const candidateLines = sdp.match(/^a=candidate:/gmu)?.length ?? 0;
  counts.other = Math.max(
    0,
    candidateLines - counts.host - counts.srflx - counts.relay,
  );
  return counts;
}

async function readSelfHostedBrokerPeerDiagnostics() {
  let leaseState: string | null = null;
  try {
    leaseState = (await brokerLab?.readLease())?.state ?? null;
  } catch {
    leaseState = 'unavailable';
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(
      join(root, 'self-hosted-broker', 'broker.sqlite'),
      {
        readOnly: true,
      },
    );
    const rows = database
      .prepare(
        'SELECT offer_sdp,answer_sdp,station_proof FROM broker_connections',
      )
      .all() as Array<{
      offer_sdp: unknown;
      answer_sdp: unknown;
      station_proof: unknown;
    }>;
    const sum = (
      field: 'offer_sdp' | 'answer_sdp',
    ): ReturnType<typeof candidateTypeCounts> => {
      const total = { host: 0, srflx: 0, relay: 0, other: 0 };
      for (const row of rows) {
        const counts = candidateTypeCounts(row[field]);
        total.host += counts.host;
        total.srflx += counts.srflx;
        total.relay += counts.relay;
        total.other += counts.other;
      }
      return total;
    };
    return {
      leaseState,
      connectionCount: rows.length,
      answeredCount: rows.filter(
        (row) =>
          typeof row.answer_sdp === 'string' && row.answer_sdp.length > 0,
      ).length,
      proofCount: rows.filter(
        (row) =>
          typeof row.station_proof === 'string' && row.station_proof.length > 0,
      ).length,
      offerCandidateTypes: sum('offer_sdp'),
      answerCandidateTypes: sum('answer_sdp'),
    };
  } catch (error) {
    return {
      leaseState,
      databaseStatus:
        error instanceof Error ? error.name : 'sqlite_diagnostics_unavailable',
    };
  } finally {
    database?.close();
  }
}

async function readProjectNavigationFailureStatus(
  page: Page,
  clientOrigin: string,
) {
  return page
    .evaluate(
      async ({ clientOrigin: originValue }) => {
        const browser = globalThis as unknown as {
          document: {
            body: { innerText: string };
            querySelectorAll(selector: string): ArrayLike<{
              textContent: string | null;
            }>;
            querySelector(
              selector: string,
            ): { textContent: string | null } | null;
          };
          location: { pathname: string };
        };
        const text = browser.document.body.innerText;
        const classify = (message: string, name = '') => {
          if (
            name === 'StationRequestAuthorityError' ||
            /requested station authority is no longer available/iu.test(message)
          )
            return 'station-request-authority-error' as const;
          if (
            /enrolled.{0,30}credential|credential.{0,30}enrolled|credential.{0,20}required/iu.test(
              message,
            )
          )
            return 'enrolled-credential-required' as const;
          if (/unsupported member project view/iu.test(message))
            return 'unsupported-member-view' as const;
          if (
            /full project configuration|invalid project (response|catalogue)|member project view/iu.test(
              message,
            )
          )
            return 'incompatible-response' as const;
          if (/timed out|timeout/iu.test(message)) return 'timeout' as const;
          return 'other' as const;
        };
        const alertText =
          browser.document.querySelector('[role="alert"]')?.textContent ?? '';
        const ui = {
          pathname: browser.location.pathname,
          projectErrorVisible: text.includes('Could not load project'),
          stationConnectionUnavailableVisible: text.includes(
            'Station connection unavailable',
          ),
          degradedProjectLoaderVisible: text.includes(
            'Project is taking longer than expected',
          ),
          sharedProjectLabelVisible: text.includes('Shared Project'),
          projectHeadingVisible: Array.from(
            browser.document.querySelectorAll('h1, h2, h3'),
          ).some(
            (heading) => heading.textContent?.trim() === 'Relay shared fixture',
          ),
          sharedWorkErrorVisible: text.includes('Shared work is unavailable'),
          sharedWorkLoading: Boolean(
            browser.document.querySelector(
              '[role="status"][aria-label="Loading shared work"]',
            ),
          ),
          projectErrorCategory: classify(alertText),
        };
        const unavailable = {
          routeIsCurrent: false,
          projectReadStatus: null as number | null,
          sdkProjectRead: { probeAvailable: false as const },
        };
        try {
          const connections = JSON.parse(
            localStorage.getItem('station-connect-connections') ?? '[]',
          ) as Array<{
            id: string;
            url: string;
            brokerRoute?: {
              brokerOrigin: string;
              scope: Record<string, unknown>;
            };
          }>;
          const activeId = localStorage.getItem(
            'station-connect-connections-active',
          );
          const connection = connections.find(
            (candidate) => candidate.id === activeId && candidate.brokerRoute,
          );
          if (!connection?.brokerRoute) return { ...ui, ...unavailable };
          const clientOrigin = new URL(originValue).origin;
          const [bindingModule, authorityModule] = await Promise.all([
            import(
              new URL('/src/lib/browserRelayRouteBinding.ts', clientOrigin).href
            ),
            import(
              new URL(
                '/src/lib/browserRelayApplicationAuthority.ts',
                clientOrigin,
              ).href
            ),
          ]);
          const binding = bindingModule.captureBrowserRelayRoute(
            connection.id,
            connection.url,
            connection.brokerRoute,
          );
          if (!binding?.isCurrent()) return { ...ui, ...unavailable };
          const credential =
            await authorityModule.createBrowserRelayApplicationCredential({
              connectionId: connection.id,
              applicationOrigin: connection.url,
              route: connection.brokerRoute,
              transport: binding.transport,
              routeIsCurrent: binding.isCurrent,
            });
          let projectReadStatus: number | null = null;
          try {
            const response = await credential.transport(
              new URL('/api/projects/relay-shared', connection.url).href,
              { headers: { Accept: 'application/json', Origin: clientOrigin } },
            );
            projectReadStatus = response.status;
          } catch {
            // Keep status absent without retaining transport details.
          }
          let sdkProjectRead:
            | { resolvedShape: 'member-project' | 'project-config' }
            | {
                errorClass: ReturnType<typeof classify> | 'http-error';
                httpStatus?: number;
              }
            | { probeAvailable: false };
          try {
            const sdkSpecifier = '@kontourai/station-sdk';
            const sdk = await import(sdkSpecifier);
            const value = await sdk.getProjectView(
              connection.url,
              'relay-shared',
              {
                requireCredential: true,
                timeoutMs: 15_000,
                maxResponseBytes: 65_536,
              },
            );
            const view = value as unknown as Record<string, unknown>;
            sdkProjectRead = {
              resolvedShape:
                view.version === 'station.member-project/v1' &&
                view.kind === 'member-project'
                  ? 'member-project'
                  : 'project-config',
            };
          } catch (cause) {
            const error = cause as {
              name?: unknown;
              status?: unknown;
              message?: unknown;
            };
            sdkProjectRead = {
              errorClass:
                typeof error.status === 'number'
                  ? 'http-error'
                  : classify(
                      typeof error.message === 'string' ? error.message : '',
                      typeof error.name === 'string' ? error.name : '',
                    ),
              ...(typeof error.status === 'number'
                ? { httpStatus: error.status }
                : {}),
            };
          }
          return {
            ...ui,
            routeIsCurrent: binding.isCurrent(),
            projectReadStatus,
            sdkProjectRead,
          };
        } catch {
          return { ...ui, ...unavailable };
        }
      },
      { clientOrigin },
    )
    .catch(() => ({ uiDiagnosticAvailable: false as const }));
}
async function runStationUiRelayJourney(input: {
  page: Page;
  clientOrigin: string;
  applicationOrigin: string;
  broker: NonNullable<typeof brokerLab>;
  trust: ApprovedStationConnectionTrust;
  authorityHome: string;
  accountStation: Awaited<ReturnType<typeof startRelayAccountStation>>;
}) {
  let brokerResponseCount = 0;
  let applicationApiResponseCount = 0;
  const keyReport = await runLabCommand(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      join(process.cwd(), 'scripts/connection-key.ts'),
      'inspect',
      `--home=${input.authorityHome}`,
    ],
    process.cwd(),
  );
  const operatorReport = JSON.parse(keyReport.stdout.trim()) as {
    schema: string;
    status: string;
    trust: ApprovedStationConnectionTrust;
    keyId: string;
  };
  assert.equal(operatorReport.schema, 'station.connection-key/v1');
  assert.equal(operatorReport.status, 'present');
  assert.equal(operatorReport.trust.stationId, input.trust.stationId);
  const invitation = input.broker.issueInvitation({
    clientOrigin: input.clientOrigin,
    stationSigningKeyId: operatorReport.keyId,
    stationSigningGeneration: operatorReport.trust.generation,
  });
  input.page.on('response', (response) => {
    try {
      const url = new URL(response.url());
      if (
        [input.applicationOrigin, input.clientOrigin].includes(url.origin) &&
        url.pathname.startsWith('/api/')
      )
        applicationApiResponseCount++;
      if (
        url.origin === input.broker.brokerOrigin &&
        url.pathname.startsWith('/broker/')
      )
        brokerResponseCount++;
    } catch {
      // Ignore non-HTTP response URLs.
    }
  });
  await input.page.addInitScript(installRelayCandidatePairRecorder);
  await input.page.goto(input.clientOrigin);
  try {
    await input.page
      .getByRole('heading', { name: 'Connect to a Station' })
      .waitFor({ timeout: 30000 });
  } catch {
    stationUiFailure = { phase: 'initial-ui', headingVisible: false };
    throw new Error('Station Computers UI did not mount.');
  }
  await input.page
    .getByRole('button', { name: 'Use a broker invitation' })
    .click();
  try {
    await input.page
      .getByRole('region', { name: 'Browser broker routes' })
      .waitFor({ timeout: 10000 });
  } catch {
    stationUiFailure = { phase: 'broker-routes', routePanelVisible: false };
    throw new Error('Broker route panel did not mount.');
  }
  const reportField = input.page.getByLabel('Operator Station key report');
  try {
    await reportField.waitFor({ timeout: 10000 });
  } catch {
    stationUiFailure = { phase: 'trust-report', trustReportVisible: false };
    throw new Error('Broker route trust report field did not mount.');
  }
  await reportField.fill(JSON.stringify(operatorReport));
  await input.page
    .getByRole('status', { name: 'Station trust: untrusted' })
    .waitFor({ timeout: 10000 });
  await input.page
    .getByRole('checkbox', { name: /I compared this full key ID/ })
    .check();
  await input.page
    .getByRole('button', { name: 'Approve Station key', exact: true })
    .click();
  await input.page
    .getByText('Station signing key approved on this browser.')
    .waitFor({ timeout: 10000 });

  const routeName = 'Relay lab Station';
  const routes = input.page.getByRole('region', {
    name: 'Browser broker routes',
  });
  await routes.getByLabel('Station name').fill(routeName);
  await routes
    .getByLabel('Station application address')
    .fill(input.applicationOrigin);
  const browserTurnPort =
    browserTransport === 'udp' ? turnUdpPort : relay?.port;
  assert(browserTurnPort, 'Local browser TURN fixture must be ready');
  await routes
    .getByLabel('TURN server URL')
    .fill(`turn:127.0.0.1:${browserTurnPort}?transport=${browserTransport}`);
  await routes.getByLabel('TURN username').fill(username);
  await routes.getByLabel('TURN credential').fill(password);
  await routes
    .getByLabel('Broker invitation link or private JSON')
    .fill(JSON.stringify(invitation));
  await routes.getByRole('button', { name: 'Accept route' }).click();
  const row = routes.locator('.page-row').filter({ hasText: routeName });
  await row.getByRole('button', { name: 'Connect' }).waitFor({
    timeout: 15000,
  });

  let directStationApiAttempts = 0;
  for (const origin of new Set([input.clientOrigin, input.applicationOrigin]))
    await input.page.route(`${origin}/api/**`, async (route) => {
      directStationApiAttempts++;
      await route.abort('blockedbyclient');
    });
  await row.getByRole('button', { name: 'Connect' }).click();
  try {
    await row.getByRole('button', { name: 'Reconnect' }).waitFor({
      timeout: 30000,
    });
  } catch {
    stationUiFailure = {
      phase: 'connect',
      routeConnected: false,
      brokerResponseCount,
      applicationApiResponseCount,
    };
    throw new Error('Station UI did not connect the accepted broker route.');
  }
  await input.page.waitForFunction(
    async () => {
      const readPair = (
        globalThis as unknown as {
          __stationRelaySelectedCandidatePair?: () => Promise<{
            localType: string;
            remoteType: string;
          } | null>;
        }
      ).__stationRelaySelectedCandidatePair;
      return Boolean(await readPair?.());
    },
    undefined,
    { timeout: 15000 },
  );
  const selectedRelayPair = await input.page.evaluate(async () => {
    const readPair = (
      globalThis as unknown as {
        __stationRelaySelectedCandidatePair?: () => Promise<{
          localType: string;
          remoteType: string;
        } | null>;
      }
    ).__stationRelaySelectedCandidatePair;
    return (await readPair?.()) ?? null;
  });
  assert(selectedRelayPair);
  assert.equal(selectedRelayPair.localType, 'relay');
  assert.equal(selectedRelayPair.remoteType, 'relay');
  stationUiFailure = undefined;
  const stationPeerDiagnostics = await readSelfHostedBrokerPeerDiagnostics();
  if (!('answerCandidateTypes' in stationPeerDiagnostics))
    throw new Error('Station TURN answer diagnostics are unavailable.');
  const stationAnswerCandidateTypes =
    stationPeerDiagnostics.answerCandidateTypes;
  assert(stationAnswerCandidateTypes);
  assert(stationPeerDiagnostics.answeredCount > 0);
  assert(stationPeerDiagnostics.proofCount > 0);
  assert(stationAnswerCandidateTypes.relay > 0);
  assert.equal(
    directStationApiAttempts,
    0,
    'Selected relay route health must not issue direct Station HTTP',
  );
  const publicHandshake = await input.page.evaluate(
    async ({ origin, route, moduleUrl }) => {
      const { probeServerConnection } = await import(moduleUrl);
      return probeServerConnection(
        origin,
        undefined,
        null,
        AbortSignal.timeout(20000),
        route,
      );
    },
    {
      origin: input.applicationOrigin,
      moduleUrl: new URL('/src/lib/serverHealth.ts', input.clientOrigin).href,
      route: {
        brokerOrigin: invitation.brokerOrigin,
        scope: invitation.scope,
      },
    },
  );
  assert.equal(publicHandshake.ok, false);
  assert.equal(
    publicHandshake.reason,
    'authentication-failed',
    'The public Station handshake must answer through the broker before account authority exists',
  );

  await row.getByRole('button', { name: 'Verify account and Device' }).click();
  const accountDialog = input.page.getByRole('dialog', {
    name: `Verify account on ${routeName}`,
  });
  await accountDialog.waitFor({ timeout: 10000 });
  await accountDialog
    .getByLabel('Station account name')
    .fill(input.accountStation.browser.username);
  await accountDialog
    .getByLabel('Password')
    .fill(input.accountStation.browser.password);
  await accountDialog
    .getByLabel('Project invitation token (optional)')
    .fill(input.accountStation.browser.invitation);
  await accountDialog.getByRole('button', { name: 'Verify account' }).click();
  await accountDialog
    .getByText('Waiting for the Station operator to approve this Device…')
    .waitFor({ timeout: 20000 });
  const requestId = (await accountDialog.locator('code').textContent())?.trim();
  assert(requestId && /^[a-f0-9-]{36}$/u.test(requestId));
  await input.accountStation.confirmFreshRelayRequest(requestId);
  await accountDialog
    .getByText('Joined Project relay-shared.')
    .waitFor({ timeout: 30000 });
  await accountDialog
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  try {
    await input.page.waitForFunction(
      () =>
        !(
          globalThis as unknown as {
            document: { querySelector(selector: string): unknown };
          }
        ).document.querySelector(
          'section[aria-label="Station access required"]',
        ),
      undefined,
      { timeout: 20000 },
    );
  } catch {
    const relayIdentityDiagnostic = await input.page
      .evaluate(
        async ({ clientOrigin: clientOriginValue }) => {
          const clientOrigin = new URL(clientOriginValue).origin;
          try {
            const connections = JSON.parse(
              localStorage.getItem('station-connect-connections') ?? '[]',
            ) as Array<{
              id: string;
              url: string;
              brokerRoute?: {
                brokerOrigin: string;
                scope: Record<string, unknown>;
              };
            }>;
            const activeId = localStorage.getItem(
              'station-connect-connections-active',
            );
            const connection = connections.find(
              (candidate) => candidate.id === activeId && candidate.brokerRoute,
            );
            if (!connection?.brokerRoute)
              return { error: 'active_broker_route_missing' };
            const [
              bindingModule,
              authorityModule,
              accountScopeModule,
              healthModule,
            ] = await Promise.all([
              import(
                new URL('/src/lib/browserRelayRouteBinding.ts', clientOrigin)
                  .href
              ),
              import(
                new URL(
                  '/src/lib/browserRelayApplicationAuthority.ts',
                  clientOrigin,
                ).href
              ),
              import(
                new URL('/src/lib/browserRelayAccountScope.ts', clientOrigin)
                  .href
              ),
              import(new URL('/src/lib/serverHealth.ts', clientOrigin).href),
            ]);
            const binding = bindingModule.captureBrowserRelayRoute(
              connection.id,
              connection.url,
              connection.brokerRoute,
            );
            if (!binding?.isCurrent()) return { routeIsCurrent: false };
            const accountScopeKey =
              accountScopeModule.browserRelayAccountScopeKey({
                connectionId: connection.id,
                applicationOrigin: connection.url,
                route: connection.brokerRoute,
                clientOrigin,
              });
            const accountScope =
              accountScopeModule.getBrowserRelayAccountScope(accountScopeKey);
            const credential =
              await authorityModule.createBrowserRelayApplicationCredential({
                connectionId: connection.id,
                applicationOrigin: connection.url,
                route: connection.brokerRoute,
                transport: binding.transport,
                routeIsCurrent: binding.isCurrent,
              });
            const identityUrl = new URL('/api/system/identity', connection.url)
              .href;
            const response = await credential.transport(identityUrl, {
              headers: { Accept: 'application/json', Origin: clientOrigin },
            });
            const body = (await response.json().catch(() => ({}))) as {
              error?: { code?: unknown };
              data?: { bootId?: unknown };
              bootId?: unknown;
            };
            const probe = await healthModule.probeServerConnection(
              connection.url,
              undefined,
              null,
              AbortSignal.timeout(15000),
              connection.brokerRoute,
            );
            return {
              activeConnectionIdPresent: Boolean(connection.id),
              routeIsCurrent: binding.isCurrent(),
              identityStatus: response.status,
              identityRejected: typeof body.error?.code === 'string',
              identityBootIdPresent: Boolean(body.bootId ?? body.data?.bootId),
              accountScopeState: accountScope?.state ?? null,
              accountScopeHasAuthority: Boolean(accountScope?.authorityKey),
              accountScopeVersion: accountScope?.version ?? null,
              productProbe: {
                ok: probe.ok,
                reason: probe.reason ?? null,
                bootIdPresent: Boolean(probe.bootId),
              },
            };
          } catch {
            return { probeAvailable: false };
          }
        },
        { clientOrigin: input.clientOrigin },
      )
      .catch(() => ({ probeAvailable: false }));
    stationUiFailure = {
      phase: 'protected-app-gate',
      accessRequiredVisible: true,
      routeConnected: true,
      brokerResponseCount,
      applicationApiResponseCount,
      relayIdentityDiagnostic,
    };
    throw new Error('Relay Device approval did not open the protected app.');
  }
  try {
    const projectNavigation = input.page.getByRole('button', {
      name: /Relay shared fixture/,
    });
    await projectNavigation.waitFor({ timeout: 15000 });
    await projectNavigation.click();
    await input.page
      .getByRole('heading', { name: 'Relay shared fixture', exact: true })
      .waitFor({ timeout: 30000 });
    await input.page
      .getByText(input.accountStation.sharedWork.sharedTask.title, {
        exact: true,
      })
      .waitFor({ timeout: 15000 });
    assert.equal(
      await input.page
        .getByText(input.accountStation.sharedWork.unpublishedTask.title, {
          exact: true,
        })
        .count(),
      0,
      'Unpublished Project work must stay hidden from the member UI',
    );
  } catch {
    stationUiFailure = {
      phase: 'project-navigation',
      routeConnected: true,
      protectedAppVisible: true,
      projectHeadingVisible: false,
      brokerResponseCount,
      applicationApiResponseCount,
      directStationApiAttempts,
    };
    throw new Error('Protected Project did not open in the live Station UI.');
  }
  assert.equal(
    directStationApiAttempts,
    0,
    'Account enrollment, Device approval and Project read must stay off direct Station HTTP',
  );
  return {
    status: 'passed',
    journey:
      'real Station UI key approval, invitation acceptance, Connect, fresh account login and operator Device approval',
    selectedRouteHealthy: true,
    publicStationHealth: publicHandshake.reason,
    browserSelectedCandidateTypes: selectedRelayPair,
    stationAnswerRelayCandidateCount: stationAnswerCandidateTypes.relay,
    protectedProjectRead: 'Project and published Task visible in Station UI',
    unpublishedTaskHidden: true,
    deviceApprovalRequestIdObserved: true,
    directStationApiAttempts,
    routingGrantDistinctFromOperator: true,
    applicationOrigin: input.applicationOrigin,
    clientOrigin: input.clientOrigin,
    browserContextIsolated: true,
    invitationAccepted: true,
  };
}

async function identity(name: string) {
  const home = join(root, name);
  mkdirSync(home, { mode: 0o700 });
  const key = join(home, 'key.pem');
  const cert = join(home, 'cert.pem');
  await runLabCommand(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    home,
  );
  return {
    key,
    cert,
    fingerprint: new X509Certificate(readFileSync(cert)).fingerprint256,
  };
}

async function exchange(
  page: Page,
  key: Awaited<ReturnType<typeof identity>>,
  pin: string,
  substitute = false,
  revokeTrust = false,
) {
  assert(relay);
  assert(turnUdpPort);
  abort.signal.throwIfAborted();
  const remote = await bounded(
    offer(page, relay.port),
    'browser ICE gathering',
  );
  assert.match(remote.sdp, / typ relay/);
  if (peerAdapter === 'pion') {
    const fixture = await startPionFixture({
      executable: pionExecutable,
      directory: join(root, `pion-${peers.length}`),
      certificate: key.cert,
      key: key.key,
      offer: remote,
      turnPort: relay.port,
      username,
      password,
      signal: abort.signal,
      ...(args.includes('--application-protocol') || accountStation
        ? {
            application: {
              label: accountStation
                ? 'station-application-account-fixture'
                : 'station-application-protocol-fixture',
              accept(channel) {
                if (accountStation?.station.openApplicationChannel) {
                  bridgeApplicationChannels(
                    channel,
                    accountStation.station.openApplicationChannel(),
                    abort.signal,
                  );
                } else
                  serveApplicationChannel(
                    channel,
                    'https://fixture-station.invalid',
                    {
                      signal: abort.signal,
                      async fetch(request) {
                        const marker = await request.text();
                        assert.match(marker, /^sdk-request-[a-f0-9-]{36}$/);
                        const address = server.address();
                        assert(address && typeof address !== 'string');
                        const origin = `http://127.0.0.1:${address.port}`;
                        assert.equal(request.headers.get('Origin'), origin);
                        return new Response(marker.repeat(512), {
                          headers: { 'X-Fixture-Client-Origin': origin },
                        });
                      },
                    },
                  );
              },
            },
          }
        : {}),
    });
    peers.push(fixture.peer);
    if (pionProvenance) assert.deepEqual(fixture.provenance, pionProvenance);
    pionProvenance = fixture.provenance;
    assert.match(fixture.answer.sdp, / typ relay/);
    assert.equal(
      fixture.answer.sdp.match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]?.trim(),
      key.fingerprint,
    );
    const sdp = substitute
      ? fixture.answer.sdp.replace(key.fingerprint, pin)
      : fixture.answer.sdp;
    await acceptSignedAnswer(page, remote.sdp, sdp, pin, [], revokeTrust);
    return {
      peer: fixture.peer,
      get messages() {
        return fixture.readMessages();
      },
    };
  }
  const peer = new datachannel.PeerConnection('station-transport-fixture', {
    iceServers: [
      {
        hostname: '127.0.0.1',
        port: relay.port,
        username,
        password,
        relayType: 'TurnUdp',
      },
    ],
    bindAddress: '127.0.0.1',
    iceTransportPolicy: 'relay',
    disableFingerprintVerification: false,
    maxMessageSize: 65536,
    certificatePemFile: key.cert,
    keyPemFile: key.key,
  });
  peers.push(peer);
  const states: string[] = [];
  peer.onStateChange((state) => states.push(state));
  const messages: string[] = [];
  const gathered = new Promise<void>((resolve) => {
    peer.onGatheringStateChange((state) => {
      if (state === 'complete') resolve();
    });
  });
  peer.onDataChannel((channel) => {
    if (channel.getLabel() === 'station-application-account-fixture') {
      if (!accountStation?.station.openApplicationChannel) {
        channel.close();
        return;
      }
      try {
        bridgeApplicationChannels(
          nodeApplicationChannel(channel),
          accountStation.station.openApplicationChannel(),
          abort.signal,
        );
      } catch {
        channel.close();
      }
      return;
    }
    if (channel.getLabel() === 'station-application-protocol-fixture') {
      if (!args.includes('--application-protocol')) {
        channel.close();
        return;
      }
      serveApplicationChannel(
        nodeApplicationChannel(channel),
        'https://fixture-station.invalid',
        {
          signal: abort.signal,
          async fetch(request) {
            if (
              new URL(request.url).pathname !== '/fixture/payload' ||
              request.method !== 'POST'
            )
              return new Response(null, { status: 404 });
            const marker = await request.text();
            assert.match(marker, /^sdk-request-[a-f0-9-]{36}$/);
            const address = server.address();
            assert(address && typeof address !== 'string');
            const origin = `http://127.0.0.1:${address.port}`;
            assert.equal(
              request.headers.get('Origin'),
              origin,
              'Virtual request must preserve the actual browser origin',
            );
            return new Response(marker.repeat(512), {
              headers: { 'X-Fixture-Client-Origin': origin },
            });
          },
        },
      );
      return;
    }
    channel.onMessage((value) => {
      assert.equal(typeof value, 'string');
      assert(String(value).length < 65536);
      messages.push(String(value));
      channel.sendMessage(String(value));
    });
  });
  peer.setRemoteDescription(remote.sdp, 'offer');
  await bounded(gathered, 'Station ICE gathering');
  const answer = peer.localDescription();
  assert(answer?.type === 'answer');
  assert.match(answer.sdp, / typ relay/);
  const fingerprint = answer.sdp
    .match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]
    ?.trim();
  assert.equal(fingerprint, key.fingerprint);
  const sdp = substitute
    ? answer.sdp.replace(key.fingerprint, pin)
    : answer.sdp;
  // Gathering is complete. The signed SDP is the complete candidate set;
  // do not append separate unsigned candidate callback events afterward.
  await acceptSignedAnswer(page, remote.sdp, sdp, pin, [], revokeTrust);
  return { peer, messages };
}

try {
  sourceCommitSha = (
    await runLabCommand('git', ['rev-parse', 'HEAD'], process.cwd())
  ).stdout.trim();
  assert.match(sourceCommitSha, /^[a-f0-9]{40}$/);
  sourceWorktreeClean =
    (
      await runLabCommand('git', ['status', '--porcelain'], process.cwd())
    ).stdout.trim().length === 0;
  pionExecutableSha256 = createHash('sha256')
    .update(readFileSync(pionExecutable))
    .digest('hex');
  const authorityHome = args.includes('--application-accounts')
    ? join(root, 'application-station', 'home')
    : join(root, 'station-authority');
  if (args.includes('--application-accounts'))
    ensureStationHomeSchemaSync(authorityHome);
  const environment = new EnvironmentSecurityService({
    homeDir: authorityHome,
  });
  const environmentIdentity = await environment.initialize();
  connectionTrust = await new ConnectionSigningKeyStore(
    authorityHome,
  ).initialize();
  assert.equal(connectionTrust.stationId, environmentIdentity.environmentId);
  const reopenedKeys = new ConnectionSigningKeyStore(authorityHome);
  assert.deepEqual(reopenedKeys.readDescriptor(), connectionTrust);
  proofIssuer = reopenedKeys.createIssuer((binding) =>
    admittedConnections.has(binding.connectionId),
  );
  const bundled = await build({
    stdin: {
      contents: `
    import {createStationConnectionProofVerifier, connectionDescriptionDigest} from '@kontourai/station-shared/connection-proof';
    import {createStationProofNonce} from './packages/connect/src/core/environmentProof.ts';
    import {openDeviceConnectionTrustStore} from '@kontourai/station-connect/connection-trust';
    window.stationConnectionProof = {createStationConnectionProofVerifier, connectionDescriptionDigest, newNonce: createStationProofNonce, openDeviceConnectionTrustStore};
    import {createApplicationChannelFetch, browserApplicationChannel} from '@kontourai/station-connect/application-channel';
    import {authenticatedFetch, setClientCredentialResolver, StationHttpError} from '@kontourai/station-sdk/client';
    import {ApplicationSessionClient, createApplicationSessionKey} from '@kontourai/station-sdk/application-session';
    window.stationApplicationChannel = {createApplicationChannelFetch, browserApplicationChannel, authenticatedFetch, setClientCredentialResolver, StationHttpError, ApplicationSessionClient, createApplicationSessionKey};
    import * as relayEnrollment from '@kontourai/station-sdk/relay-enrollment';
    window.stationRelayEnrollment = relayEnrollment;
    ${
      selfHostedBroker
        ? `import {SelfHostedBrokerBrowserClient, createBrowserPionConnection, createSelfHostedApplicationTransport, BrowserRoutingGrantCustody, redeemBrokerRouteInvitation} from './packages/connect/src/core/selfHostedBrowser.ts';
    window.stationSelfHostedBroker = {SelfHostedBrokerBrowserClient, createBrowserPionConnection, createSelfHostedApplicationTransport, BrowserRoutingGrantCustody, redeemBrokerRouteInvitation};`
        : ''
    }
  `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  });
  assert.equal(bundled.outputFiles.length, 1);
  clientProofScript = bundled.outputFiles[0].text;
  stopBundler();
  const turnPorts = await turnFixture.start();
  turnTcpPort = turnPorts.tcp;
  turnUdpPort = turnPorts.udp;
  const relayRoot = join(root, 'relay');
  mkdirSync(relayRoot, { mode: 0o700 });
  relay = await startLabRelay(
    peerAdapter === 'pion' ? turnTcpPort : turnUdpPort,
    relayRoot,
    'forward',
    peerAdapter === 'pion' ? 'tcp' : 'udp',
  );
  const approved = await identity('approved-station');
  const substituted = await identity('unapproved-station');
  let address: import('node:net').AddressInfo;
  let pageOrigin: string;
  let secondaryPageOrigin: string | undefined;
  if (selfHostedBroker) {
    const tlsOptions = {
      cert: readFileSync(approved.cert),
      key: readFileSync(approved.key),
      minVersion: 'TLSv1.3' as const,
      maxVersion: 'TLSv1.3' as const,
    };
    if (stationUi)
      viteServer = await createViteServer({
        configFile: join(process.cwd(), 'vite.config.ts'),
        server: { middlewareMode: true, hmr: false },
        appType: 'spa',
        logLevel: 'error',
      });
    const securePageHandler = (
      request: import('node:http').IncomingMessage,
      response: import('node:http').ServerResponse,
    ) => {
      if (
        (!stationUi && request.url === '/') ||
        request.url === '/__fixture' ||
        request.url === '/__fixture/' ||
        request.url === '/connection-proof.js'
      ) {
        serveBrowserDocument(request, response);
        return;
      }
      if (stationUi && !request.url?.startsWith('/api/')) {
        viteServer?.middlewares(request, response, (error?: unknown) => {
          if (!response.headersSent)
            response.writeHead(error ? 500 : 404, {
              'Content-Type': 'text/plain; charset=utf-8',
            });
          if (!response.writableEnded)
            response.end(error ? 'Station UI middleware failed' : 'Not found');
        });
        return;
      }
      if (!stationUpstreamPort) {
        response.writeHead(503).end();
        return;
      }
      const headers = {
        ...request.headers,
        host: `127.0.0.1:${stationUpstreamPort}`,
      };
      delete headers.connection;
      delete headers.upgrade;
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: stationUpstreamPort,
          path: request.url ?? '/',
          method: request.method,
          headers,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.headers,
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
    };
    securePageServer = createHttpsServer(tlsOptions, securePageHandler);
    securePageServer.listen(0, '127.0.0.1');
    await once(securePageServer, 'listening');
    const secureAddress = securePageServer.address();
    assert(secureAddress && typeof secureAddress !== 'string');
    address = secureAddress;
    pageOrigin = `https://127.0.0.1:${address.port}`;
    secondarySecurePageServer = createHttpsServer(
      tlsOptions,
      securePageHandler,
    );
    secondarySecurePageServer.listen(0, '127.0.0.1');
    await once(secondarySecurePageServer, 'listening');
    const secondaryAddress = secondarySecurePageServer.address();
    assert(secondaryAddress && typeof secondaryAddress !== 'string');
    secondaryPageOrigin = `https://127.0.0.1:${secondaryAddress.port}`;
    assert.notEqual(secondaryPageOrigin, pageOrigin);
  } else {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const plainAddress = server.address();
    assert(plainAddress && typeof plainAddress !== 'string');
    address = plainAddress;
    pageOrigin = `http://127.0.0.1:${address.port}`;
  }
  let prepareStationConnectorConfig:
    | ((stationOrigin: string) => string)
    | undefined;
  let brokerPort: number | undefined;
  if (selfHostedBroker) {
    const activeRelay = relay;
    assert(activeRelay);
    const scope = {
      stationId: connectionTrust.stationId,
      enrollmentId: connectionTrust.enrollmentId,
      routingGeneration: connectionTrust.generation,
      browserOrigin: pageOrigin,
    };
    brokerLab = await startSelfHostedBrokerProcess({
      directory: root,
      scope,
      signal: abort.signal,
    });
    const lab = brokerLab;
    const currentBrokerPort = Number(new URL(lab.brokerOrigin).port);
    assert(Number.isSafeInteger(currentBrokerPort) && currentBrokerPort > 1024);
    assert(currentBrokerPort + 1 < 65536);
    brokerPort = currentBrokerPort;
    prepareStationConnectorConfig = (stationOrigin) => {
      const connectorDirectory = join(root, 'application-station', 'connector');
      mkdirSync(connectorDirectory, { recursive: true, mode: 0o700 });
      const certificatePath = join(connectorDirectory, 'peer-cert.pem');
      const privateKeyPath = join(connectorDirectory, 'peer-key.pem');
      const credentialsPath = join(connectorDirectory, 'credentials.json');
      const stationConnectorConfigPath = join(
        connectorDirectory,
        'connector.json',
      );
      writeFileSync(certificatePath, readFileSync(approved.cert), {
        flag: 'wx',
        mode: 0o600,
      });
      writeFileSync(privateKeyPath, readFileSync(approved.key), {
        flag: 'wx',
        mode: 0o600,
      });
      writeFileSync(
        credentialsPath,
        JSON.stringify({
          version: 'station-self-hosted-broker-credentials/v1',
          scope: lab.scope,
          bundle: lab.bundle,
        }),
        { flag: 'wx', mode: 0o600 },
      );
      writeFileSync(
        stationConnectorConfigPath,
        JSON.stringify({
          version: 'station-self-hosted-connector/v1',
          brokerOrigin: lab.brokerOrigin,
          applicationOrigin: stationOrigin,
          credentialsPath,
          certificatePath,
          privateKeyPath,
          pionExecutable,
          turn: {
            url: `turn:127.0.0.1:${activeRelay.port}?transport=tcp`,
            username,
            password,
          },
        }),
        { flag: 'wx', mode: 0o600 },
      );
      const persisted = JSON.parse(
        readFileSync(stationConnectorConfigPath, 'utf8'),
      ) as { applicationOrigin?: unknown };
      assert.equal(
        persisted.applicationOrigin,
        stationOrigin,
        'Child connector target must equal the Station listener origin selected by its owner',
      );
      return stationConnectorConfigPath;
    };
  }
  if (args.includes('--application-accounts'))
    accountStation = await startRelayAccountStation(
      root,
      pageOrigin,
      abort.signal,
      {
        prepareSelfHostedBrokerConfig: prepareStationConnectorConfig,
        ownedBrokerTcpPort: brokerPort,
        ...(selfHostedBroker
          ? {
              publicOrigin: pageOrigin,
              additionalBrowserOrigins: secondaryPageOrigin
                ? [secondaryPageOrigin]
                : [],
              onStationReady: (station) => {
                stationUpstreamPort = station.port;
              },
            }
          : {}),
      },
    );
  if (accountStation)
    assert.equal(
      accountStation.station.stationId,
      connectionTrust.stationId,
      'Application and transport must be the same Station',
    );
  const stationSpki = createHash('sha256')
    .update(
      new X509Certificate(readFileSync(approved.cert)).publicKey.export({
        format: 'der',
        type: 'spki',
      }),
    )
    .digest('base64');
  browser = await chromium.launch({
    headless: true,
    ...(selfHostedBroker
      ? { args: [`--ignore-certificate-errors-spki-list=${stationSpki}`] }
      : {}),
  });
  abort.signal.throwIfAborted();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(fixtureDocumentUrl(pageOrigin));
  let brokerJourney: Record<string, unknown> | undefined;
  let brokerLeaseBefore = 0;
  let brokerReconnectForJourney:
    | { previous: string | undefined; connectionId: string }
    | undefined;
  if (selfHostedBroker) {
    assert(accountStation?.station.openApplicationChannel);
    assert(brokerLab && relay);
    // The admitted Device trust is identical to the legacy path: read from
    // the same independently approved store, never minted by the broker.
    await page.evaluate(browserSetConnectionTrust, {
      trust: connectionTrust,
      approvedKeyId: await stationConnectionSigningKeyId(connectionTrust),
    });
    let stationLease:
      | Awaited<ReturnType<typeof brokerLab.readLease>>
      | undefined;
    let connectorLeaseOnlineObserved = false;
    const leaseDeadline = Date.now() + 30_000;
    while (Date.now() < leaseDeadline) {
      try {
        stationLease = await brokerLab.readLease();
        if (stationLease.state === 'online') {
          connectorLeaseOnlineObserved = true;
          break;
        }
      } catch {
        // Wait only for the StationRuntime-owned connector registration.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    stationUiFailure = {
      phase: 'connector-lease-before-browser-admission',
      childListeningObserved: Number.isSafeInteger(accountStation.station.port),
      connectorLeaseReadSucceeded: stationLease !== undefined,
      connectorLeaseState:
        stationLease?.state === 'online' || stationLease?.state === 'offline'
          ? stationLease.state
          : null,
      connectorLeaseExpiredAtCheck: stationLease
        ? stationLease.expiresAt <= Date.now()
        : null,
      connectorLeaseOnlineObserved,
    };
    assert.equal(
      stationLease?.state,
      'online',
      'StationRuntime child must register the broker lease before browser admission',
    );
    stationUiFailure = undefined;
    if (stationUi) {
      const uiContext = await browser.newContext();
      try {
        stationUiRelayJourney = await runStationUiRelayJourney({
          page: await uiContext.newPage(),
          clientOrigin: secondaryPageOrigin ?? pageOrigin,
          applicationOrigin: pageOrigin,
          broker: brokerLab,
          trust: connectionTrust,
          authorityHome,
          accountStation,
        });
      } finally {
        await uiContext.close();
      }
    }
    if (!stationUi) {
      // Browser TURN/UDP uses the direct UDP allocation; the recording relay
      // forward is TCP-only for the Station-side Pion peer. Never aim browser
      // UDP at the TCP recording relay port.
      const brokerBrowserPort =
        browserTransport === 'udp' ? turnUdpPort : relay.port;
      assert(brokerBrowserPort);
      const invitation = brokerLab.issueInvitation({
        clientOrigin: pageOrigin,
        stationSigningKeyId:
          await stationConnectionSigningKeyId(connectionTrust),
        stationSigningGeneration: connectionTrust.generation,
      });
      const connected = await bounded(
        page.evaluate(browserBrokerConnect, {
          brokerOrigin: brokerLab.brokerOrigin,
          scope: invitation.scope,
          invitation,
          applicationOrigin: accountStation.station.base,
          port: brokerBrowserPort,
          username,
          password,
          transport: browserTransport,
        }),
        'broker Pion connect',
      );
      assert.match(connected.connectionId, /^[a-f0-9-]{36}$/);
      assert.notEqual(
        connected.routingGrantId,
        brokerLab.bundle.routing.id,
        'Browser must use a client grant, never the operator routing credential',
      );
      await page.evaluate(browserBrokerAdmitApplicationTransport);
      brokerLeaseBefore = (await brokerLab.readLease()).expiresAt;
      const stationPionPair = await page.evaluate(
        browserBrokerSelectedCandidatePair,
      );
      assert.equal(stationPionPair.localType, 'relay');
      assert.equal(stationPionPair.remoteType, 'relay');
    }
  }
  const applicationPion =
    peerAdapter === 'pion' &&
    (args.includes('--application-protocol') ||
      args.includes('--application-accounts'));
  const marker = `private-station-content-${randomBytes(32).toString('hex')}`;
  if (!stationUi) {
    const good = selfHostedBroker
      ? undefined
      : await exchange(page, approved, approved.fingerprint);
    if (!selfHostedBroker) {
      assert(good);
      if (!applicationPion) {
        await page.waitForFunction(browserChannelOpen, undefined, {
          timeout: 20000,
        });
        await page.evaluate(browserSend, marker);
        await page.waitForFunction(browserReceived, marker, { timeout: 10000 });
        assert.deepEqual(good.messages, [marker]);
      }
      let pair = good.peer.getSelectedCandidatePair();
      const pairDeadline = Date.now() + 10_000;
      while (!pair && Date.now() < pairDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        pair = good.peer.getSelectedCandidatePair();
      }
      assert.equal(pair?.local.type, 'relay');
      assert.equal(pair?.remote.type, 'relay');
      const browserStats = await page.evaluate(readBrowserStats);
      assert(browserStats.some((entry) => entry.dtlsState === 'connected'));
      assert(
        browserStats.some(
          (entry) =>
            entry.type === 'certificate' &&
            entry.fingerprint === approved.fingerprint,
        ),
      );
    }
    if (args.includes('--application-protocol')) {
      applicationProtocol = await bounded(
        page.evaluate(browserCheckApplicationChannel),
        'SDK application protocol',
      );
      assert.equal(applicationProtocol.status, 'passed');
      assert(applicationProtocol.responseBytes > 16 * 1024);
    }
    if (accountStation) {
      accountReport = await runBrowserAccountScenario(
        page,
        accountStation,
        root,
        async () => {
          if (selfHostedBroker) {
            assert(brokerLab);
            const reconnected = await bounded(
              page.evaluate(browserBrokerReconnect),
              'broker reconnect',
            );
            assert.notEqual(reconnected.connectionId, reconnected.previous);
            assert.equal(
              reconnected.peerReplaced,
              true,
              'Broker reconnect must select stats from the newly owned browser peer',
            );
            await page.evaluate(browserBrokerAdmitApplicationTransport);
            await page.evaluate(browserBrokerAdoptApplicationTransport);
            await page.exposeBinding(
              '__stationBrokerObservation',
              (_source, observation) => {
                applicationObservations.push(
                  observation as Record<string, unknown>,
                );
              },
            );
            await page.evaluate(() => {
              const browserGlobal = globalThis as unknown as Record<
                string,
                any
              >;
              const admitted = browserGlobal.stationBrokerLabTransport;
              if (!admitted)
                throw new Error('Missing admitted broker transport');
              const raw = admitted.transport;
              const state: {
                expectedAliasCredential?: string;
                observationCalls: number;
              } = {
                expectedAliasCredential: undefined,
                observationCalls: 0,
              };
              const observed = { ...admitted };
              observed.transport = async (input: any, init: any = {}) => {
                state.observationCalls++;
                // Chromium removes Origin from a constructed Request because
                // normal HTTP would add it later. The encrypted SDK carries
                // the explicit header in init, so inspect that source too.
                const suppliedHeaders = new Headers(
                  init.headers ??
                    (input instanceof Request ? input.headers : undefined),
                );
                const request =
                  input instanceof Request ? input : new Request(input, init);
                const authorization = request.headers.get('Authorization');
                const response = await raw(input, init);
                const observation = {
                  path: new URL(request.url).pathname,
                  method: request.method,
                  status: response.status,
                  cookieHeader:
                    suppliedHeaders.has('Cookie') ||
                    request.headers.has('Cookie'),
                  setCookieHeader:
                    response.headers.has('Set-Cookie') ||
                    response.headers.has('Set-Cookie2'),
                  continuationHeader: request.headers.has(
                    'X-Station-Account-Continuation',
                  ),
                  proofHeader: request.headers.has('X-Station-Account-Proof'),
                  aliasCredential:
                    state.expectedAliasCredential !== undefined &&
                    authorization === `Bearer ${state.expectedAliasCredential}`,
                  origin: suppliedHeaders.get('Origin'),
                };
                await browserGlobal.__stationBrokerObservation(observation);
                return response;
              };
              // The production transport descriptor is frozen. Publish a
              // fixture wrapper for the next SDK resolver instead of trying to
              // mutate that descriptor (which silently left observations empty).
              browserGlobal.stationBrokerLabTransport = observed;
              browserGlobal.stationBrokerLabObservations = state;
            });
            const reconnectPair = await page.evaluate(
              browserBrokerSelectedCandidatePair,
            );
            assert.equal(reconnectPair.localType, 'relay');
            assert.equal(reconnectPair.remoteType, 'relay');
            assert.equal(
              (
                await page.evaluate(browserApplicationAccountRequest, {
                  path: '/api/projects/relay-shared',
                })
              ).status,
              200,
              'Fresh broker peer restores the permitted Project read',
            );
            brokerReconnectForJourney = reconnected;
            freshRelayJourney = await runFreshRelayScenario({
              approvedPage: page,
              pageOrigin: secondaryPageOrigin ?? pageOrigin,
            });
            freshRelayReport = freshRelayJourney.report;
          }
        },
      );
      if (selfHostedBroker) {
        const observer = {
          setExpectedAliasCredential: async (value: string) =>
            page.evaluate((credential) => {
              (
                globalThis as unknown as {
                  stationBrokerLabObservations: {
                    expectedAliasCredential?: string;
                  };
                }
              ).stationBrokerLabObservations.expectedAliasCredential =
                credential;
            }, value),
          applicationObservations: () => applicationObservations,
        };
        const cookieAdoption = await runBrowserCookieAdoptionScenario(
          page,
          accountStation,
          observer as never,
        );
        cookieAdoptionReport = cookieAdoption.report;
        cookieAdoptionSecrets = cookieAdoption.privateSecrets;
      }
    }
    if (freshRelayJourney) {
      const freshDeviceProjectRead = await freshRelayJourney.readFreshProject();
      assert.equal(
        freshDeviceProjectRead,
        200,
        'Fresh Device must retain Project access after the previous Device is revoked',
      );
      assert(brokerLab);
      brokerLab.revokeClientGrant(freshRelayJourney.routingGrantId);
      await assert.rejects(
        freshRelayJourney.readRouteStatus(),
        /broker_request_refused_401|Failed to fetch/,
      );
      assert.equal(
        (await page.evaluate(browserBrokerReadStatus)).state,
        'online',
      );
      freshRelayReport = {
        ...freshRelayJourney.report,
        previousDeviceRevokedFreshDeviceProjectRead: freshDeviceProjectRead,
        independentRoutingGrantRevocation: true,
      };
      await freshRelayJourney.close();
      freshRelayJourney = undefined;
    }
    if (selfHostedBroker) {
      assert(brokerLab);
      assert(accountStation);
      const lab = brokerLab;
      // Actual broker CORS from the admitted page origin: the browser emits
      // Origin itself; no forbidden Origin header is ever set. The non-simple
      // POST triggers the real browser preflight; the incoming OPTIONS and
      // its ACAO are observed at the owned Node broker listener.
      const cors = await bounded(
        page.evaluate(browserBrokerProbeOrigin, {
          brokerOrigin: lab.brokerOrigin,
          scope: { ...lab.scope, browserOrigin: pageOrigin },
        }),
        'broker CORS and credential refusal',
      );
      assert.equal(cors.pageOrigin, pageOrigin);
      assert.equal(cors.status, 200);
      assert.equal((cors.statusBody as { state: string }).state, 'online');
      // The browser's successful cross-origin fetch is the CORS control. This
      // separate protocol probe checks the actual broker's preflight response.
      const observedPreflight = await lab.preflight();
      assert.equal(observedPreflight.status, 204);
      assert.equal(observedPreflight.allowOrigin, cors.pageOrigin);
      assert.equal(cors.wrongStatus, 401);
      assert.equal(
        (cors.wrongBody as { error: string }).error,
        'broker_credential_refused',
      );
      // Heartbeat + lease renewal: the Station-side runtime already renewed at
      // least once during the account journey, so the lease expiry observed
      // after the journey must extend past the pre-journey observation.
      let leaseAfter = (await lab.readLease()).expiresAt;
      const renewDeadline = Date.now() + 30_000;
      while (leaseAfter <= brokerLeaseBefore && Date.now() < renewDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        leaseAfter = (await lab.readLease()).expiresAt;
      }
      assert(
        leaseAfter > brokerLeaseBefore,
        'Broker lease renewal must extend the observed expiry',
      );
      assert.equal((await lab.readLease()).state, 'online');
      // Answer/proof tamper refused by the real production consumer before
      // any SDP is accepted: the wrapper fetched the REAL answer and altered
      // ONLY the proof.
      const tamper = await bounded(
        page.evaluate(browserBrokerTamperProof),
        'broker proof tamper refusal',
      );
      assert.equal(tamper.tampered, true, 'Tamper must alter a real answer');
      assert.equal(tamper.tamperedRefused, true, tamper.refusal);
      assert.equal(tamper.remoteDescriptionAttempted, false);
      assert.match(tamper.refusal, /proof|refused|invalid/i);
      // Read the live browser peer candidate pair; its remote relay candidate
      // was produced by the StationRuntime-owned Pion adapter.
      const selectedPair = await page.evaluate(
        browserBrokerSelectedCandidatePair,
      );
      assert.equal(selectedPair.localType, 'relay');
      assert.equal(selectedPair.remoteType, 'relay');
      assert(brokerReconnectForJourney);
      assert.equal(
        freshRelayReport?.independentRoutingGrantRevocation,
        true,
        'Broker lab must prove independent client-grant revocation',
      );
      const reconnected = brokerReconnectForJourney;
      brokerJourney = {
        status: 'passed',
        connectionId: reconnected.connectionId,
        clientGrantDistinctFromOperator: true,
        independentRoutingGrantRevocation:
          freshRelayReport?.independentRoutingGrantRevocation === true,
        leaseRenewed: leaseAfter > brokerLeaseBefore,
        cors: {
          status: cors.status,
          allowOrigin: cors.allowOrigin,
          preflight: observedPreflight.status,
          preflightAllowOrigin: observedPreflight.allowOrigin,
          wrongStatus: cors.wrongStatus,
        },
        proofTamperRefused: tamper.tamperedRefused,
        proofTamperObserved: tamper.tampered,
        stationRuntimeOwnsPionAndVirtualIngress: true,
        stationPeerRelaySelected: selectedPair,
        scope:
          'same Station/enrollment with per-client Origin and independently revocable routing grants; connector and Station authority remain separate',
      };
      // Trust retirement refusal: revoke the admitted Device trust in the SAME
      // profile (a fresh context has isolated storage and no trust to revoke),
      // then require the next broker admission to refuse before SDP acceptance.
      const brokerRevokePage = await context.newPage();
      try {
        await brokerRevokePage.goto(fixtureDocumentUrl(pageOrigin));
        await brokerRevokePage.evaluate(
          browserRevokeConnectionTrust,
          connectionTrust.stationId,
        );
        await assert.rejects(
          page.evaluate(browserBrokerReconnect),
          /trust_retired|authority_retired/,
        );
        assert.equal(await page.evaluate(browserBrokerConnectionId), undefined);
      } finally {
        await brokerRevokePage.close();
      }
      // Stopping StationRuntime retires its production connector and withdraws
      // the lease while the broker remains available for the refusal check.
      assert(accountStation);
      await accountStation.stop();
      await assert.rejects(
        page.evaluate(browserBrokerReadStatus),
        // With the last lease withdrawn, CORS can hide the error response.
        /broker_request_refused_401|TypeError: Failed to fetch/,
      );
      // This independent HTTP control proves the exact backend refusal, so an
      // unrelated network failure cannot satisfy the withdrawal check.
      await assert.rejects(lab.readLease(), /broker_request_refused_401/);
      brokerJourney = {
        ...(brokerJourney as Record<string, unknown>),
        trustRetirementRefused: true,
        withdrawOffline: true,
      };
      await context.close();
      await lab.stop();
      brokerLab = undefined;
    } else {
      await context.close();
      assert(good);
      await good.peer.close();
    }

    if (!selfHostedBroker) {
      const reconnectContext = await browser.newContext();
      const reconnectPage = await reconnectContext.newPage();
      await reconnectPage.goto(fixtureDocumentUrl(pageOrigin));
      const reconnected = await exchange(
        reconnectPage,
        approved,
        approved.fingerprint,
      );
      if (!applicationPion) {
        await reconnectPage.waitForFunction(browserChannelOpen, undefined, {
          timeout: 20000,
        });
        await reconnectPage.evaluate(browserSend, marker);
        await reconnectPage.waitForFunction(browserReceived, marker, {
          timeout: 10000,
        });
        assert.deepEqual(reconnected.messages, [marker]);
      }
      let reconnectPair = reconnected.peer.getSelectedCandidatePair();
      const reconnectPairDeadline = Date.now() + 10_000;
      while (!reconnectPair && Date.now() < reconnectPairDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        reconnectPair = reconnected.peer.getSelectedCandidatePair();
      }
      assert.equal(reconnectPair?.local.type, 'relay');
      assert.equal(reconnectPair?.remote.type, 'relay');
      await reconnectContext.close();
      await reconnected.peer.close();

      const revokedContext = await browser.newContext();
      const revokedPage = await revokedContext.newPage();
      await revokedPage.goto(fixtureDocumentUrl(pageOrigin));
      const revokedPeer = await exchange(
        revokedPage,
        approved,
        approved.fingerprint,
        false,
        true,
      );
      assert.equal(await revokedPage.evaluate(browserChannelOpen), false);
      assert.deepEqual(revokedPeer.messages, []);
      await revokedPeer.peer.close();
      await revokedContext.close();

      const replacementContext = await browser.newContext();
      const replacementPage = await replacementContext.newPage();
      await replacementPage.goto(fixtureDocumentUrl(pageOrigin));
      await assert.rejects(
        exchange(replacementPage, substituted, approved.fingerprint),
        /station_fingerprint_not_approved/,
      );
      await replacementContext.close();

      const hostileContext = await browser.newContext();
      const hostilePage = await hostileContext.newPage();
      await hostilePage.goto(fixtureDocumentUrl(pageOrigin));
      const hostile = await exchange(
        hostilePage,
        substituted,
        approved.fingerprint,
        true,
      );
      await hostilePage.waitForFunction(browserFailed, undefined, {
        timeout: 20000,
      });
      const hostileStats = await hostilePage.evaluate(readBrowserStats);
      assert(hostileStats.some((entry) => entry.dtlsState === 'failed'));
      assert.deepEqual(hostile.messages, []);
      await hostileContext.close();
      await hostile.peer.close();
    }
  }
  await relay.close();
  const captured = readFileSync(relay.capturePath);
  assert(
    captured.length > 0,
    'Transport proof requires a nonempty relay capture',
  );
  assert.equal(captured.includes(Buffer.from(marker)), false);
  if (accountStation) {
    for (const secret of [
      accountStation.browser.password,
      accountStation.browser.credential,
      accountStation.browser.invitation,
      accountStation.sharedWork.sharedTask.messageMarker,
      accountStation.sharedWork.sharedTask.documentMarker,
      ...cookieAdoptionSecrets,
    ])
      assert.equal(captured.includes(Buffer.from(secret)), false);
  }
  if (freshRelayReport && accountStation) {
    const passwordAbsent = !captured.includes(
      Buffer.from(accountStation.browser.password),
    );
    assert.equal(passwordAbsent, true);
    freshRelayReport.passwordMarkerAbsentFromTurnCapture = passwordAbsent;
    const contentMarkersAbsent = [
      accountStation.sharedWork.sharedTask.messageMarker,
      accountStation.sharedWork.sharedTask.documentMarker,
    ].map((value) => !captured.includes(Buffer.from(value)));
    assert(contentMarkersAbsent.every(Boolean));
    freshRelayReport.contentMarkersAbsentFromTurnCapture = contentMarkersAbsent;
    writeFileSync(
      join(root, 'fresh-relay-enrollment.json'),
      JSON.stringify(freshRelayReport, null, 2),
      { mode: 0o600 },
    );
  }
  if (applicationProtocol)
    assert.equal(
      captured.includes(Buffer.from(applicationProtocol.requestMarker)),
      false,
    );
  abort.signal.throwIfAborted();
  report = {
    scope: 'browser-transport-evaluation',
    status: 'passed',
    sourceCommitSha,
    sourceWorktreeClean,
    pionExecutableSha256,
    applicationAccounts: accountReport ?? { status: 'not-run' },
    cookieAdoption: cookieAdoptionReport ?? { status: 'not-run' },
    freshRelayEnrollment: freshRelayReport ?? { status: 'not-run' },
    stationUiRelayJourney: stationUiRelayJourney ?? { status: 'not-run' },
    applicationProtocol: applicationProtocol
      ? {
          status: 'passed',
          responseBytes: applicationProtocol.responseBytes,
          scope: 'SDK framing fixture; no account or Station application API',
        }
      : { status: 'not-run' },
    browser: browser.version(),
    peerAdapter,
    ...(peerAdapter === 'pion'
      ? pionProvenance
      : {
          nodeDatachannel: '0.33.3',
          libdatachannel: datachannel.getLibraryVersion(),
        }),
    browserTurnTransport: browserTransport,
    stationTurnTransport: peerAdapter === 'pion' ? 'tcp' : 'udp',
    captureBytes: captured.length,
    turnImage: TURN_FIXTURE_IMAGE,
    checks: stationUi
      ? [
          'UI-only acceptance; legacy account, cookie-adoption and revocation suites not run',
          'ordinary Station SPA approves operator key report and accepts a broker invitation',
          'fresh account login and explicit operator Device approval complete in the browser UI',
          'browser and Station selected TURN candidates are relay candidates',
          'Project and published Task appear in the UI; unpublished Task stays hidden',
          'protected route reads use the broker channel with zero direct Station API egress',
        ]
      : selfHostedBroker
        ? [
            'separate broker CLI process serves metadata and signaling',
            'one-time client invitation and distinct broker grant used in the browser',
            'actual browser CORS and client-grant credential refusal',
            'one client grant revoked while the other and Station connector remain live',
            'two explicitly allowed HTTPS client Origins share one Station allocation without sharing grants',
            'production Pion and browser transport carry authenticated Station application traffic',
            'TURN relay candidates selected at both ends',
            'broker lease renewed while application traffic continues',
            'fresh peer reconnect preserves the approved Device and account continuation',
            'fresh no-cookie/no-Device account enrollment requires real operator approval and signed ACK',
            'tampered broker proof rejected before setRemoteDescription',
            'cross-tab Device trust revocation refuses new admission',
            'withdrawn routing credential refused by browser and exact HTTP control',
          ]
        : [
            'TURN relay selected at both peers',
            'Station-signed exact client, generation and SDP proof verified and consumed in the browser',
            'Station signing identity restored from its private home before proof issuance',
            'tampered proof refused before accepting the connection description',
            'Device trust persisted and rechecked after crypto; cross-tab revocation refused before SDP acceptance',
            'browser-native DTLS connected',
            applicationPion
              ? 'authenticated SDK application payload crossed the production Pion channel without diagnostic echo'
              : 'application content echoed through encrypted data channel',
            'fresh browser and peer reconnect using the same approved Station certificate',
            'unapproved signaling fingerprint refused',
            'substituted endpoint fails DTLS fingerprint verification',
          ],
    selfHostedBroker: stationUi
      ? { status: 'not-run-ui-only' }
      : (brokerJourney ?? { status: 'not-run' }),
    fullBroker: stationUi
      ? 'not-run-ui-only'
      : selfHostedBroker
        ? 'lab-composition'
        : 'not-implemented',
    productionKeyAdmission: 'not-implemented',
  };
} catch (error) {
  errors.push(error);
} finally {
  stopBundler();
  for (const peer of peers) {
    try {
      await peer.close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const cleanup of [
    () => freshRelayJourney?.close(),
    () => (browser ? bounded(browser.close(), 'browser cleanup') : undefined),
    () => accountStation?.stop(),
    () => brokerLab?.stop(),
    () => relay?.close(),
    () => turnFixture.stop(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (securePageServer?.listening)
    await new Promise<void>((resolve) =>
      securePageServer!.close(() => resolve()),
    );
  if (secondarySecurePageServer?.listening)
    await new Promise<void>((resolve) =>
      secondarySecurePageServer!.close(() => resolve()),
    );
  await viteServer?.close();
  datachannel.cleanup();
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
if (!report && !errors.length)
  errors.push(new Error('No completed browser transport report'));
if (errors.length) {
  const firstOwnedLocation = errors
    .map(firstOwnedFailureLocation)
    .find((location) => location !== undefined);
  writeFileSync(
    join(root, 'failure.json'),
    JSON.stringify(
      {
        scope: 'browser-transport-evaluation',
        status: 'failed',
        errorNames: errors.map((error) =>
          error instanceof Error ? error.name : 'UnknownError',
        ),
        ...(firstOwnedLocation ? { firstOwnedLocation } : {}),
        stationUi: stationUiRelayJourney ??
          stationUiFailure ?? { status: 'no-station-ui-diagnostic' },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.exitCode = 1;
}
const finalReport = errors.length
  ? {
      scope: 'browser-transport-evaluation',
      status: 'failed',
      browserTurnTransport: browserTransport,
      stationUi: stationUiRelayJourney ??
        stationUiFailure ?? { status: 'not-reached' },
    }
  : report;
writeFileSync(join(root, 'report.json'), JSON.stringify(finalReport, null, 2), {
  mode: 0o600,
});
process.stdout.write(
  `STATION_BROWSER_TRANSPORT_REPORT ${JSON.stringify(finalReport)}\n`,
);
if (errors.length || args.includes('--keep'))
  process.stdout.write(`Private evidence: ${root}\n`);
else rmSync(root, { recursive: true, force: true });
