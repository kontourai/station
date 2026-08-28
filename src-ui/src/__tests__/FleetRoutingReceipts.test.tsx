/**
 * @vitest-environment jsdom
 */

/**
 * archive#1398 — what the web monitoring surface actually SHOWS
 * about fleet routing (`docs/design/inference-fleet.md` §4.5, §8).
 *
 * The mirror of `packages/cli/src/__tests__/operate-fleet-routing.test.ts`:
 * both surfaces read the same receipt and must make the same claims, so the
 * same four honesty properties are asserted here against rendered text.
 */

import type {
  FleetRoutingCandidate,
  FleetRoutingReceiptPage,
  FleetServeReceiptPage,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  FLEET_LOCAL_EVIDENCE_LABEL,
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { StationHttpError } from '@kontourai/station-sdk';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const queryState: {
  data?: FleetRoutingReceiptPage;
  isLoading: boolean;
  error?: Error;
} = { isLoading: false };

const serveState: {
  data?: FleetServeReceiptPage;
  isLoading: boolean;
  error?: Error;
} = { isLoading: false };

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  // archive#3444: the component derives its failure copy from
  // `error instanceof StationHttpError`, so the mocked module must export a
  // real `StationHttpError` — a stub `undefined` binding throws on
  // `instanceof` at render time. Everything else about the module stays
  // mocked, only the two query hooks below.
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    useFleetRoutingReceiptsQuery: () => queryState,
    useFleetServeReceiptsQuery: () => serveState,
  };
});

const { FleetRoutingReceipts, FleetServeReceipts } = await import(
  '../components/monitoring/FleetRoutingReceipts'
);

const PEER_EVIDENCE = {
  level: 'declared' as const,
  provenance: 'peer-attested' as const,
  label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  peerAttested: {
    availability: 'available',
    freshness: 'live',
    observedAt: '2026-08-01T00:00:00.000Z',
    manifestSourceObservedAt: '2026-08-01T00:00:00.000Z',
    fetchedAt: '2026-08-01T12:00:00.000Z',
    digest: 'a'.repeat(64),
  },
  probe: null,
};

function page(
  overrides: Partial<FleetRoutingReceiptPage> = {},
): FleetRoutingReceiptPage {
  return {
    schemaVersion: 'station.fleet-routing-receipt/v1',
    totalRecords: 1,
    chain: {
      status: 'intact',
      brokenAtReceiptId: null,
      message: 'All 1 record(s) match their own content digest.',
    },
    receipts: [
      {
        schemaVersion: 'station.fleet-routing-receipt/v1',
        receiptId: 'b'.repeat(64),
        previousReceiptId: null,
        recordedAt: '2026-08-01T12:00:01.000Z',
        environmentId: 'env-laptop',
        agentName: 'researcher',
        dispatch: {
          schemaVersion: 1,
          planDigest: 'plan',
          requestDigest: 'request',
          role: 'station-agent',
          outcome: 'succeeded',
          attempts: [],
          totalElapsedMs: 12,
          totalTokens: 0,
          estimatedCostUsd: 0,
        },
        candidates: [],
        exclusions: [
          {
            candidateId: null,
            environmentId: 'env-nas',
            environmentLabel: 'NAS',
            modelId: 'ollama/llama4',
            code: 'below-minimum-evidence',
            message: 'NAS has one and this Station refused to trust it yet.',
            source: 'station',
          },
        ],
        constraints: [],
        stream: {
          capable: false,
          reason: 'A Dispatch-routed turn is buffered end to end.',
        },
        selection: {
          candidateId: 'fleet-candidate-0',
          origin: 'fleet',
          environmentId: 'env-workstation',
          environmentLabel: 'Workstation',
          modelId: 'ollama/qwen3',
          evidence: PEER_EVIDENCE,
        },
        failure: null,
        interactivity: 'non-interactive',
        signature: null,
      },
    ],
    ...overrides,
  };
}

function renderWith(state: Partial<typeof queryState>): string {
  queryState.data = undefined;
  queryState.error = undefined;
  queryState.isLoading = false;
  Object.assign(queryState, state);
  const { container } = render(<FleetRoutingReceipts />);
  return container.textContent ?? '';
}

describe('the web fleet routing surface', () => {
  test('shows the peer, the model, and the peer-attested label — never "verified"', () => {
    const text = renderWith({ data: page() });
    expect(text).toContain('Workstation');
    expect(text).toContain('ollama/qwen3');
    expect(text).toContain(FLEET_PEER_ATTESTED_EVIDENCE_LABEL);
    expect(text).not.toContain(FLEET_LOCAL_EVIDENCE_LABEL);
    const verifiedMentions = text.match(/\S+ verified/g) ?? [];
    expect(verifiedMentions.length).toBeGreaterThan(0);
    expect(
      verifiedMentions.every((mention) => mention === 'not verified'),
    ).toBe(true);
  });

  test('shows every exclusion, including below-minimum-evidence', () => {
    const text = renderWith({ data: page() });
    expect(text).toContain('below-minimum-evidence');
    expect(text).toContain('NAS / ollama/llama4');
    expect(text).toContain('refused to trust it yet');
  });

  // archive#1398 — the same three-state distinction the CLI holds.
  // Both surfaces render from the CONTRACT's wording, so this suite and its
  // CLI twin fail together if that wording ever softens.
  function withProbe(
    probe: FleetRoutingCandidate['evidence']['probe'],
    overrides: Partial<FleetRoutingCandidate['evidence']> = {},
  ) {
    const base = page();
    const receipt = base.receipts[0]!;
    receipt.selection = {
      candidateId: 'fleet-candidate-0',
      origin: 'fleet',
      environmentId: 'env-workstation',
      environmentLabel: 'Workstation',
      modelId: 'ollama/qwen3',
      evidence: {
        level: 'declared',
        provenance: 'peer-attested',
        label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
        peerAttested: null,
        probe,
        ...overrides,
      },
    };
    return base;
  }

  test('renders the probe-verified label for a probed candidate, never the local one', () => {
    const text = renderWith({
      data: withProbe(
        {
          status: 'passed',
          observedAt: '2026-08-01T11:59:00.000Z',
          expiresAt: '2026-08-01T12:14:00.000Z',
          elapsedMs: 21,
          servedProviderModel: 'qwen3:32b',
          failureCode: null,
        },
        {
          level: 'confirmed',
          provenance: 'probe-verified',
          label: FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
        },
      ),
    });
    expect(text).toContain(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL);
    expect(text).not.toContain(FLEET_LOCAL_EVIDENCE_LABEL);
    expect(text).toContain('probed from here');
  });

  test('an expired probe reads as peer-attested and says the observation expired', () => {
    const text = renderWith({
      data: withProbe({
        status: 'stale',
        observedAt: '2026-08-01T11:00:00.000Z',
        expiresAt: '2026-08-01T11:15:00.000Z',
        elapsedMs: 21,
        servedProviderModel: 'qwen3:32b',
        failureCode: null,
      }),
    });
    expect(text).toContain(FLEET_PEER_ATTESTED_EVIDENCE_LABEL);
    expect(text).not.toContain(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL);
    expect(text).toContain('not evidence about now');
  });

  test('a never-probed candidate says nothing about probing', () => {
    const text = renderWith({ data: withProbe(null) });
    expect(text).not.toContain('probed from here');
    expect(text).not.toContain('not evidence about now');
  });

  test('shows a fallback as a named state rather than a plain success', () => {
    const base = page();
    const receipt = base.receipts[0]!;
    receipt.selection = {
      candidateId: 'candidate-0',
      origin: 'local',
      environmentId: null,
      environmentLabel: null,
      modelId: 'claude-sonnet',
      evidence: {
        level: 'confirmed',
        provenance: 'local-observation',
        label: FLEET_LOCAL_EVIDENCE_LABEL,
        peerAttested: null,
        probe: null,
      },
    };
    receipt.failure = {
      code: 'fell-back-to-local',
      message:
        'This turn ran on a local model after a fleet candidate failed: Workstation (peer-unreachable).',
    };
    const text = renderWith({ data: base });
    expect(text).toContain('fell-back-to-local');
    expect(text).toContain('Workstation (peer-unreachable)');
  });

  test('says receipted by content digest, not signed', () => {
    const text = renderWith({ data: page() });
    expect(text).toContain('Receipted by content digest');
    expect(text).toContain('not');
    expect(text).not.toContain('signed by');
  });

  test('renders a failed read as unknown, never as an empty receipt list', () => {
    const text = renderWith({ error: new Error('connection refused') });
    expect(text).toContain('connection refused');
    expect(text).toContain('unknown, not empty');
    expect(screen.queryByText(/No turn has been fleet-routed/)).toBeNull();
  });

  // fix-round : `!error && !data` is also true before a fetch has even
  // begun — e.g. while `PersistQueryClientProvider` is still restoring from
  // IndexedDB, `isLoading` reads `false` because nothing has started
  // fetching yet. That must render as the ordinary loading state, never as
  // an alert claiming a failure that has not happened.
  test('renders the loading state, not an error alert, when there is no error and no data yet', () => {
    const text = renderWith({});
    expect(text).toContain("Reading this Station's routing receipts");
    expect(screen.queryByRole('alert')).toBeNull();
    expect(text).not.toContain("Station isn't responding");
    expect(text).not.toContain('unknown, not empty');
  });

  test('says nothing has been routed only when the Station said so', () => {
    const text = renderWith({
      data: page({ receipts: [], totalRecords: 0 }),
    });
    expect(text).toContain('No turn has been fleet-routed on this Station yet');
  });

  test('surfaces a broken chain verdict', () => {
    const text = renderWith({
      data: page({
        chain: {
          status: 'broken',
          brokenAtReceiptId: 'b'.repeat(64),
          message: 'This receipt log has been edited or truncated.',
        },
      }),
    });
    expect(text).toContain('Chain broken');
    expect(text).toContain('edited or truncated');
  });

  // archive#3444: the copy must say "retrying automatically" only when the
  // query actually keeps polling (resolveFleetReceiptsRefetchInterval),
  // never derived from a message-shape check that cannot tell a stopped
  // credential rejection apart from a still-retrying transient failure.
  test('says the query will not retry on a terminal (401) failure', () => {
    const text = renderWith({
      error: new StationHttpError(401, 'Unauthorized'),
    });
    expect(text).not.toContain('retrying automatically');
    expect(text).toContain('will not retry automatically');
  });

  // fix-round : "retrying automatically" is honest only for a
  // TRANSPORT failure (no Response ever arrived) — the query keeps its
  // unconditional 30s poll, but so does a non-terminal HTTP-status failure,
  // and that case has its own arm below because the host DID respond.
  test('says retrying automatically for a genuine transport failure (no response ever arrived)', () => {
    const text = renderWith({
      error: new TypeError('Failed to fetch'),
    });
    expect(text).toContain('retrying automatically');
    expect(text).not.toContain('will not retry automatically');
    expect(text).not.toContain("Couldn't load");
  });

  // fix-round : the string this class of defect keeps re-deleting.
  // A response DID arrive (a non-terminal HTTP status, or a 2xx body
  // reporting failure) — "Station isn't responding" would be false, so this
  // must be the neutral copy, not the transport-failure one.
  test("says Couldn't load — not 'isn't responding' — when a response arrived carrying a non-terminal error", () => {
    const text = renderWith({
      error: new StationHttpError(
        503,
        'This Station cannot locate its receipt log, so whether it has fleet-routed anything is unknown rather than empty.',
      ),
    });
    expect(text).toContain("Couldn't load fleet routing receipts.");
    expect(text).not.toContain("Station isn't responding");
    expect(text).not.toContain('will not retry automatically');
    // The server's own sentence survives, in the details block.
    expect(text).toContain(
      'This Station cannot locate its receipt log, so whether it has fleet-routed anything is unknown rather than empty.',
    );
  });
});

function servePage(
  overrides: Partial<FleetServeReceiptPage> = {},
): FleetServeReceiptPage {
  return {
    schemaVersion: 'station.fleet-serve-receipt/v1',
    totalRecords: 1,
    chain: {
      status: 'intact',
      brokenAtReceiptId: null,
      message: 'All 1 record(s) match their own content digest.',
    },
    receipts: [
      {
        schemaVersion: 'station.fleet-serve-receipt/v1',
        receiptId: 'c'.repeat(64),
        previousReceiptId: null,
        recordedAt: '2026-08-01T10:00:02.000Z',
        peerFingerprint: 'd'.repeat(64),
        requestedModelId: 'ollama:llama3.3',
        promptDigest: 'e'.repeat(64),
        outcome: 'served',
        refusalCode: null,
        completionCharacters: 18,
        elapsedMs: 42,
        signature: null,
      },
    ],
    ...overrides,
  };
}

function renderServe(state: Partial<typeof serveState>): string {
  serveState.data = undefined;
  serveState.error = undefined;
  serveState.isLoading = false;
  Object.assign(serveState, state);
  const { container } = render(<FleetServeReceipts />);
  return container.textContent ?? '';
}

describe('the SERVING side is readable too (security review, M-2)', () => {
  test('shows what was served, the peer fingerprint, and the chain verdict', () => {
    const text = renderServe({ data: servePage() });
    expect(text).toContain('ollama:llama3.3');
    expect(text).toContain('served');
    expect(text).toContain('Chain intact');
    // The fingerprint is rendered as what it is — not as an identity.
    expect(text).toContain('credential fingerprint, not an identity');
  });

  test('never renders a prompt, a completion, or a credential', () => {
    const text = renderServe({ data: servePage() });
    expect(text).toContain('the request content is never recorded');
    expect(text).toContain('not signed');
  });

  test('a refusal is shown by code rather than omitted', () => {
    const page = servePage();
    page.receipts[0]!.outcome = 'refused';
    page.receipts[0]!.refusalCode = 'model-not-contributed';
    const text = renderServe({ data: page });
    expect(text).toContain('refused');
    expect(text).toContain('model-not-contributed');
  });

  test('a failed read is unknown, never an empty served list', () => {
    const text = renderServe({ error: new Error('permission denied') });
    expect(text).toContain('permission denied');
    expect(text).toContain('unknown, not empty');
    expect(text).not.toContain('has not served any fleet inference yet');
  });

  // fix-round : mirrors the routing side's sibling above.
  test('renders the loading state, not an error alert, when there is no error and no data yet', () => {
    const text = renderServe({});
    expect(text).toContain('Reading what this Station has served');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(text).not.toContain("Station isn't responding");
    expect(text).not.toContain('unknown, not empty');
  });

  test('says nothing has been served only when the Station said so', () => {
    const text = renderServe({
      data: servePage({ receipts: [], totalRecords: 0 }),
    });
    expect(text).toContain('has not served any fleet inference yet');
  });

  // archive#3444: same derivation as the routing side's copy — mirrored here
  // because `useFleetServeReceiptsQuery` gets its own independent terminal
  // stop.
  test('says the query will not retry on a terminal (403) failure', () => {
    const text = renderServe({
      error: new StationHttpError(403, 'Forbidden'),
    });
    expect(text).not.toContain('retrying automatically');
    expect(text).toContain('will not retry automatically');
  });

  // fix-round : mirrors the routing side's sibling pair above.
  test('says retrying automatically for a genuine transport failure (no response ever arrived)', () => {
    const text = renderServe({
      error: new TypeError('Failed to fetch'),
    });
    expect(text).toContain('retrying automatically');
    expect(text).not.toContain('will not retry automatically');
    expect(text).not.toContain("Couldn't load");
  });

  test("says Couldn't load — not 'isn't responding' — when a response arrived carrying a non-terminal error", () => {
    const text = renderServe({
      error: new StationHttpError(
        503,
        'This Station cannot locate its receipt log, so what it has served is unknown rather than empty.',
      ),
    });
    expect(text).toContain("Couldn't load fleet inference served receipts.");
    expect(text).not.toContain("Station isn't responding");
    expect(text).not.toContain('will not retry automatically');
    expect(text).toContain(
      'This Station cannot locate its receipt log, so what it has served is unknown rather than empty.',
    );
  });
});
