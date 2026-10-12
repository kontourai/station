import { renameSync, writeFileSync } from 'node:fs';

const phaseNames = [
  'source-validation',
  'imports',
  'runtime-startup',
  'external-measurement',
  'native-measurement',
  'report-write',
  'listener-close',
  'service-shutdown',
  'store-close',
  'cleanup-complete',
] as const;
const phases = new Set(phaseNames);

type CapturePhase = (typeof phaseNames)[number];

export function createTransferCaptureProgress(
  outputPath: string,
  source: { subjectSha: string; baseSha: string; toolDigest: string },
) {
  const started = performance.now();
  const path = `${outputPath}.progress.json`;
  return (phase: CapturePhase) => {
    if (!phases.has(phase)) throw new Error('Unknown transfer capture phase');
    const record = {
      schemaVersion: 1,
      kind: 'station-transfer-capture-progress',
      subjectSha: source.subjectSha,
      baseSha: source.baseSha,
      toolDigest: source.toolDigest,
      phase,
      elapsedMs: Math.round(performance.now() - started),
    };
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
      return true;
    } catch {
      process.stderr.write(
        `[transfer-capture] Phase diagnostic unavailable: ${phase}\n`,
      );
      return false;
    }
  };
}
