import { copyFile } from 'node:fs/promises';
import { buildStationTaskBasisMcpAppResource } from '@kontourai/station-basis-pane/task-basis-mcp-app';
import { buildStationTaskBasisMcpPage } from '@kontourai/station-contracts/task-basis-mcp';
import { encodeTaskToolResultReference } from '@kontourai/station-contracts/task-graph';
import {
  type BasisProjection,
  composeBasisProjection,
  parseBasisProjection,
} from '@kontourai/surface/basis';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { buildMcpAppsSandboxProxyDocument } from '../src-server/runtime/mcp/mcp-ui-frame-server';
import { expectNoBlockingAccessibilityViolations } from './helpers/accessibility';
import { contrastRatio } from './helpers/color-contrast';
import { E2E_STATION_COMPATIBILITY } from './helpers/current-station-contract';

const taskId = 'answer-support-ui';
const referenceId = 'answer-reference-ui';
const basisFrameOrigin = 'http://basis-proxy.test';
const executionRef = {
  authority: '@kontourai/thread',
  schemaVersion: '1.2.0',
  kind: 'result',
  threadId: 'session-ui',
  resultId: 'terminal-result-ui',
} as const;
const executionText = `<img src=x onerror=alert(1)> inert tool output ${'x'.repeat(2400)}`;
const safeExecutionResult = {
  resultId: executionRef.resultId,
  name: 'fixture-tool-ui',
  terminalStatus: 'error',
  content: [{ type: 'text', text: executionText }],
  truncated: true,
  omittedParts: 1,
  omittedTextBytes: 200,
  omittedMetadataBytes: 0,
  authorityDecision: { decision: 'denied', authority: 'kontourai.station' },
};
const longValue = JSON.stringify({
  alpha: 'a'.repeat(620),
  nested: { z: 'value' },
});
const basisProjection = {
  version: 'surface.basis-projection/v1',
  answer: {
    owner: { authority: '@kontourai/thread' },
    state: 'available',
    observedAt: '2026-08-25T00:00:00.000Z',
    value: {
      ref: {
        authority: '@kontourai/thread',
        schemaVersion: '1.2.0',
        kind: 'assistant-message',
        standing: 'observed',
        threadId: 'session-ui',
        messageId: 'message-ui',
      },
      fact: 'answer-observed',
      observedAt: '2026-08-25T00:00:00.000Z',
    },
  },
  standing: 'execution-only',
  unresolvedReason: null,
  assessment: {
    owner: { authority: '@kontourai/surface' },
    state: 'not-captured',
    observedAt: '2026-08-25T00:00:00.000Z',
  },
  regions: {
    inputs: [],
    execution: [
      {
        ref: executionRef,
        role: 'execution',
        context: {
          kind: 'thread-result',
          name: 'fixture-tool-ui',
          terminalStatus: 'error',
          textParts: 1,
          truncatedParts: 1,
          omittedParts: 1,
        },
        gaps: [],
      },
    ],
    process: [],
    outcomes: [
      {
        ref: {
          authority: '@kontourai/station',
          schemaVersion: '1',
          kind: 'task-output',
          taskId,
          outputId: 'output-hostile-ui',
        },
        role: 'outcome',
        context: {
          kind: 'station-output',
          title: '<img src=x onerror=alert(1)> https://example.invalid',
          mediaType: 'text/plain',
          byteLength: 42,
          digest: 'sha256-example',
        },
        gaps: [],
      },
    ],
    support: [],
    sources: [],
    live: [],
  },
  relationships: [],
  gaps: [],
};

/**
 * Surface, rather than this browser fixture, owns standing derivation.  Keep
 * these inputs deliberately small: they distinguish a policy result from a
 * verified claim with no policy and from citation-only evidence.
 */
function surface3Projection(options: {
  policy: 'satisfied' | 'missing';
  evidence: 'entails' | 'cited';
  counterevidence?: boolean;
  gap?: boolean;
}) {
  const observedAt = '2026-08-26T00:00:00.000Z';
  return composeBasisProjection({
    version: 'surface.basis-projection/v1',
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt,
      value: {
        ref: {
          authority: '@kontourai/thread',
          schemaVersion: '1.2.0',
          kind: 'assistant-message',
          standing: 'observed',
          threadId: 'session-ui',
          messageId: 'message-ui',
        },
        fact: 'answer-observed',
        observedAt,
      },
    },
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'available',
      observedAt,
      value: {
        version: 'surface.answer-assessment/v2',
        ref: {
          authority: '@kontourai/surface',
          schemaVersion: 'surface.answer-assessment/v2',
          kind: 'answer-assessment',
          bundleId: 'surface3-bundle',
          claimId: 'surface3-claim',
        },
        found: true,
        bundle: {
          id: 'surface3-bundle',
          schemaVersion: 3,
          source: 'Surface 3 fixture',
          generatedAt: observedAt,
        },
        claim: {
          id: 'surface3-claim',
          subject: { subjectType: 'answer', subjectId: 'message-ui' },
          status: 'verified',
          freshness: { asOf: observedAt, expiresAt: null, stale: false },
        },
        policy:
          options.policy === 'satisfied'
            ? {
                version: 'surface.answer-assessment-policy/v1',
                id: 'surface3-policy',
                evaluatedAt: observedAt,
                outcome: 'satisfied',
                satisfied: true,
                reasons: [],
              }
            : null,
        evidence: {
          entails:
            options.evidence === 'entails'
              ? [
                  {
                    id: 'surface3-entails',
                    label: 'Explicitly entailing evidence',
                    sourceRef: 'surface3-source',
                    locator: null,
                    observedAt,
                    supportStrength: 'entails',
                    result: 'passed',
                    blocksClaim: false,
                  },
                ]
              : [],
          cited:
            options.evidence === 'cited'
              ? [
                  {
                    id: 'surface3-cited',
                    label: 'Citation only',
                    sourceRef: 'surface3-source',
                    locator: null,
                    observedAt,
                    supportStrength: 'cited',
                    result: 'passed',
                    blocksClaim: false,
                  },
                ]
              : [],
          undeclared: [],
          counterevidence: options.counterevidence
            ? [
                {
                  id: 'surface3-counter',
                  label: 'Adjacent counterevidence',
                  sourceRef: 'surface3-counter-source',
                  locator: null,
                  observedAt,
                  supportStrength: 'entails',
                  result: 'failed',
                  blocksClaim: true,
                },
              ]
            : [],
        },
        derivation: { available: true, directInputs: [] },
        gaps: options.gap
          ? [
              {
                code: 'derivation.weak',
                message: 'Weak derivation edge remains visible.',
              },
            ]
          : [],
      },
    },
    contributions: [
      {
        owner: { authority: '@kontourai/thread' },
        state: 'available',
        observedAt,
        value: [
          {
            ref: executionRef,
            answer: {
              authority: '@kontourai/thread',
              schemaVersion: '1.2.0',
              kind: 'assistant-message',
              standing: 'observed',
              threadId: 'session-ui',
              messageId: 'message-ui',
            },
            role: 'execution',
            context: {
              kind: 'thread-result',
              name: 'fixture-tool-ui',
              terminalStatus: 'error',
              textParts: 1,
              truncatedParts: 1,
              omittedParts: 1,
            },
          },
        ],
      },
    ],
  });
}

test('derives Surface 3 standing from the public composition boundary', () => {
  expect(
    surface3Projection({ policy: 'satisfied', evidence: 'entails' }).standing,
  ).toBe('policy-met');
  expect(
    surface3Projection({ policy: 'missing', evidence: 'entails' }).standing,
  ).toBe('assessed-with-gaps');
  // A cited-only record never carries a satisfied policy result from Surface.
  expect(
    surface3Projection({ policy: 'missing', evidence: 'cited' }).standing,
  ).toBe('assessed-with-gaps');
  expect(
    surface3Projection({
      policy: 'satisfied',
      evidence: 'entails',
      gap: true,
      counterevidence: true,
    }).standing,
  ).toBe('assessed-with-gaps');
});

function json(data: unknown) {
  return { contentType: 'application/json', body: JSON.stringify(data) };
}

/** Same-origin browser-access bootstrap, matching project-lifecycle's fixture. */
async function seedStationAccess(page: Page) {
  const stationUrl = process.env.PW_BASE_URL;
  if (!stationUrl)
    throw new Error('PW_BASE_URL is required for the Basis host fixture.');
  await page.route(`${basisFrameOrigin}/mcp-ui/proxy`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: buildMcpAppsSandboxProxyDocument('basis-fixture-proxy', [
        new URL(stationUrl).origin,
      ]),
    }),
  );
  await page.route('**/config/app', (route) =>
    route.fulfill(
      json({
        success: true,
        data: {
          apiBase: '',
          defaultModel: 'fixture-model',
          region: 'local',
          mcpUiHost: true,
          mcpUiFrameOrigin: basisFrameOrigin,
        },
      }),
    ),
  );
  await page.route(
    '**/.well-known/station/v1/pairing/access-request',
    (route) =>
      route.fulfill(
        json({
          bootstrap: 'same-origin-loopback',
          environmentId: 'task-answer-support-fixture',
          credential: 'fixture-credential',
          device: {
            id: 'fixture-device',
            name: 'This browser',
            scope: 'station:interactive',
            createdAt: 0,
            lastUsedAt: 0,
            revokedAt: null,
          },
        }),
      ),
  );
  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        environmentId: 'task-answer-support-fixture',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: E2E_STATION_COMPATIBILITY,
      }),
    ),
  );
  await page.route('**/notifications?**', (route) =>
    route.fulfill(json({ success: true, data: [] })),
  );
  await page.route('**/events', (route) =>
    route.fulfill({
      headers: { 'content-type': 'text/event-stream' },
      body: 'data: {"event":"connected"}\n\n',
    }),
  );
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/system/status')
      return route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: { configuredChatReady: true, configured: [] },
        }),
      );
    if (path === '/api/auth/status')
      return route.fulfill(json({ authenticated: true, user: null }));
    if (path === '/api/system/identity')
      return route.fulfill(
        json({
          environmentId: 'task-answer-support-fixture',
          instanceId: 'task-answer-support-instance',
          bootId: 'task-answer-support-boot',
          sha: '1111111111111111111111111111111111111111',
        }),
      );
    if (path === '/api/plugins')
      return route.fulfill(json({ success: true, data: [] }));
    return route.fulfill(json({ success: true, data: [] }));
  });
}

test('renders an exact answer-support projection in the real Task workspace DOM', async ({
  page,
}, testInfo) => {
  const captureReviewScreenshot = async (
    name: string,
    target: Page | Locator,
  ) => {
    const directory = process.env.STATION_UI_REVIEW_SCREENSHOT_DIR;
    if (!directory) return;
    await target.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    await copyFile(
      testInfo.outputPath(`${name}.png`),
      `${directory}/${name}.png`,
    );
  };
  await seedStationAccess(page);
  // DOM-only SSE boundary: the production-built UI receives a routed frame,
  // then performs its ordinary authorized GET. Server/Hono authority and
  // producer qualification are covered by the dedicated backend suites.
  let publishSse: ((frame: string) => void) | undefined;
  await page.route('**/events', async (route) => {
    // The app has a second orchestration stream at /api/orchestration/events.
    // Only the global /events subscription dispatches assessment updates.
    if (new URL(route.request().url()).pathname !== '/events')
      return route.fulfill({
        headers: { 'content-type': 'text/event-stream' },
        body: 'data: {"event":"connected"}\n\n',
      });
    const frame = await new Promise<string>((resolve) => {
      publishSse = resolve;
    });
    await route.fulfill({
      headers: { 'content-type': 'text/event-stream' },
      body: frame,
    });
  });
  let resultKept = false;
  let resultWrites = 0;
  let resultReads = 0;
  let resultUnavailable = false;
  let noAvailableAnswers = false;
  let flowReevaluated = false;
  // The routed fixture deliberately switches from a legacy unassessed
  // projection to Surface's richer observed-empty-capable projection. Keep
  // the mutable wire value at the public projection boundary rather than
  // narrowing it to the initial fixture's one answer shape.
  const parsedInitialBasis = parseBasisProjection(basisProjection);
  if (!parsedInitialBasis.ok)
    throw new Error(
      'Initial Basis fixture must satisfy the public projection contract.',
    );
  let currentBasisProjection: BasisProjection = parsedInitialBasis.value;
  let basisPermissionLost = false;
  const keptResult = (associatedAnswerReferenceIds: string[]) => ({
    referenceId: 'kept-result-link-ui',
    ref: executionRef,
    kept: true,
    associatedAnswerReferenceIds,
  });
  await page.route(
    `**/api/orchestration/sessions/${executionRef.threadId}/tool-results/${executionRef.resultId}`,
    (route) => {
      resultReads += 1;
      return route.fulfill({
        ...json(
          resultUnavailable
            ? { success: false, error: 'PRIVATE_ERROR_CANARY' }
            : {
                success: true,
                data: {
                  sessionId: executionRef.threadId,
                  eventId: executionRef.resultId,
                  result: safeExecutionResult,
                },
              },
        ),
        status: resultUnavailable ? 503 : 200,
      });
    },
  );
  await page.route(`**/api/tasks/${taskId}/tool-result-references`, (route) =>
    route.fulfill(
      json({
        success: true,
        data: resultKept
          ? [
              {
                id: 'kept-result-link-ui',
                state: 'available',
                ref: executionRef,
                result: safeExecutionResult,
              },
            ]
          : [],
      }),
    ),
  );
  await page.route(`**/api/tasks/${taskId}/references`, (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({
      kind: 'tool-result',
      sessionId: executionRef.threadId,
      eventId: executionRef.resultId,
      sourceSurface: 'nativeBasis',
    });
    resultWrites += 1;
    resultKept = true;
    return route.fulfill({
      ...json({
        success: true,
        data: {
          id: 'kept-result-link-ui',
          sourceType: 'task',
          sourceId: taskId,
          targetType: 'tool_result',
          targetId: encodeTaskToolResultReference(
            executionRef.threadId,
            executionRef.resultId,
          ),
          relationType: 'references_tool_result',
          confidence: 1,
          source: 'user',
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      }),
      status: 201,
    });
  });
  await page.route(`**/api/tasks/${taskId}/graph`, (route) =>
    route.fulfill(
      json({
        success: true,
        data: {
          task: {
            id: taskId,
            projectId: 'project-ui',
            title: 'Answer support UI',
            description: '',
            priority: 'normal',
            status: 'in_progress',
            createdBy: 'user',
            createdAt: '2026-08-24T00:00:00.000Z',
            updatedAt: '2026-08-24T00:00:00.000Z',
            workspaceBinding: { availability: 'unavailable' },
          },
          links: [],
        },
      }),
    ),
  );
  await page.route(`**/api/tasks/${taskId}/turn-references`, (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: referenceId,
            state: 'available',
            sessionId: 'session-ui',
            turnId: 'turn-ui',
            answer: {
              role: 'assistant',
              content: 'Exact answer with explicit support.',
              turnId: 'turn-ui',
            },
            support: {
              state: 'available',
              associationId: 'association-ui',
              revision: 3,
              card: {
                found: true,
                claim: {
                  id: 'claim-ui',
                  subject: {
                    subjectType: 'artifact',
                    subjectId: 'artifact-ui',
                  },
                  claimType: 'quality.test',
                  fieldOrBehavior: 'result',
                  value: JSON.parse(longValue),
                  status: 'verified',
                  freshness: null,
                  materiality: 'high',
                },
                evidence: {
                  entailing: [
                    {
                      id: 'evidence-entails-ui',
                      type: 'test_output',
                      method: 'validation',
                      sourceRef: 'source-ui',
                      locator: 'line:1',
                      summary: 'A long evidence summary '.repeat(30),
                      observedAt: '2026-08-24T00:00:00.000Z',
                      supportStrength: null,
                      result: 'failed',
                      blocksClaim: true,
                    },
                  ],
                  cited: [],
                },
                derivation: { available: false, directInputs: [] },
                transparencyGaps: [
                  {
                    id: 'gap-ui',
                    claimId: 'claim-ui',
                    type: 'provenance_gap',
                    severity: 'high',
                    message: 'A long transparency gap '.repeat(30),
                    createdAt: '2026-08-24T00:00:00.000Z',
                  },
                ],
              },
            },
          },
        ],
      }),
    ),
  );
  await page.route(
    `**/api/tasks/${taskId}/turn-references/${referenceId}/support/bundles`,
    (route) =>
      route.fulfill(json({ success: true, data: [{ id: 'opaque-A' }] })),
  );
  await page.route(
    `**/api/tasks/${taskId}/turn-references/${referenceId}/support/bundles/opaque-A/claims`,
    (route) =>
      route.fulfill(
        json({
          success: true,
          data: [{ id: 'opaque-claim-A' }, { id: 'opaque-claim-a' }],
        }),
      ),
  );
  let roomAvailable = true;
  await page.route(`**/api/tasks/${taskId}/room**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/document'))
      return route.fulfill(
        json({
          success: true,
          data: {
            kind: 'snapshot',
            revision: `swsr-v1:${'a'.repeat(64)}`,
            text: 'Basis host document',
          },
        }),
      );
    if (path.endsWith('/history'))
      return route.fulfill(
        json({
          success: true,
          data: { kind: 'available', entries: [], hasMore: false },
        }),
      );
    return route.fulfill(
      json({
        success: true,
        data: roomAvailable
          ? {
              kind: 'existing',
              scope: { projectId: 'project-ui', taskId },
              channelId: 'basis-room-ui',
              assurance: 'L0',
              capabilities: {
                documentRead: true,
                documentWrite: true,
                historyRead: true,
                messageWrite: true,
                revisionLinks: true,
                live: false,
              },
            }
          : { kind: 'unavailable' },
      }),
    );
  });
  await page.route(`**/api/tasks/${taskId}/basis**`, (route) => {
    if (basisPermissionLost)
      return route.fulfill({
        status: 403,
        ...json({ success: false, error: 'private-assessment-canary' }),
      });
    const selected = new URL(route.request().url()).searchParams.has(
      'answerReferenceId',
    );
    return route.fulfill(
      json({
        success: true,
        data: selected
          ? currentBasisProjection
          : {
              version: 'station.task-basis-collection/v4',
              taskId,
              answers: Array.from(
                { length: noAvailableAnswers ? 0 : 25 },
                (_, index) => ({
                  answerReferenceId:
                    index === 0 ? referenceId : `kept-answer-${index}`,
                  projection: currentBasisProjection,
                }),
              ),
              unassociated: [
                {
                  kind: 'task-output',
                  taskId,
                  outputId: 'unassociated-output-ui',
                  kept: true,
                },
              ],
              keptToolResults: resultKept
                ? [
                    keptResult(
                      noAvailableAnswers
                        ? []
                        : Array.from({ length: 25 }, (_, index) =>
                            index === 0 ? referenceId : `kept-answer-${index}`,
                          ),
                    ),
                  ]
                : [],
              keptGateEvaluations: resultKept
                ? [
                    {
                      referenceId: 'kept-flow-evaluation-ui',
                      kept: true,
                      evaluation: {
                        ref: {
                          runId: 'flow-run-ui',
                          gateId: 'verification',
                          evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                        },
                        evaluatedAt: '2026-08-26T00:00:00.000Z',
                        originalVerdict: 'pass',
                        kind: 'initial',
                        trigger: 'ordinary',
                        currentStanding: flowReevaluated
                          ? 'superseded'
                          : 'current',
                        currentRun: {
                          status: 'active',
                          currentStep: 'verification',
                        },
                        ...(flowReevaluated
                          ? {
                              currentPersistedGateRef: {
                                runId: 'flow-run-ui',
                                gateId: 'verification',
                                evaluationId:
                                  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                              },
                            }
                          : {}),
                        validityAsOf: '2026-08-26T00:00:00.000Z',
                        validityScope: 'retained-immutable-bundle',
                        externalRevocation: 'not-observed',
                        selectedEvidence: [],
                      },
                    },
                  ]
                : [],
              gaps: [{ state: 'restricted' }],
            },
      }),
    );
  });
  const portableResource = buildStationTaskBasisMcpAppResource();
  await page.route(
    '**/integrations/station-control/ui/get_task_basis',
    (route) =>
      route.fulfill(
        json({
          success: true,
          data: {
            status: 'success',
            serverId: 'station-control',
            toolName: 'get_task_basis',
            ref: 'station-control/get_task_basis',
            resourceUri: portableResource.uri,
          },
        }),
      ),
  );
  await page.route(
    '**/integrations/station-control/ui/get_task_basis/resource',
    (route) => route.fulfill(json({ success: true, data: portableResource })),
  );
  const portableCollection = {
    version: 'station.task-basis-collection/v4',
    taskId,
    answers: Array.from({ length: 9 }, (_, index) => ({
      answerReferenceId: `portable-answer-${index}`,
      projection: currentBasisProjection,
    })),
    unassociated: [
      { kind: 'task-output', taskId, outputId: 'portable-output', kept: true },
    ],
    keptToolResults: [],
    keptGateEvaluations: [
      {
        referenceId: 'portable-flow-evaluation',
        kept: true,
        evaluation: {
          ref: {
            runId: 'portable-flow-run',
            gateId: 'verification',
            evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
          evaluatedAt: '2026-08-26T00:00:00.000Z',
          originalVerdict: 'pass',
          kind: 'recheck',
          trigger: 'freshness',
          currentStanding: 'superseded',
          currentRun: { status: 'active', currentStep: 'verification' },
          validityAsOf: '2026-08-26T00:00:00.000Z',
          validityScope: 'retained-immutable-bundle',
          externalRevocation: 'not-observed',
          selectedEvidence: [
            {
              evidenceId: 'portable-selected-evidence',
              standing: 'superseded',
              freshness: 'stale',
              revocationCodes: [],
              authority: 'active',
            },
          ],
        },
      },
    ],
    gaps: [{ state: 'restricted', scope: 'process' }],
  };
  const portableOccurrence = 'fixture_occurrence_'.padEnd(32, 'o');
  const portableToken = 'fixture_continuation_'.padEnd(32, 't');
  let portableReads = 0;
  let portableDisposals = 0;
  await page.route(`**/api/tasks/${taskId}/basis/app-read`, (route) => {
    const body = route.request().postDataJSON();
    if (route.request().method() === 'DELETE') {
      expect(body).toEqual({ occurrenceId: portableOccurrence });
      portableDisposals += 1;
      return route.fulfill(json({ success: true }));
    }
    const continuation = portableReads > 0;
    expect(body).toEqual(
      continuation
        ? { occurrenceId: portableOccurrence, continuationToken: portableToken }
        : {},
    );
    portableReads += 1;
    const result = buildStationTaskBasisMcpPage(
      portableCollection,
      continuation ? { answerOffset: 8, unassociatedOffset: 0 } : {},
    );
    expect(result?.status).toBe('available');
    return route.fulfill(
      json({
        success: true,
        data: result,
        meta: {
          'station.task-basis-app/v1': {
            occurrenceId: portableOccurrence,
            ...(!continuation ? { continuationToken: portableToken } : {}),
          },
        },
      }),
    );
  });

  await page.goto(`/tasks/${taskId}`);
  await expect(
    page
      .getByRole('button', { name: /^Manage Stations/ })
      .getByLabel('connected'),
  ).toBeVisible();
  const answerReference = page.locator('.task-workspace__answer-reference');
  await expect(answerReference).toHaveCount(1);
  await expect(
    contrastRatio(answerReference.locator('span').last()),
  ).resolves.toBeGreaterThanOrEqual(4.5);
  await answerReference.hover();
  await expect(
    contrastRatio(answerReference.locator('span').last()),
  ).resolves.toBeGreaterThanOrEqual(4.5);
  await expect(page.getByText('What this answer stands on')).toBeVisible();
  await expect(
    page.getByText('Not declared (legacy/default bucket placement)'),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const card = page.locator('.task-workspace__surface-answer-card');
  await expect(card).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await card.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expectNoBlockingAccessibilityViolations(page, 'task-answer-support');

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    page.getByRole('region', { name: 'Task room workspace' }),
  ).toBeVisible();
  const openBasis = page.getByRole('button', { name: 'Open Basis' });
  await openBasis.click();
  const nativeBasis = page.locator('.station-basis-pane');
  await expect(nativeBasis).toBeVisible();
  await expect(nativeBasis.getByRole('status')).toContainText('Unassessed');
  await expect(nativeBasis).toContainText('<img src=x onerror=alert(1)>');
  await expect(nativeBasis.locator('img')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Basis' })).toHaveCount(0);
  currentBasisProjection = surface3Projection({
    policy: 'satisfied',
    evidence: 'entails',
  });
  const firstSsePublisher = publishSse;
  if (!firstSsePublisher)
    throw new Error('The routed server-event stream did not subscribe.');
  firstSsePublisher(
    'event: answer.assessment.updated\n' +
      'data: {"sessionId":"session-ui","turnId":"turn-ui","revision":4,"active":true}\n\n',
  );
  await expect(nativeBasis.getByRole('status')).toContainText('Policy met');
  await expect(nativeBasis).toContainText('Explicitly entailing evidence');
  await nativeBasis
    .locator('summary')
    .filter({ hasText: /^Context/ })
    .click();
  const inspectResult = nativeBasis.getByRole('button', {
    name: 'Inspect tool result',
    exact: true,
  });
  await inspectResult.focus();
  await inspectResult.press('Enter');
  const resultDialog = page.getByRole('dialog', {
    name: 'Tool result',
    exact: true,
  });
  await expect(resultDialog).toBeVisible();
  await expect(resultDialog.locator('pre')).toHaveText(executionText);
  await expect(resultDialog.locator('img, a')).toHaveCount(0);
  expect(resultWrites).toBe(0);
  expect(resultReads).toBe(1);
  await page.keyboard.press('Escape');
  await expect(inspectResult).toBeFocused();
  const keepResult = nativeBasis.getByRole('button', {
    name: 'Keep in Task',
    exact: true,
  });
  await expect(keepResult).toBeEnabled();
  await keepResult.click();
  await expect(
    nativeBasis.getByRole('button', { name: 'Kept', exact: true }),
  ).toBeVisible();
  expect(resultWrites).toBe(1);
  // A batched refetch can retain the focused Kept control; a remount restores
  // Inspect. Both preserve the user's exact result context, unlike body/tab focus.
  await expect
    .poll(() =>
      page.evaluate(() => ({
        inside: Boolean(
          document.activeElement?.closest(
            '.station-basis-pane__execution-actions',
          ),
        ),
        focused:
          document.activeElement?.getAttribute('aria-label') ??
          document.activeElement?.textContent?.slice(0, 80),
      })),
    )
    .toMatchObject({ inside: true });
  await expect(nativeBasis.getByRole('status')).toContainText('Policy met');

  // Reopen creates a new protected Whole Task query. Flow's re-evaluation is
  // owner-projected as the retained receipt's current standing: Station does
  // not substitute the later receipt for the exact kept identity.
  flowReevaluated = true;
  await page.getByRole('button', { name: 'Open Whole Task Basis' }).click();
  const wholeTaskBasis = page.locator('.station-basis-pane').filter({
    hasText: 'Whole Task has no aggregate standing.',
  });
  await expect(wholeTaskBasis).toBeVisible();
  await expect(wholeTaskBasis).toContainText(
    'Some kept answer context is restricted.',
  );
  await expect(wholeTaskBasis).toContainText('unassociated-output-ui');
  const nativeProcess = wholeTaskBasis.getByRole('region', {
    name: 'Process kept gate evaluations',
  });
  await expect(nativeProcess).toContainText(
    'Gate verification — original verdict pass. At last check: superseded;',
  );
  await captureReviewScreenshot('native-process-compact', nativeProcess);
  await nativeProcess
    .getByText('Process receipt details', { exact: true })
    .click();
  await expect(nativeProcess).toContainText(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await expect(nativeProcess).toContainText(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  await captureReviewScreenshot('native-process-expanded', nativeProcess);
  await expect(
    wholeTaskBasis.getByRole('button', { name: /^kept-answer-24 / }),
  ).toHaveCount(0);
  const showMoreAnswers = wholeTaskBasis.getByRole('button', {
    name: /^(Show more kept answers|All kept answers shown)$/,
  });
  await showMoreAnswers.focus();
  await showMoreAnswers.click();
  await expect(showMoreAnswers).toBeFocused();
  const finalAnswer = wholeTaskBasis.getByRole('button', {
    name: /^kept-answer-24 /,
  });
  await finalAnswer.click();
  await expect(finalAnswer).toHaveAttribute('aria-pressed', 'true');
  await expect(wholeTaskBasis.getByRole('status')).toContainText('Policy met');
  await expectNoBlockingAccessibilityViolations(page, 'whole-task-basis');
  const wholeTaskPanel = page
    .getByRole('tabpanel', { name: 'Basis', exact: true })
    .filter({ has: wholeTaskBasis });
  await wholeTaskPanel
    .getByRole('button', { name: 'Open portable MCP App' })
    .click();
  const portableApp = page
    .frameLocator('iframe[title="MCP tool UI: station-control/get_task_basis"]')
    .frameLocator('iframe');
  await expect(
    portableApp.getByRole('heading', { name: 'Whole Task Basis', exact: true }),
  ).toBeVisible();
  await expect(
    portableApp.getByText('Some kept Process context is restricted.', {
      exact: true,
    }),
  ).toBeVisible();
  await portableApp
    .getByRole('button', { name: 'Next page', exact: true })
    .click();
  await expect(
    portableApp.getByRole('button', { name: /^portable-answer-8/ }),
  ).toBeVisible();
  await expect(
    portableApp.getByText('Task output portable-output', { exact: true }),
  ).toBeVisible();
  const portableProcess = portableApp.getByRole('region', {
    name: 'Process kept gate evaluations',
  });
  await expect(portableProcess).toContainText(
    'Gate verification — original verdict pass. At last check: superseded;',
  );
  await portableProcess
    .getByText('Process receipt details', { exact: true })
    .click();
  await expect(portableProcess).toContainText('portable-selected-evidence');
  await captureReviewScreenshot(
    'portable-mcp-process-expanded',
    portableProcess,
  );
  expect(portableReads).toBe(2);
  await page
    .getByRole('button', { name: 'Close Basis App', exact: true })
    .click();
  await expect.poll(() => portableDisposals).toBe(1);
  await page.getByRole('tab', { name: 'Basis', exact: true }).last().click();
  // Chromium's actual accessibility tree, not DOM containment: aria-owns
  // keeps visually adjacent close actions outside tablist ownership.
  const accessibilitySession = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await accessibilitySession.send(
      'Accessibility.getFullAXTree',
    )) as {
      nodes: {
        nodeId: string;
        role?: { value?: string };
        name?: { value?: string };
        childIds?: string[];
        ignored: boolean;
      }[];
    };
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const tablists = nodes.filter(
      (node) =>
        !node.ignored &&
        node.role?.value === 'tablist' &&
        node.name?.value === 'Workspace panes',
    );
    expect(tablists.length).toBeGreaterThanOrEqual(2);
    for (const tablist of tablists) {
      const children = (tablist.childIds ?? []).map((id) => byId.get(id));
      expect(children.length).toBeGreaterThan(0);
      expect(children.every((node) => node?.role?.value === 'tab')).toBe(true);
    }
    expect(
      nodes.some(
        (node) =>
          !node.ignored &&
          node.role?.value === 'button' &&
          node.name?.value === 'Close Basis',
      ),
    ).toBe(true);
  } finally {
    await accessibilitySession.detach();
  }
  const basisGroup = page
    .getByRole('region', { name: 'Task room workspace' })
    .getByRole('region', { name: 'Workspace pane group' })
    .first();
  const groupTabs = basisGroup.getByRole('tab');
  await groupTabs.last().focus();
  await page.keyboard.press('Home');
  await expect(groupTabs.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(groupTabs.last()).toBeFocused();
  await page.keyboard.press('Tab');
  const closeWholeTask = basisGroup
    .getByRole('button', { name: 'Close Basis' })
    .last();
  await expect(closeWholeTask).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(wholeTaskBasis).toHaveCount(0);
  await expect(basisGroup.getByRole('tab', { selected: true })).toBeFocused();

  roomAvailable = false;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const mobileBasisTrigger = page.getByRole('button', { name: 'Open Basis' });
  await mobileBasisTrigger.focus();
  await mobileBasisTrigger.click();
  const basisDialog = page.getByRole('dialog', { name: 'Basis' });
  await expect(basisDialog).toBeVisible();
  await expect(basisDialog.getByRole('status')).toContainText('Policy met');
  await basisDialog
    .locator('summary')
    .filter({ hasText: /^Context/ })
    .click();
  await expect(
    basisDialog.getByRole('button', { name: 'Kept', exact: true }),
  ).toBeVisible();
  expect(resultWrites).toBe(1);
  const mobileInspect = basisDialog.getByRole('button', {
    name: 'Inspect tool result',
    exact: true,
  });
  expect((await mobileInspect.boundingBox())?.height).toBeGreaterThanOrEqual(
    44,
  );
  await mobileInspect.click();
  await expect(resultDialog.locator('pre')).toHaveText(executionText);
  expect(
    await resultDialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await expectNoBlockingAccessibilityViolations(page, 'tool-result-mobile');
  await page.keyboard.press('Escape');
  await expect(mobileInspect).toBeFocused();
  resultUnavailable = true;
  await mobileInspect.click();
  await expect(resultDialog.getByRole('alert')).toContainText(
    'Tool result is unavailable',
  );
  await expect(resultDialog.locator('pre')).toHaveCount(0);
  await expect(resultDialog).not.toContainText('PRIVATE_ERROR_CANARY');
  await page.keyboard.press('Escape');
  resultUnavailable = false;
  expect(
    await basisDialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  const basisClose = basisDialog.getByRole('button', { name: 'Close Basis' });
  expect((await basisClose.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expectNoBlockingAccessibilityViolations(page, 'task-basis-mobile');
  await page.keyboard.press('Escape');
  await expect(mobileBasisTrigger).toBeFocused();

  const mobileWholeTaskTrigger = page.getByRole('button', {
    name: 'Open Whole Task Basis',
  });
  noAvailableAnswers = true;
  await mobileWholeTaskTrigger.focus();
  await mobileWholeTaskTrigger.click();
  await expect(basisDialog).toContainText(
    'Whole Task has no aggregate standing.',
  );
  await expect(basisDialog).toContainText(
    'Some kept answer context is restricted.',
  );
  await expect(basisDialog).toContainText('unassociated-output-ui');
  await expect(basisDialog).toContainText(
    'Kept in Task, not associated with an available answer',
  );
  await expect(basisDialog).toContainText(executionRef.resultId);
  await expect(
    basisDialog.getByRole('button', {
      name: 'Inspect tool result',
      exact: true,
    }),
  ).toBeVisible();
  const mobileProcess = basisDialog.getByRole('region', {
    name: 'Process kept gate evaluations',
  });
  await mobileProcess
    .getByText('Process receipt details', { exact: true })
    .click();
  await expect(mobileProcess).toContainText('External revocation');
  await mobileProcess.scrollIntoViewIfNeeded();
  expect(
    await mobileProcess.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth;
    }),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const mobileReceiptSummary = mobileProcess.getByText(
    'Process receipt details',
    { exact: true },
  );
  const mobileReceiptBox = await mobileReceiptSummary.boundingBox();
  expect(mobileReceiptBox?.height).toBeGreaterThanOrEqual(44);
  expect(
    mobileReceiptBox !== null &&
      mobileReceiptBox.x >= 0 &&
      mobileReceiptBox.x + mobileReceiptBox.width <= 390 &&
      mobileReceiptBox.y >= 0 &&
      mobileReceiptBox.y + mobileReceiptBox.height <= 844,
  ).toBe(true);
  await captureReviewScreenshot('native-process-mobile', page);
  expect(
    await basisDialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expectNoBlockingAccessibilityViolations(
    page,
    'whole-task-basis-mobile',
  );
  await page.keyboard.press('Escape');
  await expect(mobileWholeTaskTrigger).toBeFocused();

  const replace = page.getByRole('button', { name: 'Replace' });
  await replace.focus();
  await replace.click();
  const dialog = page.getByRole('dialog', { name: 'Replace answer support' });
  await expect(
    dialog.getByText('Session session-ui · turn turn-ui'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'opaque-A' }).click();
  await expect(
    dialog.getByRole('button', { name: 'opaque-claim-A', exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'opaque-claim-a', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(replace).toBeFocused();

  // A terminal route response makes fetchSSE reconnect.  Publish the next
  // authorized hint only after that real client reconnection, then make the
  // authoritative GET deny access: old policy content must disappear before
  // the error surface renders.
  const reopenAfterPermissionLoss = page.getByRole('button', {
    name: 'Open Basis',
  });
  await reopenAfterPermissionLoss.click();
  await expect(basisDialog).toBeVisible();
  await expect.poll(() => publishSse === firstSsePublisher).toBe(false);
  basisPermissionLost = true;
  if (!publishSse)
    throw new Error('The routed server-event stream did not reconnect.');
  publishSse(
    'event: answer.assessment.updated\n' +
      'data: {"sessionId":"session-ui","turnId":"turn-ui","revision":5,"active":false}\n\n',
  );
  await expect(
    basisDialog.getByRole('button', { name: 'Retry' }),
  ).toBeVisible();
  await expect(basisDialog).toContainText('Basis is unavailable.');
  await expect(basisDialog).not.toContainText('Policy met');
  await expect(basisDialog).not.toContainText('private-assessment-canary');
});

test('renders pinned input context without leaking a revoked projection', async ({
  page,
}) => {
  await seedStationAccess(page);
  await page.route('**/api/tasks/*/graph', (route) =>
    route.fulfill(
      json({
        success: true,
        data: {
          task: {
            id: new URL(route.request().url()).pathname.split('/').at(-2),
            projectId: 'project-ui',
            title: 'Pinned input UI',
            description: '',
            priority: 'normal',
            status: 'in_progress',
            createdBy: 'user',
            createdAt: '2026-08-24T00:00:00.000Z',
            updatedAt: '2026-08-24T00:00:00.000Z',
            workspaceBinding: { availability: 'unavailable' },
          },
          links: [],
        },
      }),
    ),
  );
  await page.route('**/turn-references', (route) =>
    route.fulfill(json({ success: true, data: [] })),
  );
  await page.route('**/user-input-references', (route) => {
    const task = new URL(route.request().url()).pathname.split('/').at(-2);
    if (task === 'pinned-input-revoked') {
      return route.fulfill({
        status: 503,
        ...json({ success: false, error: 'session-secret/event-secret' }),
      });
    }
    return route.fulfill(
      json({
        success: true,
        data: [
          {
            id: 'input-link-ui',
            state: 'available',
            sessionId: 'session-ui',
            turnId: 'turn-ui',
            eventId: 'event-ui',
            input: {
              prompt: '',
              attachments: [
                { name: 'brief.png', mediaType: 'image/png', size: 1024 },
              ],
            },
          },
        ],
      }),
    );
  });

  await page.goto('/tasks/pinned-input-ui');
  const inputs = page.getByRole('region', { name: 'Pinned inputs' });
  await expect(inputs).toContainText(
    'Explicitly pinned input from this Task’s work context. It was not inferred to support any answer.',
  );
  await expect(inputs).toContainText('brief.png · image/png · 1,024 bytes');
  await expect(inputs.getByText('Authored prompt')).toHaveCount(0);
  await expect(
    contrastRatio(page.locator('.detail-header__badge--muted')),
  ).resolves.toBeGreaterThanOrEqual(4.5);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expectNoBlockingAccessibilityViolations(page, 'task-user-input-pin');

  await page.goto('/tasks/pinned-input-revoked');
  const revoked = page.getByRole('region', { name: 'Pinned inputs' });
  await expect(revoked).toContainText('Pinned inputs are unavailable');
  await expect(revoked.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(revoked).not.toContainText('session-secret');
  await expect(revoked).not.toContainText('event-secret');
});
