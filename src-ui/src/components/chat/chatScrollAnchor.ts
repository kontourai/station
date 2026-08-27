export interface ChatScrollAnchor {
  key: string;
  offset: number;
}

const MESSAGE_SELECTOR = '[data-chat-message-key]';

export function captureChatScrollAnchor(
  container: HTMLElement,
): ChatScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  for (const node of container.querySelectorAll<HTMLElement>(
    MESSAGE_SELECTOR,
  )) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > containerTop) {
      return {
        key: node.dataset.chatMessageKey ?? '',
        offset: rect.top - containerTop,
      };
    }
  }
  return null;
}

export function restoreChatScrollAnchor(
  container: HTMLElement,
  anchor: ChatScrollAnchor,
) {
  const node = Array.from(
    container.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR),
  ).find((candidate) => candidate.dataset.chatMessageKey === anchor.key);
  if (!node) return false;
  const currentOffset =
    node.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += currentOffset - anchor.offset;
  return true;
}

export interface ResizeReanchorGate {
  /**
   * Returns true when `height` has moved far enough from the baseline
   * (the height at the last *accepted* reanchor, not merely the last
   * observer callback) to warrant a reanchor, and rebases the baseline in
   * that case. Returning false leaves the baseline untouched, so several
   * consecutive sub-threshold deltas correctly accumulate — see the
   * accumulation regression this fixes below.
   */
  shouldReanchor(height: number): boolean;
}

/**
 * Guards ChatMessageList's ResizeObserver-driven scroll re-anchor behind a
 * minimum-delta threshold. A composer auto-resize (or, on mobile, the
 * visualViewport keyboard animation — see useMobileVisualViewport.ts, which
 * emits several small incremental resize events) can fire the observer many
 * times for one logical resize; treating each callback's delta against the
 * *previous callback's* height (rather than the last accepted reanchor's
 * height) silently drops sub-threshold increments and lets the anchor go
 * stale — several 2px deltas can sum past the threshold without ever
 * triggering a reanchor, after which `restoreChatScrollAnchor` misapplies
 * by the whole missed sum. Rebasing only on acceptance fixes that.
 */
export function createResizeReanchorGate(
  initialHeight: number,
  thresholdPx: number,
): ResizeReanchorGate {
  let heightAtLastReanchor = initialHeight;
  return {
    shouldReanchor(height: number): boolean {
      if (Math.abs(height - heightAtLastReanchor) < thresholdPx) {
        return false;
      }
      heightAtLastReanchor = height;
      return true;
    },
  };
}
