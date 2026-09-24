/**
 * @vitest-environment jsdom
 *
 * Epic #2323 S3 (verifier G10): `PluginRegistry.loadDraftBundle` directly.
 * jsdom never executes an external `<script src>`, so the browser's part of
 * a load is stood in for by dispatching `load` (as `PluginRegistry.csp.test.ts`
 * does), optionally after writing the registration a bundle would write.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../platform/native', () => ({
  nativePlatformPromise: Promise.resolve({ platform: 'web' }),
}));

import { PluginRegistry } from '../core/PluginRegistry';

const ORIGIN = 'http://localhost:3000';

function draftScript(key: string): HTMLScriptElement | undefined {
  return [
    ...document.head.querySelectorAll<HTMLScriptElement>(
      'script[data-station-plugin-draft]',
    ),
  ].find((node) => node.getAttribute('data-station-plugin-draft') === key);
}

async function completeLoad(key: string, register?: () => void) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const script = draftScript(key);
    if (script) {
      register?.();
      script.dispatchEvent(new Event('load'));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no draft script for ${key}`);
}

function registry() {
  const value = new PluginRegistry(Promise.resolve({ platform: 'web' }));
  value.setApiBase(ORIGIN);
  return value;
}

afterEach(() => {
  document.head
    .querySelectorAll('[data-station-plugin-draft]')
    .forEach((node) => node.remove());
  delete (window as any).__station_ai_plugin_drafts;
});

describe('PluginRegistry draft loading', () => {
  test('a registration planted before the load is not adopted', async () => {
    const key = 'draft_x:life:1';
    (window as any).__station_ai_plugin_drafts = {
      [key]: { components: { pulse: () => null } },
    };
    const loading = registry().loadDraftBundle({
      bundleUrl: `${ORIGIN}/draft/1/bundle.js`,
      registrationKey: key,
      signal: new AbortController().signal,
    });
    // The script runs but does not re-register.
    await completeLoad(key);
    await expect(loading).rejects.toThrow('did not register');
    // A refused revision leaves nothing behind.
    expect(draftScript(key)).toBeUndefined();
  });

  test('unloading one revision leaves another revision loaded', async () => {
    const reg = registry();
    const load = async (key: string) => {
      const loading = reg.loadDraftBundle({
        bundleUrl: `${ORIGIN}/draft/${key}/bundle.js`,
        registrationKey: key,
        signal: new AbortController().signal,
      });
      await completeLoad(key, () => {
        (window as any).__station_ai_plugin_drafts ??= {};
        (window as any).__station_ai_plugin_drafts[key] = {
          components: { pulse: () => null },
        };
      });
      return loading;
    };
    const first = await load('draft_x:life:1');
    const second = await load('draft_x:life:2');
    first.unload();
    expect(draftScript('draft_x:life:1')).toBeUndefined();
    expect(draftScript('draft_x:life:2')).toBeDefined();
    expect(
      (window as any).__station_ai_plugin_drafts['draft_x:life:2'],
    ).toBeDefined();
    expect(
      (window as any).__station_ai_plugin_drafts['draft_x:life:1'],
    ).toBeUndefined();
    second.unload();
    expect(draftScript('draft_x:life:2')).toBeUndefined();
  });
});
