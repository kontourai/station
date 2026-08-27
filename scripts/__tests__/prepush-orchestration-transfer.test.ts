import { describe, expect, test } from 'vitest';
import {
  changedTransferPathsSince,
  decideOrchestrationTransferScope,
  isOrchestrationTransferInput,
  runOrchestrationTransferGate,
} from '../check-prepush-orchestration-transfer.mjs';

describe('orchestration transfer pre-push scope', () => {
  test('requires the recorder and the full measured runtime closure', () => {
    for (const path of [
      'src-server/__test-utils__/http-transfer-recorder.ts',
      'src-server/providers/adapters/station-agent-adapter.ts',
      'src-server/routes/orchestration/orchestration.ts',
      'packages/sdk/src/client/http.ts',
    ])
      expect(isOrchestrationTransferInput(path)).toBe(true);
  });

  test('includes renamed and deleted input paths, and fails closed for unknown base', () => {
    const paths = changedTransferPathsSince('base', (() =>
      [
        'R100',
        'src-server/__test-utils__/http-transfer-recorder.ts',
        'docs/recorder-moved.md',
        'D',
        'scripts/orchestration-transfer-capture.ts',
      ].join('\0')) as any);
    expect(paths).toContain(
      'src-server/__test-utils__/http-transfer-recorder.ts',
    );
    expect(paths).toContain('scripts/orchestration-transfer-capture.ts');
    expect(
      decideOrchestrationTransferScope({
        baseSha: 'a'.repeat(40),
        changedPaths: paths,
      }).run,
    ).toBe(true);
    expect(
      decideOrchestrationTransferScope({ baseSha: '', changedPaths: [] }).run,
    ).toBe(true);
    expect(
      decideOrchestrationTransferScope({
        baseSha: 'a'.repeat(40),
        changedPaths: ['docs/guide.md'],
      }).run,
    ).toBe(false);
  });

  test('launches the gate with Node, hides Windows windows, and propagates failure', () => {
    const spawn = (command: string, args: string[], options: unknown) => {
      expect(command).toBe(process.execPath);
      expect(args).toEqual(['scripts/orchestration-transfer-gate.mjs']);
      expect(options).toEqual({ stdio: 'inherit', windowsHide: true });
      return { status: 17 };
    };
    expect(runOrchestrationTransferGate(spawn as never)).toBe(17);
    expect(
      runOrchestrationTransferGate((() => ({ status: null })) as never),
    ).toBe(1);
    expect(() =>
      runOrchestrationTransferGate((() => ({
        status: null,
        error: new Error('gate could not start'),
      })) as never),
    ).toThrow('gate could not start');
  });
});
