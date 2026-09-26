/**
 * Playwright's injected selector engine, for browser-tool locators (#90 D3).
 *
 * Station speaks raw CDP (no Playwright Page/Locator APIs at runtime, so a
 * CEF host can do the same). Locators such as `role=button[name="Save"]`,
 * `text=Sign in` or `css=#email` use Playwright's own injected script,
 * installed into the page through `Runtime.evaluate` WITHOUT
 * `includeCommandLineAPI`. It runs in the page's main world, with the page's
 * own authority only, so a hostile page can interfere with its own
 * locators; it can do nothing a page cannot already do.
 *
 * `playwright-core` is an exact-pinned runtime dependency (the same release
 * as `@playwright/test`), and a test pins the digest of the script extracted
 * from it. It is still resolved at runtime: should it ever be missing,
 * locators report `locator-engine-unavailable` rather than failing
 * silently, and element refs and coordinates keep working.
 *
 * The script source is extracted from playwright-core's bundle: the search
 * is anchored on the generated module's path (not a variable name, which
 * changes between releases), the literal is evaluated in a sandbox rather
 * than parsed by hand, and a minimum length rejects a truncated match.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

// The bundle's generated module for the injected script. Its local variable
// is renumbered between Playwright releases (`source3` in earlier ones,
// `source4` in 1.62), so the module path anchors the search, not the name.
const SOURCE_MODULE = 'generated/injectedScriptSource.ts"';
const SOURCE_ASSIGNMENT = /\bsource\d* = /g;
const SOURCE_TERMINATOR = ';\n  }\n});';
const SOURCE_MINIMUM_LENGTH = 100_000;
const SOURCE_EVALUATION_TIMEOUT_MS = 1_000;

/**
 * Where the engine lives in Station's isolated world: a Symbol-keyed own
 * property of the global, so no element id or name can shadow or pre-empt it
 * (review N-a: `<div id="__stationPlaywrightInjected">` made a string-keyed
 * install skip itself).
 */
export const BROWSER_LOCATOR_ENGINE_REF =
  "globalThis[Symbol.for('station.agent-tools.locator-engine')]";
/** An expression: whether the real engine is installed. */
export const BROWSER_LOCATOR_ENGINE_READY = `(() => { const engine = ${BROWSER_LOCATOR_ENGINE_REF}; return !!engine && typeof engine.parseSelector === 'function' && typeof engine.querySelector === 'function'; })()`;

/** Pull the injected-script source literal out of Playwright's core bundle. */
export function extractInjectedScriptSource(coreBundle: string): string {
  const moduleStart = coreBundle.indexOf(SOURCE_MODULE);
  if (moduleStart < 0) throw new Error('injected script module not found');
  SOURCE_ASSIGNMENT.lastIndex = moduleStart;
  const assignment = SOURCE_ASSIGNMENT.exec(coreBundle);
  if (!assignment) throw new Error('injected script marker not found');
  const literalStart = assignment.index + assignment[0].length;
  const literalEnd = coreBundle.indexOf(SOURCE_TERMINATOR, literalStart);
  if (literalEnd < 0) throw new Error('injected script terminator not found');
  const source: unknown = runInNewContext(
    coreBundle.slice(literalStart, literalEnd),
    Object.create(null),
    { timeout: SOURCE_EVALUATION_TIMEOUT_MS },
  );
  if (typeof source !== 'string' || source.length < SOURCE_MINIMUM_LENGTH)
    throw new Error('injected script source is not the expected string');
  return source;
}

/** The expression that installs the engine once per document. */
function injectedScriptInstallExpression(source: string): string {
  const options = JSON.stringify({
    isUnderTest: false,
    sdkLanguage: 'javascript',
    testIdAttributeName: 'data-testid',
    stableRafCount: 1,
    browserName: 'chromium',
    shouldPrependErrorPrefix: false,
    isUtilityWorld: false,
    customEngines: [],
  });
  return `(() => {
    if (${BROWSER_LOCATOR_ENGINE_READY}) return true;
    const module = { exports: {} };
    ${source}
    Object.defineProperty(globalThis, Symbol.for('station.agent-tools.locator-engine'), {
      value: new (module.exports.InjectedScript())(globalThis, ${options}),
      configurable: true,
    });
    return true;
  })()`;
}

let cached: Promise<string | undefined> | undefined;

/**
 * The install expression, or undefined when `playwright-core` is not
 * available. Resolved once per process.
 */
export function loadLocatorEngineInstallExpression(): Promise<
  string | undefined
> {
  cached ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const packageJson = require.resolve('playwright-core/package.json');
      const bundle = await readFile(
        join(dirname(packageJson), 'lib', 'coreBundle.js'),
        'utf8',
      );
      return injectedScriptInstallExpression(
        extractInjectedScriptSource(bundle),
      );
    } catch {
      return undefined;
    }
  })();
  return cached;
}
