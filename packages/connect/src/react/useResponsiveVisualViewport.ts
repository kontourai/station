import { type CSSProperties, useEffect, useMemo, useState } from 'react';

function readViewport() {
  return {
    height: Math.max(0, window.visualViewport?.height ?? window.innerHeight),
    offsetTop: Math.max(0, window.visualViewport?.offsetTop ?? 0),
  };
}

export function useResponsiveVisualViewport() {
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    const source = window.visualViewport ?? window;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewport(readViewport()));
    };
    source.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      source.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);

  return useMemo(
    () =>
      ({
        '--responsive-visual-viewport-height': `${viewport.height}px`,
        '--responsive-visual-viewport-top': `${viewport.offsetTop}px`,
      }) as CSSProperties,
    [viewport],
  );
}
