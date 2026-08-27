/**
 * station#1398 slice 4 — what `station operate` actually PRINTS about fleet
 * routing (`docs/design/inference-fleet.md` §4.5, §8, §11 slice 4).
 *
 * Every assertion here is against human-visible output, not against a view
 * model: the design's banned behaviors are things a user does or does not
 * see, so a test that stops at the reducer cannot prove any of them.
 */

import type {
  FleetRoutingCandidate,
  FleetRoutingReceiptEnvelope,
  FleetRoutingReceiptPage,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  FLEET_LOCAL_EVIDENCE_LABEL,
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { describe, expect, it } from 'vitest';
import { render } from '../commands/operate/render.js';
import { initialState, reduce } from '../commands/operate/state.js';
import type { OperateState } from '../commands/operate/types.js';

const PEER_CANDIDATE: FleetRoutingCandidate = {
  candidateId: 'fleet-candidate-0',
  runtimeId: 'fleet-runtime-0',
  origin: 'fleet',
  environmentId: 'env-workstation',
  environmentLabel: 'Workstation',
  modelId: 'ollama/qwen3',
  evidence: {
    level: 'declared',
    provenance: 'peer-attested',
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
  },
  admitted: true,
};

function receipt(
  overrides: Partial<FleetRoutingReceiptEnvelope> = {},
): FleetRoutingReceiptEnvelope {
  return {
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
    candidates: [PEER_CANDIDATE],
    exclusions: [],
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
      evidence: PEER_CANDIDATE.evidence,
    },
    failure: null,
    interactivity: 'non-interactive',
    signature: null,
    ...overrides,
  };
}

function page(
  overrides: Partial<FleetRoutingReceiptPage> = {},
): FleetRoutingReceiptPage {
  return {
    schemaVersion: 'station.fleet-routing-receipt/v1',
    receipts: [receipt()],
    totalRecords: 1,
    chain: {
      status: 'intact',
      brokenAtReceiptId: null,
      message: 'All 1 record(s) match their own content digest.',
    },
    ...overrides,
  };
}

function paneFor(state: OperateState): string {
  const lines = render(state);
  const start = lines.indexOf('FLEET ROUTING');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf('FOOTER', start);
  return lines.slice(start, end).join('\n');
}

function stateWith(fleetRouting: OperateState['fleetRouting']): OperateState {
  const base = initialState({});
  return fleetRouting === undefined
    ? base
    : reduce(base, { type: 'fleet-routing-snapshot', fleetRouting });
}

describe('station operate renders fleet routing honestly', () => {
  it('prints the peer-attested label verbatim, never "verified"', () => {
    const pane = paneFor(stateWith({ page: page() }));
    expect(pane).toContain('Workstation');
    expect(pane).toContain(FLEET_PEER_ATTESTED_EVIDENCE_LABEL);
    // The fault-injection target: a surface that rendered a peer's claim the
    // way it renders a locally-observed one.
    expect(pane).not.toContain(FLEET_LOCAL_EVIDENCE_LABEL);
    // Every mention of "verified" in this pane must be a DENIAL of
    // verification. This is the assertion the fault injection targets: swap
    // the label for a verified-sounding one and this goes red.
    const verifiedMentions = pane.match(/\S+ verified/g) ?? [];
    expect(verifiedMentions.length).toBeGreaterThan(0);
    expect(
      verifiedMentions.every((mention) => mention === 'not verified'),
    ).toBe(true);
  });

  // ------------------------------------------------------------------
  // station#1398 slice 5. Three states must stay distinguishable ON THE
  // SURFACE, not merely in the receipt: probe-verified, peer-attested, and
  // "probed once, expired". A surface that collapses any two of them
  // undoes the whole point of running the probe.
  // ------------------------------------------------------------------
  function selectionWithProbe(
    probe: FleetRoutingCandidate['evidence']['probe'],
    overrides: Partial<FleetRoutingCandidate['evidence']> = {},
  ) {
    return receipt({
      selection: {
        candidateId: 'fleet-candidate-0',
        origin: 'fleet' as const,
        environmentId: 'env-workstation',
        environmentLabel: 'Workstation',
        modelId: 'ollama/qwen3',
        evidence: {
          level: 'declared' as const,
          provenance: 'peer-attested' as const,
          label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
          peerAttested: null,
          probe,
          ...overrides,
        },
      },
    });
  }

  it('a probe-verified candidate renders its OWN label, distinct from the local one', () => {
    const pane = paneFor(
      stateWith({
        page: page({
          receipts: [
            selectionWithProbe(
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
          ],
        }),
      }),
    );
    expect(pane).toContain(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL);
    // A probed PEER is not a LOCAL model, and the pane must not imply it is.
    expect(pane).not.toContain(FLEET_LOCAL_EVIDENCE_LABEL);
    expect(pane).toContain('probed from here 2026-08-01T11:59:00.000Z');
  });

  it('an EXPIRED probe renders as peer-attested AND says the observation expired', () => {
    const pane = paneFor(
      stateWith({
        page: page({
          receipts: [
            selectionWithProbe({
              status: 'stale',
              observedAt: '2026-08-01T11:00:00.000Z',
              expiresAt: '2026-08-01T11:15:00.000Z',
              elapsedMs: 21,
              servedProviderModel: 'qwen3:32b',
              failureCode: null,
            }),
          ],
        }),
      }),
    );
    // Back to the honest peer-attested wording ...
    expect(pane).toContain(FLEET_PEER_ATTESTED_EVIDENCE_LABEL);
    expect(pane).not.toContain(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL);
    // ... and NOT identical to a never-probed candidate. Without this clause
    // "we checked an hour ago and it passed" reads exactly like "we have
    // never checked this".
    expect(pane).toContain('not evidence about now');
  });

  it('a never-probed candidate says nothing about probing at all', () => {
    const pane = paneFor(
      stateWith({ page: page({ receipts: [selectionWithProbe(null)] }) }),
    );
    expect(pane).toContain(FLEET_PEER_ATTESTED_EVIDENCE_LABEL);
    expect(pane).not.toContain('probed from here');
    expect(pane).not.toContain('not evidence about now');
  });

  it('prints a fallback as a named state instead of a plain success', () => {
    const fellBack = receipt({
      selection: {
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
      },
      failure: {
        code: 'fell-back-to-local',
        message:
          'This turn ran on a local model after a fleet candidate failed: Workstation (peer-unreachable).',
      },
    });
    const pane = paneFor(stateWith({ page: page({ receipts: [fellBack] }) }));
    expect(pane).toContain('fell-back-to-local');
    expect(pane).toContain('Workstation (peer-unreachable)');
  });

  it('prints every exclusion, including below-minimum-evidence', () => {
    const excluded = receipt({
      exclusions: [
        {
          candidateId: 'fleet-candidate-0',
          environmentId: 'env-workstation',
          environmentLabel: 'Workstation',
          modelId: 'ollama/qwen3',
          code: 'below-minimum-evidence',
          message:
            "This candidate's evidence is 'declared' (attested by peer, not verified); this agent's policy requires at least 'confirmed'.",
          source: 'station',
        },
        {
          candidateId: null,
          environmentId: 'env-nas',
          environmentLabel: 'NAS',
          modelId: null,
          code: 'peer-unreachable',
          message: 'NAS is not answering.',
          source: 'station',
        },
      ],
    });
    const pane = paneFor(stateWith({ page: page({ receipts: [excluded] }) }));
    expect(pane).toContain('below-minimum-evidence');
    expect(pane).toContain('Workstation/ollama/qwen3');
    expect(pane).toContain('peer-unreachable');
    expect(pane).toContain('NAS');
  });

  it('says "not signed" rather than implying a signature', () => {
    const pane = paneFor(stateWith({ page: page() }));
    expect(pane).toContain('not signed');
    expect(pane).not.toContain('signed by');
  });

  it('distinguishes never-pulled, unreadable, and genuinely-empty', () => {
    expect(paneFor(stateWith(undefined))).toContain('(not pulled)');

    const unreadable = paneFor(
      stateWith({ page: null, error: 'connection refused' }),
    );
    expect(unreadable).toContain('unknown, not empty');
    expect(unreadable).toContain('connection refused');

    const empty = paneFor(
      stateWith({
        page: page({ receipts: [], totalRecords: 0 }),
      }),
    );
    expect(empty).toContain(
      'no turn has been fleet-routed on this Station yet',
    );
  });

  it('renders a broken chain instead of the rows it cannot vouch for', () => {
    const pane = paneFor(
      stateWith({
        page: page({
          chain: {
            status: 'broken',
            brokenAtReceiptId: 'b'.repeat(64),
            message: 'This receipt log has been edited or truncated.',
          },
        }),
      }),
    );
    expect(pane).toContain('chain: broken');
    expect(pane).toContain('edited or truncated');
  });
});
