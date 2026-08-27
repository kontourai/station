import {
  normalizeLocalBrowserPreviewUrl,
  type WorkspaceBrowserPreviewState,
} from '@kontourai/station-contracts/workspace-browser-preview';
import { useEffect, useRef, useState } from 'react';
import { GlobeGlyph } from '../components/icons/Glyph';
import type {
  NativeBrowserPreviewGrant,
  NativeBrowserPreviewGrantResult,
  NativeBrowserPreviewObservation,
  NativeBrowserPreviewWindowResult,
  NativeCommandResult,
} from '../platform/native';
import './BrowserPreviewPane.css';

export interface BrowserPreviewPaneProps {
  /** Descriptive state owned by a future workspace/session integration. */
  preview: WorkspaceBrowserPreviewState;
  /** The owner opens the already-validated local target outside Station. */
  onOpenExternal: (url: string) => Promise<NativeCommandResult<void>>;
  /** Native host discovers/selects the exact loopback target and returns a grant. */
  onDiscoverNativeTarget?: (
    url: string,
  ) => Promise<NativeBrowserPreviewGrantResult>;
  /** Desktop renderer consumes only the fresh opaque native grant. */
  onOpenNativeWindow?: (
    grantId: string,
  ) => Promise<NativeBrowserPreviewWindowResult>;
  /** The owner persists only a validated local target; renderer state stays local. */
  onChangeAddress?: (url: string) => boolean;
  /** Native capability reason when the external action is not available. */
  unavailableReason?: string;
}

function validatedUrl(value: string): string | null {
  try {
    return normalizeLocalBrowserPreviewUrl(value);
  } catch {
    return null;
  }
}

function BrowserPreviewFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const origin = new URL(url).origin;

  return (
    <span className="browser-preview-pane__favicon">
      {failed ? (
        <GlobeGlyph className="browser-preview-pane__favicon-glyph" />
      ) : (
        <img
          alt=""
          className="browser-preview-pane__favicon-image"
          src={`${origin}/favicon.ico`}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

function statusLabel(status: WorkspaceBrowserPreviewState['status']): string {
  switch (status) {
    case 'external-action-ready':
      return 'Ready to open this local preview externally.';
    case 'unavailable':
      return 'The external browser action is unavailable on this host.';
    case 'loading':
    case 'rendering-unverified':
      return 'This preview cannot be rendered in Station yet.';
  }
}

function observationLabel(
  observation: NativeBrowserPreviewObservation | null,
): string | null {
  if (!observation) return null;
  const reachability = {
    reachable: 'The native host reached the selected loopback server.',
    refused: 'The selected loopback server refused the connection.',
    'dns-failed': 'The selected loopback host could not be resolved safely.',
    unreachable:
      'The selected loopback server did not respond to the bounded probe.',
    'not-observed': 'Reachability has not been observed.',
  }[observation.reachability];
  return `${reachability} TLS is ${observation.tls}; navigation is ${observation.navigation}; this separate window has no in-pane frame, title, or history observation.`;
}

/**
 * A deliberately small local-preview renderer. It does not discover URLs,
 * proxy requests, alter response headers, or expose any Station capability to
 * the framed page. Host availability and pane integration remain separate.
 */
export function BrowserPreviewPane({
  preview,
  onOpenExternal,
  onDiscoverNativeTarget,
  onOpenNativeWindow,
  onChangeAddress,
  unavailableReason,
}: BrowserPreviewPaneProps) {
  const url = validatedUrl(preview.currentUrl);
  const [projectionStatus, setProjectionStatus] = useState(preview.status);
  const [address, setAddress] = useState(preview.requestedUrl);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [nativeWindowError, setNativeWindowError] = useState<string | null>(
    null,
  );
  const [nativeGrant, setNativeGrant] =
    useState<NativeBrowserPreviewGrant | null>(null);
  const [observation, setObservation] =
    useState<NativeBrowserPreviewObservation | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [openingNativeWindow, setOpeningNativeWindow] = useState(false);
  const discoveryGeneration = useRef(0);
  const currentDiscoveryUrl = useRef(preview.currentUrl);

  useEffect(() => {
    // Durable metadata never includes an operational outcome.
    currentDiscoveryUrl.current = preview.currentUrl;
    discoveryGeneration.current += 1;
    if (!preview.currentUrl) return;
    setProjectionStatus(preview.status);
    setAddress(preview.requestedUrl);
    setAddressError(null);
    setOpenError(null);
    setNativeWindowError(null);
    setNativeGrant(null);
    setObservation(null);
    setDiscovering(false);
  }, [preview.currentUrl, preview.requestedUrl, preview.status]);

  if (!url) {
    return (
      <section aria-labelledby="browser-preview-title">
        <h2 id="browser-preview-title">Local browser preview</h2>
        <p role="alert">
          Station refused to render this preview because its URL is not an
          allowed local HTTP(S) address.
        </p>
      </section>
    );
  }

  const actionUnavailable = projectionStatus === 'unavailable';

  return (
    <section aria-labelledby="browser-preview-title">
      <h2 id="browser-preview-title">Local browser preview</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = validatedUrl(address);
          if (!next) {
            setAddressError('Enter an allowed local HTTP(S) address.');
            return;
          }
          if (!onChangeAddress?.(next)) {
            setAddressError('Station could not save this preview address.');
            return;
          }
          setAddress(next);
          setAddressError(null);
          discoveryGeneration.current += 1;
          setNativeGrant(null);
          setObservation(null);
          setDiscovering(false);
          setProjectionStatus(preview.status);
        }}
      >
        <label>
          Preview address
          <span className="browser-preview-pane__address">
            <BrowserPreviewFavicon key={new URL(url).origin} url={url} />
            <input
              aria-label="Preview address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </span>
        </label>
        <button type="submit">Use local address</button>
      </form>
      <div>
        {onDiscoverNativeTarget ? (
          <button
            type="button"
            disabled={actionUnavailable || discovering}
            onClick={() => {
              const generation = ++discoveryGeneration.current;
              const requestedUrl = url;
              setDiscovering(true);
              setNativeWindowError(null);
              setNativeGrant(null);
              void onDiscoverNativeTarget(requestedUrl)
                .then((result) => {
                  if (
                    generation !== discoveryGeneration.current ||
                    currentDiscoveryUrl.current !== requestedUrl
                  ) {
                    return;
                  }
                  if (result.status === 'ok') {
                    setNativeGrant(result.value);
                    setObservation(result.value.observation);
                    return;
                  }
                  if (result.status === 'error') {
                    setObservation(result.observation ?? null);
                    setNativeWindowError(result.message);
                    return;
                  }
                  setNativeWindowError(result.reason);
                })
                .catch(() => {
                  if (
                    generation !== discoveryGeneration.current ||
                    currentDiscoveryUrl.current !== requestedUrl
                  ) {
                    return;
                  }
                  setNativeWindowError(
                    'Station could not discover the selected local server.',
                  );
                })
                .finally(() => {
                  if (
                    generation === discoveryGeneration.current &&
                    currentDiscoveryUrl.current === requestedUrl
                  ) {
                    setDiscovering(false);
                  }
                });
            }}
          >
            {nativeGrant
              ? 'Rediscover local server'
              : nativeWindowError
                ? 'Retry local-server discovery'
                : 'Discover local server'}
          </button>
        ) : null}
        {onOpenNativeWindow ? (
          <button
            type="button"
            disabled={
              actionUnavailable || openingNativeWindow || nativeGrant === null
            }
            onClick={() => {
              if (!nativeGrant) return;
              const consumedGrantId = nativeGrant.grantId;
              // A native grant is single-use as soon as renderer creation is
              // attempted. Clear it before awaiting the host so no success,
              // typed failure, or rejected invocation can make a consumed
              // grant available for another attempt.
              setNativeGrant(null);
              setOpeningNativeWindow(true);
              setNativeWindowError(null);
              void onOpenNativeWindow(consumedGrantId)
                .then((result) => {
                  if (result.status === 'ok') {
                    setObservation(result.value.observation);
                    setNativeGrant(null);
                    return;
                  }
                  setNativeWindowError(
                    result.status === 'unsupported'
                      ? result.reason
                      : result.message,
                  );
                })
                .catch(() => {
                  setNativeWindowError(
                    'Station could not create the desktop Browser Preview.',
                  );
                })
                .finally(() => setOpeningNativeWindow(false));
            }}
          >
            Open in desktop preview
          </button>
        ) : null}
        <button
          type="button"
          disabled={actionUnavailable || opening}
          onClick={() => {
            setOpening(true);
            setOpenError(null);
            void onOpenExternal(url)
              .then((result) => {
                if (result.status === 'ok') return;
                setOpenError(
                  result.status === 'unsupported'
                    ? result.reason
                    : result.message,
                );
              })
              .catch(() => {
                setOpenError('Station could not open this local preview.');
              })
              .finally(() => setOpening(false));
          }}
        >
          Open externally
        </button>
      </div>
      <p role="status">{statusLabel(projectionStatus)}</p>
      {observationLabel(observation) ? (
        <p role="status">{observationLabel(observation)}</p>
      ) : null}
      {addressError ? <p role="alert">{addressError}</p> : null}
      {openError ? <p role="alert">{openError}</p> : null}
      {nativeWindowError ? <p role="alert">{nativeWindowError}</p> : null}
      {actionUnavailable ? (
        <p>
          This host cannot open the validated local address. Renderer health is
          unknown because Station has not started one. {unavailableReason}
        </p>
      ) : (
        <p>
          {onOpenNativeWindow
            ? 'The desktop preview is a separate untrusted window, not an in-pane frame. Station first discovers one selected loopback target through the native boundary, then permits only its exact origin and denies popups and downloads. Renderer health remains unverified.'
            : 'Station opens this target externally. A framed renderer cannot prove that a local server did not redirect to another origin, so this pane does not mount one until a host can intercept navigation.'}
        </p>
      )}
    </section>
  );
}
