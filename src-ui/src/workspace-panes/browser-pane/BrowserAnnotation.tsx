import type {
  BrowserPickedElementView,
  BrowserViewportView,
} from '@kontourai/station-contracts/workspace-browser-pane';
import {
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '../../components/Button';
import { mapClientPointToSurface } from '../../live-surface/liveSurfaceGeometry';
import type { BrowserPaneApi } from './browserPaneApi';
import './BrowserAnnotation.css';

type Point = { x: number; y: number };
type Mark = { kind: 'box' | 'draw'; points: Point[] };
type Tool = 'select' | 'box' | 'draw' | 'erase';
const MAX_MARKS = 50;
const MAX_POINTS = 1000;

function nearMark(mark: Mark, point: Point): boolean {
  if (mark.kind === 'box') {
    const start = mark.points[0]!;
    const end = mark.points.at(-1)!;
    return (
      point.x >= Math.min(start.x, end.x) - 8 &&
      point.x <= Math.max(start.x, end.x) + 8 &&
      point.y >= Math.min(start.y, end.y) - 8 &&
      point.y <= Math.max(start.y, end.y) + 8
    );
  }
  return mark.points.some(
    (p) => Math.hypot(p.x - point.x, p.y - point.y) <= 12,
  );
}
export interface BrowserAnnotationValue {
  picked: BrowserPickedElementView | null;
  marks: Mark[];
}

export function BrowserAnnotation({
  stageRef,
  viewport,
  generation,
  sessionId,
  api,
  onCancel,
  onAttach,
  pending,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  viewport: BrowserViewportView;
  generation: number;
  sessionId: string;
  api: BrowserPaneApi;
  onCancel(): void;
  onAttach(value: BrowserAnnotationValue): void;
  pending: boolean;
}) {
  const [tool, setTool] = useState<Tool>('select');
  const [picked, setPicked] = useState<BrowserPickedElementView | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const draftRef = useRef<Mark | null>(null);
  const alive = useRef(true);
  const pickSequence = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = stage?.querySelector('canvas');
    if (!stage || !canvas) return;
    const update = () => {
      const outer = stage.getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(
        rect.width / viewport.width,
        rect.height / viewport.height,
      );
      if (!Number.isFinite(scale) || scale <= 0) return setBox(null);
      const width = viewport.width * scale;
      const height = viewport.height * scale;
      setBox({
        left: rect.left - outer.left + (rect.width - width) / 2,
        top: rect.top - outer.top + (rect.height - height) / 2,
        width,
        height,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    observer.observe(canvas);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [stageRef, viewport.width, viewport.height]);
  const attach = () => {
    if (!pending && (picked || marks.length)) onAttach({ picked, marks });
  };
  useEffect(() => {
    root.current?.focus();
  }, []);
  const point = (event: PointerEvent<SVGSVGElement>, clamp = false) => {
    const canvas = stageRef.current?.querySelector('canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return mapClientPointToSurface(
      { x: event.clientX, y: event.clientY },
      rect,
      { width: viewport.width, height: viewport.height, deviceScaleFactor: 1 },
      { clamp },
    );
  };
  return (
    <div
      className="browser-annotation"
      ref={root}
      role="group"
      aria-label="Browser annotation"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const key = event.key.toLowerCase();
        const keys: Record<string, Tool> = {
          s: 'select',
          b: 'box',
          d: 'draw',
          e: 'erase',
        };
        if (keys[key]) {
          event.preventDefault();
          pickSequence.current++;
          setTool(keys[key]);
        } else if (key === 'escape') {
          event.preventDefault();
          if (!pending) onCancel();
        } else if (key === 'enter' && event.target === event.currentTarget) {
          event.preventDefault();
          attach();
        }
      }}
    >
      <div
        className="browser-annotation__tools"
        role="toolbar"
        aria-label="Annotation tools"
      >
        {(['select', 'box', 'draw', 'erase'] as const).map((name) => (
          <Button
            key={name}
            size="sm"
            aria-pressed={tool === name}
            onClick={() => {
              pickSequence.current++;
              setTool(name);
            }}
          >
            {name[0]!.toUpperCase() + name.slice(1)}
          </Button>
        ))}
        <Button
          size="sm"
          disabled={pending || (!picked && marks.length === 0)}
          onClick={attach}
        >
          Attach
        </Button>
        <Button size="sm" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error ? <p role="status">{error}</p> : null}
      {box ? (
        <svg
          className="browser-annotation__surface"
          style={box}
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          aria-label="Annotate browser page"
          onPointerDown={(event) => {
            const at = point(event);
            if (!at) return;
            root.current?.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            if (tool === 'select') {
              setError(null);
              const sequence = ++pickSequence.current;
              void api.pick(sessionId, at, generation, true).then(
                (result) => {
                  if (alive.current && sequence === pickSequence.current)
                    setPicked(result);
                },
                () => {
                  if (alive.current && sequence === pickSequence.current)
                    setError('Could not inspect this element. Try again.');
                },
              );
            } else if (tool === 'erase') {
              pickSequence.current++;
              let index = marks.length - 1;
              while (index >= 0 && !nearMark(marks[index]!, at)) index--;
              if (index >= 0)
                setMarks((current) => current.filter((_, i) => i !== index));
              else if (
                picked &&
                at.x >= picked.rect.x &&
                at.x <= picked.rect.x + picked.rect.width &&
                at.y >= picked.rect.y &&
                at.y <= picked.rect.y + picked.rect.height
              )
                setPicked(null);
            } else {
              if (marks.length >= MAX_MARKS) {
                setError('Remove an annotation before adding another.');
                return;
              }
              const next: Mark = { kind: tool, points: [at] };
              draftRef.current = next;
              setDraft(next);
            }
          }}
          onPointerMove={(event) => {
            const current = draftRef.current;
            if (!current) return;
            if (current.kind === 'draw' && current.points.length >= MAX_POINTS)
              return;
            const at = point(event, true);
            if (!at) return;
            const next = {
              ...current,
              points:
                current.kind === 'box'
                  ? [current.points[0]!, at]
                  : [...current.points, at],
            };
            draftRef.current = next;
            setDraft(next);
          }}
          onPointerUp={() => {
            const current = draftRef.current;
            if (current && current.points.length > 1)
              setMarks((previous) => [...previous, current]);
            draftRef.current = null;
            setDraft(null);
          }}
          onPointerCancel={() => {
            draftRef.current = null;
            setDraft(null);
          }}
        >
          {picked ? (
            <rect
              x={picked.rect.x}
              y={picked.rect.y}
              width={picked.rect.width}
              height={picked.rect.height}
            />
          ) : null}
          {[...marks, ...(draft ? [draft] : [])].map((mark, index) =>
            mark.kind === 'box' ? (
              <rect
                key={index}
                x={Math.min(mark.points[0]!.x, mark.points.at(-1)!.x)}
                y={Math.min(mark.points[0]!.y, mark.points.at(-1)!.y)}
                width={Math.abs(mark.points.at(-1)!.x - mark.points[0]!.x)}
                height={Math.abs(mark.points.at(-1)!.y - mark.points[0]!.y)}
              />
            ) : (
              <polyline
                key={index}
                points={mark.points.map((p) => `${p.x},${p.y}`).join(' ')}
              />
            ),
          )}
        </svg>
      ) : null}
    </div>
  );
}
