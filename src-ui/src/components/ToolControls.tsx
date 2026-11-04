import type { ReactNode } from 'react';
import './ToolControls.css';

/** Contextual controls stay within their tool's scroll and keyboard boundary. */
export function ToolControls({ children }: { children: ReactNode }) {
  return <div className="tool-controls">{children}</div>;
}
