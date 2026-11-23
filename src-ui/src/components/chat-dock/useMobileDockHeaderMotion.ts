import { useLayoutEffect, useRef } from 'react';
import { motionTokenMs, prefersReducedMotion } from '../../lib/reduced-motion';

function titleBox(header: HTMLElement) {
  const title =
    header.querySelector('.chat-dock__open-inbox-label') ??
    header.querySelector('.chat-dock__mobile-title-text');
  if (!title || typeof Range.prototype.getBoundingClientRect !== 'function')
    return undefined;
  const range = document.createRange();
  range.selectNodeContents(title);
  return { left: range.getBoundingClientRect().left, text: title.textContent };
}

/** Animate an explicit snap. Keyboard and viewport resizes still take effect immediately. */
export function useMobileDockHeaderMotion(snap: string) {
  const headerRef = useRef<HTMLDivElement>(null);
  const start = useRef<{
    snap: string;
    top: number;
    title: ReturnType<typeof titleBox>;
  } | null>(null);
  const capture = () => {
    const header = headerRef.current;
    if (!header || prefersReducedMotion() || !header.animate) return;
    start.current = {
      snap,
      top: header.getBoundingClientRect().top,
      title: titleBox(header),
    };
  };
  useLayoutEffect(() => {
    const header = headerRef.current;
    const dock = header?.closest<HTMLElement>('.chat-dock');
    const prior = start.current;
    start.current = null;
    if (
      !dock ||
      !header ||
      !prior ||
      snap === prior.snap ||
      prefersReducedMotion()
    )
      return;
    const style = getComputedStyle(header);
    const timing = {
      duration: motionTokenMs(style, '--motion-base'),
      easing: style.getPropertyValue('--ease-standard').trim() || 'ease',
    };
    const animations: Animation[] = [];
    if (snap === 'full') {
      const dy = prior.top - header.getBoundingClientRect().top;
      if (dy)
        animations.push(
          dock.animate(
            [{ translate: `0 ${dy}px` }, { translate: '0 0' }],
            timing,
          ),
        );
    }
    const title = titleBox(header);
    const label = header.querySelector<HTMLElement>(
      '.chat-dock__mobile-title-text',
    );
    if (label && title && prior.title && title.text === prior.title.text) {
      const dx = prior.title.left - title.left;
      if (dx)
        animations.push(
          label.animate(
            [{ translate: `${dx}px 0` }, { translate: '0 0' }],
            timing,
          ),
        );
    }
    const stop = () => animations.forEach((animation) => animation.cancel());
    window.addEventListener('resize', stop);
    window.visualViewport?.addEventListener('resize', stop);
    return () => {
      stop();
      window.removeEventListener('resize', stop);
      window.visualViewport?.removeEventListener('resize', stop);
    };
  }, [snap]);
  return { headerRef, capture };
}
