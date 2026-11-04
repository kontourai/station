import { Button } from '../Button';
import { ErrorState } from '../state';

/**
 * Why a decision on a notification row did not land, in words the reader can
 * act on, and whether trying again could help. Classified from the server's
 * own refusal text (`routes/operations/notifications.ts`) — an unknown error
 * keeps its message rather than being reworded into a guess.
 */
export function describeDecisionError(error: unknown): {
  message: string;
  retryable: boolean;
} {
  const text = error instanceof Error ? error.message : String(error ?? '');
  if (/action is (unavailable|in progress)/i.test(text))
    return {
      message:
        'Already answered, or an answer is still being recorded. Open the chat to check.',
      retryable: false,
    };
  if (/not found/i.test(text))
    return {
      message: 'This request is gone. It was probably answered or expired.',
      retryable: false,
    };
  if (
    error instanceof TypeError ||
    /failed to fetch|network|offline|ECONN/i.test(text)
  )
    return {
      message: "Couldn't reach Station. Check the connection and try again.",
      retryable: true,
    };
  return {
    message: text
      ? `Station didn't accept the decision: ${text}`
      : "Station didn't accept the decision.",
    retryable: true,
  };
}

/** A row's failed decision, on that row, with its way forward. */
export function DecisionError({
  error,
  onRetry,
  openHref,
  onOpen,
}: {
  error: unknown;
  onRetry?: () => void;
  openHref?: string;
  onOpen?: () => void;
}) {
  const { message, retryable } = describeDecisionError(error);
  return (
    <div className="decision-error" data-testid="decision-error">
      <ErrorState
        variant="compact"
        title="Decision not confirmed"
        description={message}
        action={
          retryable && onRetry ? (
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : openHref ? (
            <a
              className="decision-error__open"
              href={openHref}
              onClick={onOpen}
            >
              Open chat
            </a>
          ) : undefined
        }
      />
    </div>
  );
}
