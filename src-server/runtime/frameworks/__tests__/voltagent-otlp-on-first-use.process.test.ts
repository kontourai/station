import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { scaleLivenessMs } from '../../../../scripts/lib/liveness-scale.mjs';

/**
 * The 2.11.0 VoltAgent patch loads the OTLP exporters and serializers only
 * when they are first needed (each copy of the OTLP transformer
 * costs megabytes of heap, and VoltAgent's tree holds several). Importing
 * VoltAgent, as the server does at boot, must load none of them. The remote
 * export itself is covered by the VoltOps control cases in
 * voltagent-managed-telemetry.test.ts.
 *
 * Each case runs in a fresh process, where a module hook records every
 * module Node loads, through `import` or `require`.
 */
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const OTLP =
  /\/@opentelemetry\/(otlp-transformer|exporter-logs-otlp-http|exporter-trace-otlp-http)\//;

function otlpPackagesLoadedBy(load: string): string[] {
  const script = `
    import { createRequire, registerHooks } from 'node:module';
    const loaded = new Set();
    registerHooks({
      load(url, context, next) {
        const match = ${OTLP}.exec(url);
        if (match) loaded.add(match[1]);
        return next(url, context);
      },
    });
    const require = createRequire(${JSON.stringify(`${root}package.json`)});
    ${load}
    if (typeof core.VoltAgentObservability !== 'function') {
      throw new Error('VoltAgent did not load');
    }
    process.stdout.write(JSON.stringify([...loaded].sort()));
  `;
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: scaleLivenessMs(20_000),
      windowsHide: true,
    },
  );
  return JSON.parse(output) as string[];
}

describe('VoltAgent OTLP export modules', () => {
  test.each([
    ['ESM', "const core = await import('@voltagent/core');"],
    ['CommonJS', "const core = require('@voltagent/core');"],
  ])('are not loaded when VoltAgent is imported as %s', (_format, load) => {
    expect(otlpPackagesLoadedBy(load)).toEqual([]);
  });

  test('are seen by the hook when one is required directly (control)', () => {
    // Proves the hook sees these packages at all, so an empty list above
    // is not a hook that never fires.
    expect(
      otlpPackagesLoadedBy(
        "const core = await import('@voltagent/core');" +
          "require('@opentelemetry/exporter-trace-otlp-http');",
      ),
    ).toContain('exporter-trace-otlp-http');
  });
});
