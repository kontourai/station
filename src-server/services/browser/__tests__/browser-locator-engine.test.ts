/**
 * Playwright's injected selector engine is found in the installed
 * `playwright-core` bundle by its generated module, not by a variable name
 * the bundler renumbers between releases (#90 D3, browser tool locators).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  extractInjectedScriptSource,
  loadLocatorEngineInstallExpression,
} from '../browser-locator-engine.js';

const literal = (text: string) => JSON.stringify(text).replace(/"/g, "'");

function bundle(parts: { decoy: string; injected: string }): string {
  const module = (path: string, name: string, source: string) =>
    `var init_x = __esm({\n  "packages/playwright-core/src/generated/${path}"() {\n    "use strict";\n    ${name} = ${literal(source)};\n  }\n});\n`;
  return (
    module('utilityScriptSource.ts', 'source3', parts.decoy) +
    module('injectedScriptSource.ts', 'source4', parts.injected)
  );
}

describe('the locator engine source', () => {
  test('is taken from the injected-script module even when an earlier module uses the old variable name', () => {
    const injected = `module.exports = { InjectedScript: () => class {} }; // ${'x'.repeat(120_000)}`;
    const source = extractInjectedScriptSource(
      bundle({ decoy: `decoy ${'y'.repeat(120_000)}`, injected }),
    );
    expect(source).toBe(injected);
  });

  test('a too-short literal is refused rather than installed', () => {
    expect(() =>
      extractInjectedScriptSource(bundle({ decoy: 'd', injected: 'short' })),
    ).toThrow(/not the expected string/);
  });

  test('the installed playwright-core yields an install expression for the page global', async () => {
    const expression = await loadLocatorEngineInstallExpression();
    expect(
      expression,
      'playwright-core is a dev dependency here',
    ).toBeDefined();
    expect(expression!.length).toBeGreaterThan(100_000);
    // A Symbol-keyed own property: no element id or name can pre-empt it,
    // and "installed" means a real engine, not just a truthy global (N-a).
    expect(expression).toContain(
      "Object.defineProperty(globalThis, Symbol.for('station.agent-tools.locator-engine')",
    );
    expect(expression).toContain("typeof engine.parseSelector === 'function'");
    expect(expression).not.toContain('__stationPlaywrightInjected');
  });

  test("the real bundle's injected script exports the InjectedScript factory the install calls", () => {
    const require = createRequire(import.meta.url);
    const bundlePath = join(
      dirname(require.resolve('playwright-core/package.json')),
      'lib',
      'coreBundle.js',
    );
    const source = extractInjectedScriptSource(
      readFileSync(bundlePath, 'utf8'),
    );
    const module = { exports: {} as Record<string, unknown> };
    new Function('module', 'exports', source)(module, module.exports);
    expect(typeof module.exports.InjectedScript).toBe('function');
  });

  test('the runtime pin: playwright-core is an exact runtime dependency matching @playwright/test, and its injected script is the reviewed one', () => {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../../../package.json', import.meta.url),
        'utf8',
      ),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    // Exact (no range), a runtime dependency, and the same release the test
    // runner uses.
    expect(manifest.dependencies['playwright-core']).toBe('1.63.0');
    const installed = JSON.parse(
      readFileSync(require.resolve('playwright-core/package.json'), 'utf8'),
    ) as { version: string };
    const runner = JSON.parse(
      readFileSync(require.resolve('@playwright/test/package.json'), 'utf8'),
    ) as { version: string };
    expect(installed.version).toBe('1.63.0');
    expect(runner.version).toBe(installed.version);
    // A different injected script (a bump, a patched install) fails here
    // until someone reviews it and moves this digest on purpose.
    const source = extractInjectedScriptSource(
      readFileSync(
        join(
          dirname(require.resolve('playwright-core/package.json')),
          'lib',
          'coreBundle.js',
        ),
        'utf8',
      ),
    );
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '94103308b4f5791976b53543f5812be61ffb988574f7a51f412f87ab0ad60a85',
    );
  });
});
