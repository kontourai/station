/**
 * FlowReadinessBridge - the S1c wiring: Veritas merge readiness into the Flow
 * half of the evidence pipeline.
 *
 * Contract (@kontourai/flow@1.3.0): Flow 1.3.x replaced the prior claim-based
 * evidence model with Hachure `trust.bundle` evidence. The gate-satisfying path
 * is now a Station-asserted synthetic TrustBundle carrying a
 * `governance.merge-readiness` claim. The trust model downgrades `verified`
 * without backing verification evidence, so the Station-asserted readiness claim
 * is `assumed` (the readiness gate's `accepted_statuses` is `["assumed"]`).
 * Attaching the full Veritas TrustBundle with genuine verification backing
 * (which could legitimately derive `verified`) is a future enhancement.
 *
 * Telemetry: readiness runs are recorded by VeritasReadinessService
 * (`station.veritas.readiness.*`) and attachments by FlowRunService
 * (`station.flow.evidence.attached`); the bridge adds no new instruments.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowDefinition, FlowEvidenceEntry } from '@kontourai/flow';
import { createStationTempDir } from '@kontourai/station-shared/temp-dir';
import { buildSyntheticTrustBundle } from '../evidence/trust-bundle.js';
import type {
  ReadinessSnapshot,
  ReadinessWorkspaceStatus,
  VeritasReadinessService,
} from '../evidence/veritas-readiness-service.js';
import {
  FlowRunInvalidError,
  type FlowRunService,
} from './flow-run-service.js';

/** The claim type Station asserts over a Veritas readiness evidence record. */
export const READINESS_CLAIM_TYPE = 'governance.merge-readiness';

export interface AttachReadinessEvidenceOptions {
  /** Explicit gate id; otherwise resolved from the run's definition. */
  gate?: string;
  /** Force a fresh readiness run (default true — gate evidence must be current). */
  refresh?: boolean;
  /**
   * Skip attaching when the readiness run reports not-ready (used by the
   * orchestration auto-attach path so a not-ready tree never consumes a
   * route-back attempt on the caller's behalf).
   */
  onlyWhenReady?: boolean;
}

export type ReadinessEvidenceOutcome =
  | {
      attached: true;
      gateId: string;
      entry: FlowEvidenceEntry;
      snapshot: ReadinessSnapshot;
    }
  | {
      attached: false;
      reason: 'not-ready';
      snapshot: ReadinessSnapshot;
    };

function readinessExpectationIds(
  definition: FlowDefinition,
  gateId: string,
): string[] {
  const gate = definition.gates?.[gateId];
  return (gate?.expects ?? [])
    .filter(
      (expectation) =>
        expectation.kind === 'trust.bundle' &&
        expectation.bundle_claim?.claimType === READINESS_CLAIM_TYPE,
    )
    .map((expectation) => expectation.id);
}

export class FlowReadinessBridge {
  constructor(
    private readonly deps: {
      flowRunService: FlowRunService;
      readinessService: VeritasReadinessService;
    },
  ) {}

  /** Cheap, never-throwing Veritas workspace detection (delegated). */
  detectWorkspace(cwd: string): ReadinessWorkspaceStatus {
    return this.deps.readinessService.detectWorkspace(cwd);
  }

  /**
   * Run (or load) Veritas readiness for the workspace and attach a Station-
   * asserted synthetic TrustBundle to the run's readiness gate.
   *
   * - ready → claim `governance.merge-readiness` / `assumed` (gate-satisfying)
   * - not-ready → entry status `failed` + route_reason `missing_evidence`
   *   (drives Flow's route-back machinery on the next evaluate) unless
   *   `onlyWhenReady` is set, in which case nothing is attached.
   *
   * Prior non-superseded readiness evidence on the gate is superseded, so a
   * re-run after a route-back recovers the gate per the Flow contract.
   */
  async attachReadinessEvidence(
    cwd: string,
    runId: string,
    options: AttachReadinessEvidenceOptions = {},
  ): Promise<ReadinessEvidenceOutcome> {
    const { flowRunService, readinessService } = this.deps;
    const snapshot = await readinessService.getReadiness(cwd, {
      refresh: options.refresh ?? true,
    });
    if (!snapshot.cli.reportArtifactPath) {
      throw new FlowRunInvalidError(
        'veritas readiness produced no evidence record path (reportArtifactPath missing)',
      );
    }

    const ready = snapshot.overall === 'ready';
    if (!ready && options.onlyWhenReady) {
      return { attached: false, reason: 'not-ready', snapshot };
    }

    const run = await flowRunService.getRun(cwd, runId);
    const gateId = options.gate ?? this.resolveGate(run.definition, run);
    const expectationIds = readinessExpectationIds(run.definition, gateId);
    const supersede = run.manifest.evidence
      .filter(
        (entry: FlowEvidenceEntry) =>
          entry.gate_id === gateId &&
          !entry.superseded_by &&
          entry.bundle?.claims?.some(
            (claim: { claimType?: string }) =>
              claim.claimType === READINESS_CLAIM_TYPE,
          ) === true,
      )
      .map((entry: FlowEvidenceEntry) => entry.id);

    // Flow 1.3.x evidence is a Hachure TrustBundle. Assert a synthetic Station
    // bundle carrying the readiness claim (status `assumed` — the trust model
    // downgrades `verified` without backing verification). The entry status
    // (`failed` when not-ready) drives gate route-back. The Veritas record path
    // is recorded on the claim value for audit traceability.
    const bundleDir = await createStationTempDir('readiness-evidence');
    const bundlePath = join(bundleDir, 'trust-bundle.json');
    await writeFile(
      bundlePath,
      `${JSON.stringify(
        buildSyntheticTrustBundle({
          claimType: READINESS_CLAIM_TYPE,
          subjectId: runId,
          value: ready ? 'ready' : 'not-ready',
          fieldOrBehavior: snapshot.cli.reportArtifactPath,
        }),
        null,
        2,
      )}\n`,
    );

    const entry = await flowRunService.attachEvidence(cwd, runId, {
      gate: gateId,
      file: bundlePath,
      kind: 'trust.bundle',
      producer: 'veritas',
      ...(ready ? {} : { status: 'failed', routeReason: 'missing_evidence' }),
      ...(expectationIds.length ? { expectationIds } : {}),
      ...(supersede.length ? { supersede } : {}),
    });

    return { attached: true, gateId, entry, snapshot };
  }

  /**
   * Find the gate the readiness claim can satisfy: a gate whose expectations
   * include a `trust.bundle` selecting claimType `governance.merge-readiness`.
   * Prefers a currently open gate; falls back to definition order.
   */
  private resolveGate(
    definition: FlowDefinition,
    run: { openGates: Array<{ id: string; step: string }> },
  ): string {
    const candidates = Object.keys(definition.gates ?? {}).filter(
      (gateId) => readinessExpectationIds(definition, gateId).length > 0,
    );
    if (candidates.length === 0) {
      throw new FlowRunInvalidError(
        `no gate in definition ${definition.id} expects claim type ${READINESS_CLAIM_TYPE}`,
      );
    }
    const openIds = new Set(run.openGates.map((gate) => gate.id));
    return candidates.find((gateId) => openIds.has(gateId)) ?? candidates[0];
  }
}
