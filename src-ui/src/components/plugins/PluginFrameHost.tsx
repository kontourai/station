import { authenticatedFetch } from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useConfig } from '../../contexts/ConfigContext';
import { useNavigationOptional } from '../../contexts/NavigationContext';
import { isDistinctFrameOrigin } from '../mcp-ui/frameOrigin';
import {
  type FramePaneHostOutboundMessage,
  useFramePaneHost,
} from './framePaneHost';

const READY = 'plugin-host-ready';
const RESOURCE = 'plugin-resource-ready';

export interface PluginFrameHostProps {
  plugin: { name: string; declaredSlug: string; granted?: readonly string[] };
  /** Re-runs the registry's exact provenance check before byte transfer. */
  authorize?: () => boolean;
  onObservation: (exports: readonly string[]) => void;
  onFailure: () => void;
}

/**
 * Remote plugin renderer. Plugin bytes are fetched by the authenticated shell,
 * then delivered to the separate frame origin. No credential or shell nonce is
 * ever included in the frame message.
 */
export function PluginFrameHost({
  plugin,
  authorize = () => true,
  onObservation,
  onFailure,
}: PluginFrameHostProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { apiBase } = useApiBase();
  const config = useConfig();
  const [ready, setReady] = useState(false);
  const configuredOrigin = config?.pluginFrameOrigin;
  const [profileFrameOrigin, setProfileFrameOrigin] = useState<string>();
  const origin = isDistinctFrameOrigin(configuredOrigin)
    ? configuredOrigin
    : profileFrameOrigin;
  const enabled = isDistinctFrameOrigin(origin);
  const navigation = useNavigationOptional();
  const onFailureRef = useRef(onFailure);
  useEffect(() => {
    onFailureRef.current = onFailure;
  }, [onFailure]);

  // A saved native profile can become active after the shell's ordinary app
  // config query has already resolved against the bundled server. Do not let
  // that boot race make remote isolation permanently unavailable: when the
  // current config has no usable frame authority, resolve this capability
  // from the exact authenticated profile endpoint that owns the plugin.
  useEffect(() => {
    if (isDistinctFrameOrigin(configuredOrigin)) return;
    const controller = new AbortController();
    setProfileFrameOrigin(undefined);
    void authenticatedFetch(`${apiBase}/config/app`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('plugin frame config unavailable');
        const result = (await response.json()) as {
          success?: boolean;
          data?: { pluginFrameOrigin?: unknown };
        };
        const candidate = result.data?.pluginFrameOrigin;
        if (
          result.success !== true ||
          typeof candidate !== 'string' ||
          !isDistinctFrameOrigin(candidate)
        ) {
          throw new Error('plugin frame origin unavailable');
        }
        setProfileFrameOrigin(candidate);
      })
      .catch(() => {
        if (!controller.signal.aborted) onFailureRef.current();
      });
    return () => controller.abort();
  }, [apiBase, configuredOrigin]);

  /**
   * The frame's half of the pane-host contract (archive#4201 step 3). The
   * shell capabilities a plugin frame may reach — a toast, a navigation, a
   * confirmation, the device facts — are not implemented in this component
   * any more: they are contract members, implemented once per transport, and
   * this component supplies the transport. `receive` is what turns an
   * inbound message into a contract call; `post` is how an answer goes back.
   */
  const post = useCallback(
    (message: FramePaneHostOutboundMessage) => {
      if (!origin) return;
      iframeRef.current?.contentWindow?.postMessage(message, origin);
    },
    [origin],
  );
  // Bumped when the bridge effect tears the plugin document down, so an open
  // confirm cannot survive into the document that replaces it.
  const [frameGeneration, setFrameGeneration] = useState(0);
  const { confirmChrome, receive: receivePaneHostMessage } = useFramePaneHost({
    pluginName: plugin.name,
    granted: plugin.granted,
    generation: frameGeneration,
    // The same expression the render's early return branches on, so the
    // host's notion of "the frame is on screen" cannot drift from whether
    // this component renders it and its confirm chrome.
    active: enabled && Boolean(origin),
    navigate: navigation?.navigate ?? null,
    post,
  });

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !enabled || !origin) return;
    const source = iframe.contentWindow;
    const receive = (event: MessageEvent) => {
      // Origin AND WindowProxy are both pinned. A same-origin sibling cannot
      // spoof a plugin reply merely by knowing the protocol shape.
      if (event.origin !== new URL(origin).origin || event.source !== source)
        return;
      const message = event.data as { method?: string; params?: unknown };
      if (message?.method === READY) setReady(true);
      if (message?.method === 'initialize') {
        const exports = (message.params as { exports?: unknown })?.exports;
        if (
          Array.isArray(exports) &&
          exports.every((value) => typeof value === 'string')
        ) {
          onObservation(exports);
        } else {
          onFailure();
        }
      }
      if (message?.method === 'fill') {
        const height = (message.params as { height?: unknown })?.height;
        if (
          typeof height === 'number' &&
          Number.isFinite(height) &&
          height >= 0
        ) {
          iframe.style.height = `${height}px`;
        }
      }
      // `toast` and `navigate` are contract members now, not two bespoke
      // cases here: the adapter decodes them into `notify`/`navigate` and
      // applies the shell's own budget and chrome. Everything under the
      // `pane-host/` namespace arrives the same way, and a message that
      // belongs to the contract but does not validate is refused with a
      // reply rather than dropped in silence.
      // archive#4300 deleted the `api-request` bridge that used to sit here —
      // the one uplink method that asked the shell to perform an `/api/**`
      // request with the operator's credential. It had no producer anywhere
      // (no SDK helper, no example, not in the plugin guide), its
      // `api-response` was never relayed back down to plugin code so it could
      // not answer a read, and it forwarded neither body nor headers so it
      // could barely serve a write. The only permission it mapped to a real
      // surface was `plugin.server`, whose holder already gets an
      // `await import` into the Station server process — so the bridge gave
      // strictly less than the permission it required, at the cost of a
      // credentialed egress point on the frame boundary.
      //
      // There is deliberately no handler and no refusal for the name: an
      // unrecognised uplink message falls through here exactly like any other
      // method the contract does not define. A plugin needing a Station
      // operation gets a declared pane-host contract member, decided on its
      // own merits.
      receivePaneHostMessage(message);
    };
    window.addEventListener('message', receive);
    return () => {
      source?.postMessage({ method: 'teardown', params: {} }, origin);
      window.removeEventListener('message', receive);
      // The plugin document this listener served is gone. Anything still
      // waiting on it belongs to that document, not to its replacement.
      setFrameGeneration((generation) => generation + 1);
    };
  }, [enabled, onFailure, onObservation, origin, receivePaneHostMessage]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !ready || !origin || !enabled) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        if (!authorize())
          throw new Error('plugin layout is no longer authorized');
        const base = `${apiBase}/api/plugins/${encodeURIComponent(plugin.name)}`;
        const [js, css] = await Promise.all([
          authenticatedFetch(`${base}/bundle.js`, {
            signal: controller.signal,
          }),
          authenticatedFetch(`${base}/bundle.css`, {
            signal: controller.signal,
          }),
        ]);
        if (!js.ok || !css.ok) throw new Error('plugin bytes unavailable');
        const target = iframe.contentWindow;
        if (!target) throw new Error('plugin frame unavailable');
        target.postMessage(
          {
            method: RESOURCE,
            params: {
              bundleJs: await js.text(),
              bundleCss: await css.text(),
              // This tiny runtime observes registration; it does not expose
              // host objects, credentials, or a CSP nonce to plugin code.
              runtimeJs: `addEventListener('load',()=>queueMicrotask(()=>parent.postMessage({method:'initialize',params:{exports:Object.keys(window.__station_ai_plugins?.[${JSON.stringify(plugin.name)}]?.components||{})}},'*')));`,
            },
          },
          origin,
        );
      } catch {
        if (!controller.signal.aborted) onFailure();
      }
    };
    void load();
    return () => controller.abort();
  }, [apiBase, authorize, enabled, onFailure, origin, plugin.name, ready]);

  if (!enabled || !origin)
    return <div role="status">Plugin frame unavailable.</div>;
  return (
    <>
      <iframe
        ref={iframeRef}
        className="mcp-tool-ui-frame__iframe"
        sandbox="allow-scripts allow-same-origin"
        src={`${origin}/plugin-host/frame`}
        title={`Plugin: ${plugin.declaredSlug}`}
      />
      {/*
        The SHELL's confirm chrome, rendered HERE rather than inside the
        frame — the design's "the shell renders its own modal on the pane's
        behalf". A dialog drawn inside the iframe would be the plugin's own
        pixels wearing Station's authority; this one is Station's, portalled
        to the document body, and the frame only ever learns the decision.
        It renders nothing until a confirm is outstanding.
      */}
      {confirmChrome}
    </>
  );
}
