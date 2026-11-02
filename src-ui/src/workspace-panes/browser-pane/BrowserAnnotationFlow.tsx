import type { BrowserSessionView } from '@kontourai/station-contracts/workspace-browser-pane';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { BrowserAnnotation } from './BrowserAnnotation';
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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <BrowserAnnotation
      stageRef={stageRef}
      viewport={record.viewport}
      generation={record.generation}
      sessionId={record.browserSessionId}
      api={api}
      pending={pending}
      onCancel={onClose}
      onAttach={(annotation) => {
        setPending(true);
        void (async () => {
          const attach = beginIntake(() => mounted.current);
          const { screenshot: data, ...picked } = annotation.picked ?? {};
          const blob = data
            ? new Blob(
                [
                  Uint8Array.from(atob(data), (character) =>
                    character.charCodeAt(0),
                  ),
                ],
                { type: 'image/png' },
              )
            : await api.screenshot(record.browserSessionId);
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
          const description = {
            kind: 'browser-annotation',
            browserSessionId: record.browserSessionId,
            generation: record.generation,
            viewport: record.viewport,
            url: record.url,
            imageKind: data
              ? 'target-element-crop'
              : 'target-viewport-screenshot',
            picked: annotation.picked ? picked : null,
            marks: annotation.marks,
          };
          await attach([
            new File(
              [blob],
              `browser-annotation.${blob.type === 'image/jpeg' ? 'jpg' : 'png'}`,
              { type: blob.type },
            ),
            new File(
              [JSON.stringify(description, null, 2)],
              'browser-annotation.json',
              { type: 'application/json' },
            ),
          ]);
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
