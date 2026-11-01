import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { CreateRequestClaims } from '../create-request-claims.js';

const temp = trackTempDirs();
test.each(['reserved', 'starting', 'rejected'])(
  'SIGKILL after %s: only an unstarted create can be reclaimed',
  async (cut) => {
    const home = temp('create-owner-crash-');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve(
          'src-server/services/orchestration/__tests__/fixtures/create-request-child.ts',
        ),
        home,
        cut,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          STATION_HOME: home,
          STATION_INSTANCE: 'create-claim-crash-fixture',
        },
      },
    );
    const exit = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    try {
      await new Promise<void>((yes, no) => {
        const timeout = setTimeout(
          () => no(new Error(`Owner did not reach cut: ${stderr}`)),
          10_000,
        );
        child.stdout.on('data', (chunk) => {
          if (String(chunk).includes('READY')) {
            clearTimeout(timeout);
            yes();
          }
        });
        child.once('exit', () => {
          clearTimeout(timeout);
          no(new Error(`Owner exited before cut: ${stderr}`));
        });
        child.once('error', (error) => {
          clearTimeout(timeout);
          no(error);
        });
      });
      child.kill('SIGKILL');
      await exit;
      const effect = vi.fn(async (sessionId: string) => ({
        conversationId: sessionId,
        sessionId,
        providerTurnId: 'original-provider-turn',
        target: { kind: 'agent' as const, id: agentId('agent') },
        resolution: {
          schemaVersion: 'station.execution-resolution/v1' as const,
          resolvedAt: '2026-11-01T00:00:00Z',
          environmentId: environmentId('station'),
          agentId: agentId('agent'),
          engine: { kind: 'station' as const },
          provider: 'station-agent' as const,
          modelLaunchPlan: {
            kind: 'engine-selected' as const,
            evidence: 'adapter-declared' as const,
          },
        },
      }));
      if (cut !== 'starting')
        await expect(
          new CreateRequestClaims(home).run(
            {
              kind: 'foreground',
              principal: undefined,
              authority: sessionReadAuthorityFromRequest(
                'operator',
                undefined,
                undefined,
              ),
              requestKey: 'crash-key',
              intent: { message: 'original input' },
              sessionExists: () => true,
            },
            effect,
          ),
        ).rejects.toMatchObject({ outcome: 'indeterminate' });
      await expect(
        new CreateRequestClaims(home).run(
          {
            kind: 'foreground',
            principal: undefined,
            authority: sessionReadAuthorityFromRequest(
              'operator',
              undefined,
              undefined,
            ),
            requestKey: 'crash-key',
            intent: { message: 'changed input' },
            sessionExists: () => false,
          },
          effect,
        ),
      ).rejects.toMatchObject({ code: 'create_request_conflict' });
      expect(effect).not.toHaveBeenCalled();
      const retry = new CreateRequestClaims(home).run(
        {
          kind: 'foreground',
          principal: undefined,
          authority: sessionReadAuthorityFromRequest(
            'operator',
            undefined,
            undefined,
          ),
          requestKey: 'crash-key',
          intent: { message: 'original input' },
          sessionExists: () => false,
        },
        effect,
      );
      if (cut !== 'starting') {
        await expect(retry).resolves.toMatchObject({
          providerTurnId: 'original-provider-turn',
        });
        expect(effect).toHaveBeenCalledTimes(1);
      } else {
        await expect(retry).rejects.toMatchObject({
          code: 'create_request_indeterminate',
          message: expect.stringContaining('operator reconciliation'),
        });
        expect(effect).not.toHaveBeenCalled();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exit;
    }
  },
);
