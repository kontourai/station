import { describe, expect, test } from 'vitest';
import { evaluateProofFamily } from '../proof-family-lane.mjs';
import {
  collectRouteErrorEgressFindingsForSources,
  collectTransportErrorEgressFindingsForSources,
} from '../route-error-egress-gate.mjs';

describe('repo-governance route error egress proof', () => {
  test('makes the canonical governance family fail on a multiline raw error message', () => {
    const file = 'src-server/routes/fixture.ts';
    const source = `
      app.post('/fixture', (c) =>
        c.json({
          error: condition
            ? error.message
            : 'safe fallback',
        }),
      );
    `;
    const result = evaluateProofFamily(
      {
        id: 'repo-governance',
        evidenceCheckId: 'repo-governance',
        destination: 'required',
        owner: 'station',
        defaultDisposition: 'required',
        currentBlockingStatus: 'blocking',
        regressionSeverity: 'high',
        falsePositiveRisk: 'low',
        expiryOrReviewTrigger: 'never',
      },
      {
        routeErrorEgressCheck: () =>
          collectRouteErrorEgressFindingsForSources(
            { [file]: source },
            { reviewed: new Set() },
          ),
      },
    );

    expect(result.status).toBe('fail');
    expect(result.findings).toContainEqual({
      id: 'route-error-egress',
      message:
        'Unreviewed direct outward .message serialization: src-server/routes/fixture.ts :: route POST /fixture :: error.message :: 1.',
      severity: 'block',
    });
  });

  test('makes the canonical governance family fail on raw WebSocket error coercion', () => {
    const file = 'src-server/voice/fixture.ts';
    const source = `
      function write(ws) {
        ws.on('error', (failure) => {
          ws.send(JSON.stringify({ message: String(failure) }));
        });
      }
    `;
    const result = evaluateProofFamily(
      {
        id: 'repo-governance',
        evidenceCheckId: 'repo-governance',
        destination: 'required',
        owner: 'station',
        defaultDisposition: 'required',
        currentBlockingStatus: 'blocking',
        regressionSeverity: 'high',
        falsePositiveRisk: 'low',
        expiryOrReviewTrigger: 'never',
      },
      {
        routeErrorEgressCheck: () =>
          collectTransportErrorEgressFindingsForSources({ [file]: source }),
      },
    );

    expect(result.status).toBe('fail');
    expect(result.findings).toContainEqual({
      id: 'route-error-egress',
      message:
        'Raw outward or durable error coercion: src-server/voice/fixture.ts :: route ON error :: String(failure).',
      severity: 'block',
    });
  });
});
