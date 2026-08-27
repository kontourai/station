import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL('../station-agent-smoke.mjs', import.meta.url),
);

describe('station-agent-smoke', () => {
  it('refuses before reading credentials or making a request without confirmation', async () => {
    await expect(
      execFileAsync(process.execPath, [SCRIPT], {
        env: { ...process.env, STATION_CREDENTIAL: '' },
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('--confirm-billable-one-turn'),
    });
  });

  it('runs exactly one confirmed smoke for an explicitly selected connection', async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      authorization?: string;
      body: string;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.setHeader('content-type', 'application/json');
        if (request.url === '/api/connections/agents') {
          response.end(JSON.stringify({ success: true, data: [] }));
          return;
        }
        response.end(
          JSON.stringify({
            success: true,
            data: {
              level: 'smoke-passed',
              smoke: {
                status: 'passed',
                testedAt: '2026-07-13T12:00:00.000Z',
              },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No test port');
      const credential = 'test-credential-never-print';
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          SCRIPT,
          '--confirm-billable-one-turn',
          `--origin=http://127.0.0.1:${address.port}`,
          '--connection=codex-runtime',
          '--timeout-ms=5000',
        ],
        { env: { ...process.env, STATION_CREDENTIAL: credential } },
      );

      expect(stderr).not.toContain(credential);
      expect(stdout).not.toContain(credential);
      expect(JSON.parse(stdout)).toMatchObject({
        turnLimitPerConnection: 1,
        receipts: [
          {
            connectionId: 'codex-runtime',
            success: true,
            level: 'smoke-passed',
            smokeStatus: 'passed',
          },
        ],
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        method: 'GET',
        url: '/api/connections/agents',
        authorization: `Bearer ${credential}`,
      });
      expect(requests[1]).toMatchObject({
        method: 'POST',
        url: '/api/connections/codex-runtime/smoke',
        authorization: `Bearer ${credential}`,
      });
      expect(JSON.parse(requests[1].body)).toEqual({
        confirmed: true,
        timeoutMs: 5000,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
