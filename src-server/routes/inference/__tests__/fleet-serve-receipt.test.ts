/**
 * archive#1398, §3.4 "Both sides record" — the SERVING Station's own
 * account of what it served.
 *
 * A consumer-authored record of a producer's behavior is a claim, not
 * evidence, which is why this exists at all. The two properties that make it
 * safe to keep on the serving operator's disk are asserted here: it records
 * digests rather than content, and it identifies the peer by a fingerprint
 * rather than by the credential it presented.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { FleetInferenceService } from '../../../services/inference/fleet-inference-service.js';
import {
  FleetServeReceiptLog,
  fleetServeReceiptPath,
  peerFingerprint,
  promptDigest,
  readFleetServeReceipts,
} from '../../../services/inference/fleet-serve-receipt-log.js';
import { createFleetInferenceRoutes } from '../fleet-inference.js';

const CREDENTIAL = 'peer-credential-value-0000000000';
const PROMPT = 'the operator’s private question';

function service(overrides: Partial<FleetInferenceService> = {}) {
  return {
    readManifest: vi.fn(),
    complete: vi.fn().mockResolvedValue({
      kind: 'completed',
      response: {
        schemaVersion: 'station.fleet-inference-completion/v1',
        delivery: 'buffered',
        model: {
          id: 'ollama:llama3.3',
          connectionId: 'ollama',
          providerModel: 'llama3.3:70b',
          displayName: 'Llama 3.3 70B',
        },
        servedAt: '2026-08-01T10:00:02.000Z',
        content: 'a generated answer',
        stop: 'provider',
        finishReason: 'stop',
        usage: { inputTokens: 11, outputTokens: 2 },
        elapsedMs: 42,
      },
    }),
    ...overrides,
  } as unknown as FleetInferenceService;
}

async function serveOnce(
  overrides: Partial<FleetInferenceService> = {},
): Promise<{ home: string; raw: string }> {
  const home = await mkdtemp(join(tmpdir(), 'station-serve-receipts-'));
  const app = createFleetInferenceRoutes(
    service(overrides),
    new FleetServeReceiptLog(home),
  );
  await app.request('/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${CREDENTIAL}`,
    },
    body: JSON.stringify({
      model: 'ollama:llama3.3',
      messages: [{ role: 'user', content: PROMPT }],
    }),
  });
  return { home, raw: await readFile(fleetServeReceiptPath(home), 'utf8') };
}

describe('the serving Station records what it served', () => {
  test('records the model, the outcome, and a peer FINGERPRINT — never the credential', async () => {
    const { raw } = await serveOnce();
    const receipt = JSON.parse(raw.trim());
    expect(receipt.schemaVersion).toBe('station.fleet-serve-receipt/v1');
    expect(receipt.outcome).toBe('served');
    expect(receipt.requestedModelId).toBe('ollama:llama3.3');
    expect(receipt.completionCharacters).toBe('a generated answer'.length);
    expect(receipt.peerFingerprint).toBe(
      peerFingerprint(`Bearer ${CREDENTIAL}`),
    );
    // The whole point of a fingerprint: a log that stored the token would
    // turn a routing record into a credential store.
    expect(raw).not.toContain(CREDENTIAL);
  });

  test('records a prompt DIGEST and no prompt or completion text', async () => {
    const { raw } = await serveOnce();
    const receipt = JSON.parse(raw.trim());
    expect(receipt.promptDigest).toBe(
      promptDigest([{ role: 'user', content: PROMPT }]),
    );
    expect(raw).not.toContain(PROMPT);
    expect(raw).not.toContain('a generated answer');
  });

  test('records a refusal by code rather than leaving it unlogged', async () => {
    const { raw } = await serveOnce({
      complete: vi.fn().mockResolvedValue({
        kind: 'refused',
        refusal: {
          schemaVersion: 'station.fleet-inference-refusal/v1',
          code: 'model-not-contributed',
          message: 'That model is not contributed by this Station.',
          refusedAt: '2026-08-01T10:00:02.000Z',
        },
      }) as never,
    });
    const receipt = JSON.parse(raw.trim());
    expect(receipt.outcome).toBe('refused');
    expect(receipt.refusalCode).toBe('model-not-contributed');
    expect(receipt.completionCharacters).toBeNull();
  });

  test('never signs anything, and says so by leaving the field null', async () => {
    const { raw } = await serveOnce();
    expect(JSON.parse(raw.trim()).signature).toBeNull();
  });

  test('a completion still succeeds when no receipt sink is wired', async () => {
    // Optional so the route is constructible in a test with no filesystem;
    // proven here so a missing sink degrades to "no record", never to a 500
    // that costs the peer a retry and this machine a second generation.
    const response = await createFleetInferenceRoutes(service()).request(
      '/completions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'ollama:llama3.3',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );
    expect(response.status).toBe(200);
  });
});

describe('the serve log is READABLE, with the same verdict as the routing log', () => {
  // Security review, M-2: "a receipt nobody can read is a log, not a receipt"
  // is a rule about receipts, not about consumer-side receipts. Before this,
  // the serve log was write-only — the exact "no artifact" posture the design
  // says it is differentiating against, one directory over.
  test('reads back what was served, newest first, with an intact chain', async () => {
    const { home } = await serveOnce();
    const page = await readFleetServeReceipts(home);
    expect(page.receipts).toHaveLength(1);
    expect(page.receipts[0]?.outcome).toBe('served');
    expect(page.chain.status).toBe('intact');
    expect(page.chain.message).toContain('not signed');
  });

  test('THE TRUNCATION CASE: dropping the newest records is not intact', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-serve-receipts-'));
    const log = new FleetServeReceiptLog(home);
    const base = {
      recordedAt: '2026-08-01T10:00:00.000Z',
      peerFingerprint: null,
      requestedModelId: 'ollama:llama3.3',
      promptDigest: 'a'.repeat(64),
      outcome: 'served' as const,
      refusalCode: null,
      completionCharacters: 3,
      elapsedMs: 1,
    };
    await log.append(base);
    await log.append(base);
    const path = fleetServeReceiptPath(home);
    const lines = (await readFile(path, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    await writeFile(path, `${lines[0]}\n`, 'utf8');

    const page = await readFleetServeReceipts(home);
    expect(page.chain.status).toBe('broken');
    expect(page.chain.message).toContain('truncated');
  });

  test('a removed head anchor reads unknown, never intact', async () => {
    const { home } = await serveOnce();
    await rm(`${fleetServeReceiptPath(home)}.anchor.json`);
    const page = await readFleetServeReceipts(home);
    expect(page.chain.status).toBe('unknown');
  });

  test('an empty log says so instead of implying a read failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-serve-receipts-'));
    const page = await readFleetServeReceipts(home);
    expect(page.receipts).toHaveLength(0);
    expect(page.chain.message).toContain('has not served any fleet inference');
  });
});
