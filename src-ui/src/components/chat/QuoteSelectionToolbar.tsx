import { getAssistantQuoteSource } from '@kontourai/station-sdk/client';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import type { ChatMessage } from '../../types';
import {
  MAX_QUOTE_CHARS,
  quoteHref,
  type SavedAnswerQuote,
} from '../../utils/answer-quotes';
import { Button } from '../Button';

interface Candidate {
  sessionId: string;
  turnId: string;
  messageId: string;
  excerpt: string;
  sourceText: string;
  left: number;
  top: number;
}

export function QuoteSelectionToolbar({
  container,
  messages,
  onQuote,
}: {
  container: RefObject<HTMLDivElement | null>;
  messages: readonly ChatMessage[];
  onQuote: (quote: SavedAnswerQuote) => void;
}) {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const rows = useRef(messages);
  rows.current = messages;
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        setCandidate(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const element =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const source = element?.closest<HTMLElement>(
        '[data-quote-source-message]',
      );
      if (
        !source ||
        !container.current?.contains(source) ||
        !source.contains(range.endContainer)
      ) {
        setCandidate(null);
        return;
      }
      if (
        [...source.querySelectorAll('button')].some((button) =>
          range.intersectsNode(button),
        )
      ) {
        setCandidate(null);
        return;
      }
      const message = rows.current.find(
        (row) => row.id === source.dataset.quoteSourceMessage,
      );
      if (
        !message?.answerEligible ||
        !message.id ||
        !message.sessionId ||
        !message.turnId ||
        message.role !== 'assistant'
      ) {
        setCandidate(null);
        return;
      }
      const excerpt = selection.toString();
      if (!excerpt.trim() || excerpt.length > MAX_QUOTE_CHARS) {
        setCandidate(null);
        return;
      }
      const box = range.getBoundingClientRect();
      const viewport = container.current.getBoundingClientRect();
      if (box.bottom < viewport.top || box.top > viewport.bottom) {
        setCandidate(null);
        return;
      }
      setCandidate({
        sessionId: message.sessionId,
        turnId: message.turnId,
        messageId: message.id,
        excerpt,
        sourceText:
          message.contentParts
            ?.filter((part) => part.type === 'text')
            .map((part) => part.content ?? '')
            .join('\n') || message.content,
        left: Math.max(8, Math.min(box.left, window.innerWidth - 240)),
        top: Math.max(8, Math.min(box.bottom + 8, window.innerHeight - 80)),
      });
    };
    document.addEventListener('selectionchange', update);
    container.current?.addEventListener('scroll', update);
    const root = container.current;
    return () => {
      document.removeEventListener('selectionchange', update);
      root?.removeEventListener('scroll', update);
    };
  }, [container]);
  return candidate
    ? createPortal(
        <QuoteCaptureButton
          key={`${candidate.sessionId}:${candidate.messageId}:${candidate.excerpt}`}
          candidate={candidate}
          onQuote={onQuote}
          onDone={() => {
            setCandidate(null);
            window.getSelection()?.removeAllRanges();
          }}
        />,
        document.body,
      )
    : null;
}

function QuoteCaptureButton({
  candidate,
  onQuote,
  onDone,
}: {
  candidate: Candidate;
  onQuote: (quote: SavedAnswerQuote) => void;
  onDone: () => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const flight = useRef<AbortController | null>(null);
  const tabCaptured = useRef(false);
  useEffect(() => () => flight.current?.abort(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDone();
        return;
      }
      if (
        !tabCaptured.current &&
        event.key === 'Tab' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !button.current?.contains(document.activeElement)
      ) {
        event.preventDefault();
        tabCaptured.current = true;
        button.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onDone]);
  return (
    <div
      className="source-quote-selection"
      style={{ left: candidate.left, top: candidate.top }}
    >
      <Button
        ref={button}
        disabled={!scope?.isCurrent()}
        pending={pending}
        pendingLabel="Preparing quote…"
        onPointerDown={(event) => event.preventDefault()}
        onClick={async () => {
          if (!scope?.isCurrent() || flight.current) return;
          const controller = new AbortController();
          flight.current = controller;
          setPending(true);
          setError(null);
          try {
            const source = await getAssistantQuoteSource(
              scope.apiBase,
              candidate.sessionId,
              candidate.turnId,
              { signal: controller.signal, requestScope: scope },
            );
            if (controller.signal.aborted || !scope.isCurrent()) return;
            if (
              source.messageId !== candidate.messageId ||
              source.text !== candidate.sourceText
            )
              throw new Error(
                'The answer changed. Select text from the current answer and try again.',
              );
            const quote: SavedAnswerQuote = {
              version: 1,
              origin: scope.apiBase,
              sessionId: source.sessionId,
              turnId: source.turnId,
              messageId: source.messageId,
              revision: source.revision,
              excerpt: candidate.excerpt,
            };
            quoteHref(quote);
            onQuote(quote);
            onDone();
          } catch (cause) {
            if (!controller.signal.aborted)
              setError(
                cause instanceof Error
                  ? cause.message
                  : 'The source could not be quoted.',
              );
          } finally {
            if (!controller.signal.aborted) {
              setPending(false);
              flight.current = null;
            }
          }
        }}
      >
        Quote in reply
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
