import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { useMutation } from '@tanstack/react-query';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorState, SkeletonBlock } from '../../components/state';
import { sha256Hex } from '../../utils/sha256';
import { BrowserAnnotation } from './BrowserAnnotation';
import { BROWSER_PAGE_CONTENT_NOTICE } from './browserArtifactContent';
import type { BrowserPaneApi } from './browserPaneApi';
import { useBrowserArtifactIntake } from './useBrowserArtifactIntake';

export function BrowserAnnotationFlow({
  stageRef,
  record,
  api,
  onClose,
  onError,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  record: BrowserSessionView;
  api: BrowserPaneApi;
  onClose(): void;
  onError(message: string): void;
}) {
  const beginIntake = useBrowserArtifactIntake();
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const started = useRef(false);
  const capture = useMutation({
    mutationFn: async () => {
      const { blob, scroll } = await api.annotationScreenshot(
        record.browserSessionId,
      );
      const capturedAt = new Date().toISOString();
      const current = await api.sessionSummary(record.browserSessionId);
      if (
        current.state !== 'live' ||
        current.generation !== record.generation ||
        current.url !== record.url ||
        current.viewport.width !== record.viewport.width ||
        current.viewport.height !== record.viewport.height
      )
        throw new Error('The page changed during capture.');
      return { blob, scroll, capturedAt };
    },
  });
  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      capture.mutate();
    }
    return () => {
      mounted.current = false;
    };
  }, [capture.mutate]);
  const cancel = () => {
    mounted.current = false;
    onClose();
  };
  if (capture.isPending || capture.isIdle)
    return (
      <div className="browser-pane__overlay-notice">
        <SkeletonBlock label="Capturing page" />
        <Button size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    );
  if (capture.isError)
    return (
      <>
        <ErrorState
          title="Page capture unavailable"
          action={<Button onClick={() => capture.mutate()}>Retry</Button>}
        />
        <Button onClick={cancel}>Cancel</Button>
      </>
    );
  return (
    <BrowserAnnotation
      stageRef={stageRef}
      screenshot={capture.data.blob}
      scroll={capture.data.scroll}
      viewport={record.viewport}
      generation={record.generation}
      sessionId={record.browserSessionId}
      api={api}
      pending={pending}
      onCancel={cancel}
      onAttach={(annotation) => {
        setPending(true);
        void (async () => {
          const attach = beginIntake(() => mounted.current);
          const current = await api.sessionSummary(record.browserSessionId);
          if (
            current.state !== 'live' ||
            current.generation !== record.generation ||
            current.url !== record.url ||
            current.viewport.width !== record.viewport.width ||
            current.viewport.height !== record.viewport.height
          )
            throw new Error(
              'The page changed before the annotation could be attached.',
            );
          if (!mounted.current) return;
          const selected = annotation.picked;
          const {
            screenshot: data,
            targetId: _targetId,
            ...picked
          } = selected ?? {};
          const crop = data
            ? new Blob(
                [
                  Uint8Array.from(atob(data), (character) =>
                    character.charCodeAt(0),
                  ),
                ],
                { type: 'image/png' },
              )
            : undefined;
          const viewport = capture.data.blob;
          const images =
            annotation.marks.length || !crop
              ? [viewport, ...(crop ? [crop] : [])]
              : [crop];
          const files: File[] = [];
          const descriptions = [];
          for (const [index, blob] of images.entries()) {
            const kind =
              blob === crop
                ? 'target-element-crop'
                : 'target-viewport-screenshot';
            const digest = `sha256:${await sha256Hex(new Uint8Array(await blob.arrayBuffer()))}`;
            if (
              kind === 'target-element-crop' &&
              selected?.digest &&
              digest !== `sha256:${selected.digest}`
            )
              throw new Error(
                'The selected image did not match its capture digest.',
              );
            const name = `browser-${kind}-${index + 1}.${blob.type === 'image/jpeg' ? 'jpg' : 'png'}`;
            files.push(new File([blob], name, { type: blob.type }));
            descriptions.push({
              name,
              kind,
              sourceImageDigest: digest,
              capturedAt:
                kind === 'target-element-crop'
                  ? selected?.capturedAt
                  : capture.data.capturedAt,
            });
          }
          const description = {
            kind: 'browser-annotation',
            browserSessionId: record.browserSessionId,
            generation: record.generation,
            viewport: record.viewport,
            coordinateSpace: 'viewport',
            marks: annotation.marks,
            images: descriptions,
            cropOrigin:
              selected && crop
                ? {
                    x: Math.max(0, selected.rect.x),
                    y: Math.max(0, selected.rect.y),
                  }
                : null,
            untrustedPageContent: {
              notice: BROWSER_PAGE_CONTENT_NOTICE,
              url: record.url,
              picked: selected ? picked : null,
            },
          };
          files.push(
            new File(
              [JSON.stringify(description, null, 2)],
              'browser-annotation.json',
              { type: 'application/json' },
            ),
          );
          await attach(files);
          if (mounted.current) onClose();
        })()
          .catch((error) => {
            if (mounted.current)
              onError(
                error instanceof Error
                  ? error.message
                  : 'Could not attach annotation.',
              );
          })
          .finally(() => {
            if (mounted.current) setPending(false);
          });
      }}
    />
  );
}
