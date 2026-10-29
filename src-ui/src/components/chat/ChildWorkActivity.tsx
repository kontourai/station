import { TerminalGlyph } from '../icons/Glyph';
import './ChildWorkActivity.css';

export function ChildWorkActivity({
  tool,
  progress,
}: {
  tool?: string;
  progress?: string;
}) {
  if (!tool && !progress) return null;
  return (
    <span className="child-work-activity">
      {tool && (
        <span
          className="child-work-activity__tool"
          title={`Latest tool: ${tool}`}
        >
          <span className="sr-only">Latest tool: </span>
          <TerminalGlyph />
          <span className="child-work-activity__name">{tool}</span>
        </span>
      )}
      {progress && (
        <span className="child-work-activity__progress">{progress}</span>
      )}
    </span>
  );
}
