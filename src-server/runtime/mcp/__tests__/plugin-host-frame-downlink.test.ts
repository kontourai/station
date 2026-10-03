import vm from 'node:vm';
import { describe, expect, test } from 'vitest';
import { buildPluginHostFrameDocument } from '../mcp-ui-frame-server.js';

/**
 * The plugin-host bootstrap is emitted as a STRING of inline JavaScript, so
 * nothing typechecks it and — until this file — nothing executed it either.
 * Its only coverage was `tests/plugin-host-security.spec.ts`, which is red on
 * main for an unrelated pane-binding regression, so the most
 * security-sensitive line in the bridge had no green evidence behind it at
 * all (archive#4201 review).
 *
 * These tests run the REAL emitted script in a VM with the browser globals it
 * expects, and drive real messages through the handler it registers. What
 * they pin is the host→plugin relay: which methods cross it, and that the
 * parent-origin pin is genuinely upstream of it.
 */

const HOST_ORIGIN = 'https://station.test';

interface Harness {
  dispatch: (event: Record<string, unknown>) => void;
  /** Everything the bootstrap relayed DOWN into the plugin frame. */
  relayed: unknown[];
  /** Everything the bootstrap posted UP to the parent. */
  toParent: unknown[];
  loaded: () => boolean;
}

function runBootstrap(origins: readonly string[] = [HOST_ORIGIN]): Harness {
  const document = buildPluginHostFrameDocument('nonce-1', origins);
  const script = document.slice(
    document.indexOf('>(() => {') + 1,
    document.lastIndexOf('</script>'),
  );

  const relayed: unknown[] = [];
  const toParent: unknown[] = [];
  let listener: ((event: Record<string, unknown>) => void) | null = null;
  const innerWindow = {
    postMessage: (data: unknown) => {
      relayed.push(data);
    },
  };
  let appChildren: unknown[] = [];

  const sandbox = {
    parent: {
      postMessage: (data: unknown) => {
        toParent.push(data);
      },
    },
    addEventListener: (
      _type: string,
      handler: (event: Record<string, unknown>) => void,
    ) => {
      listener = handler;
    },
    document: {
      getElementById: () => ({
        replaceChildren: (...children: unknown[]) => {
          appChildren = children;
        },
      }),
      createElement: () => ({
        title: '',
        sandbox: { value: '' },
        srcdoc: '',
        contentWindow: innerWindow,
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  if (!listener)
    throw new Error('the bootstrap registered no message listener');

  const dispatch = (event: Record<string, unknown>) => {
    (listener as (e: Record<string, unknown>) => void)({
      origin: HOST_ORIGIN,
      source: sandbox.parent,
      ...event,
    });
  };

  // Mount a plugin frame so `inner` is set; the relay is a no-op without one.
  dispatch({
    data: {
      method: 'plugin-resource-ready',
      params: { runtimeJs: '/*rt*/', bundleJs: '/*b*/' },
    },
  });

  return { dispatch, relayed, toParent, loaded: () => appChildren.length > 0 };
}

describe('plugin-host frame downlink', () => {
  test('relays declared pane-host replies, including an experience result', () => {
    const harness = runBootstrap();
    expect(harness.loaded()).toBe(true);

    for (const method of [
      'pane-host/confirm-result',
      'pane-host/facts-changed',
      'pane-host/refused',
      'pane-host/experience-result',
    ]) {
      harness.dispatch({ data: { method, params: { id: method } } });
    }
    expect(
      harness.relayed.map((entry) => (entry as { method: string }).method),
    ).toEqual([
      'pane-host/confirm-result',
      'pane-host/facts-changed',
      'pane-host/refused',
      'pane-host/experience-result',
    ]);
  });

  test('an unknown host message is not relayed', () => {
    const harness = runBootstrap();
    harness.dispatch({ data: { method: 'something-new', params: {} } });
    expect(harness.relayed).toEqual([]);
  });

  test('the parent-origin pin is upstream of the relay', () => {
    const harness = runBootstrap();
    // The pin binds to the first accepted origin; a different origin afterwards
    // must reach nothing, relay included.
    harness.dispatch({
      origin: 'https://evil.example',
      data: { method: 'pane-host/confirm-result', params: { id: 'x' } },
    });
    expect(harness.relayed).toEqual([]);
  });

  test('an origin outside the ancestor set can neither pin nor relay', () => {
    const document = buildPluginHostFrameDocument('nonce-1', [HOST_ORIGIN]);
    const script = document.slice(
      document.indexOf('>(() => {') + 1,
      document.lastIndexOf('</script>'),
    );
    const relayed: unknown[] = [];
    let listener: ((event: Record<string, unknown>) => void) | null = null;
    const sandbox = {
      parent: { postMessage: () => {} },
      addEventListener: (
        _t: string,
        handler: (event: Record<string, unknown>) => void,
      ) => {
        listener = handler;
      },
      document: {
        getElementById: () => ({ replaceChildren: () => {} }),
        createElement: () => ({
          title: '',
          sandbox: { value: '' },
          srcdoc: '',
          contentWindow: {
            postMessage: (data: unknown) => {
              relayed.push(data);
            },
          },
        }),
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox);
    const dispatch = listener as unknown as (
      e: Record<string, unknown>,
    ) => void;

    dispatch({
      origin: 'https://evil.example',
      source: sandbox.parent,
      data: {
        method: 'plugin-resource-ready',
        params: { runtimeJs: '/*rt*/', bundleJs: '/*b*/' },
      },
    });
    dispatch({
      origin: 'https://evil.example',
      source: sandbox.parent,
      data: { method: 'pane-host/confirm-result', params: { id: 'x' } },
    });
    expect(relayed).toEqual([]);
  });
});

// Threat model: matching-origin messages from another Window cannot act as the containing host.
test('a same-origin sibling Window cannot inject an experience result, while the actual parent still forwards it', () => {
  const harness = runBootstrap();
  const message = {
    method: 'pane-host/experience-result',
    params: { id: 'read-1', data: { viewJson: 'FORGED_SIBLING_CANARY' } },
  };
  harness.dispatch({ source: {}, data: message });
  expect(harness.relayed).toEqual([]);
  const legitimate = {
    method: 'pane-host/experience-result',
    params: { id: 'read-1', data: { viewJson: 'CANONICAL_PARENT_RESULT' } },
  };
  harness.dispatch({ data: legitimate });
  expect(harness.relayed).toEqual([legitimate]);
});
