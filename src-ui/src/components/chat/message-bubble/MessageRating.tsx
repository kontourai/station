import {
  useDeleteFeedbackRatingMutation,
  useFeedbackRatingsQuery,
  useSaveFeedbackRatingMutation,
} from '@kontourai/station-sdk';
import { useCallback, useEffect, useState } from 'react';
import { isComposingKeyEvent } from '../../../lib/isComposingKeyEvent';

type RatingValue = 'thumbs_up' | 'thumbs_down' | null;

const ThumbUpIcon = ({ filled }: { filled: boolean }) => (
  <svg
    aria-hidden="true"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
  </svg>
);

const ThumbDownIcon = ({ filled }: { filled: boolean }) => (
  <svg
    aria-hidden="true"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M17 14V2" />
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
  </svg>
);

interface MessageRatingProps {
  conversationId: string;
  messageIndex: number;
  messagePreview: string;
  agentSlug: string;
}

export function MessageRating({
  conversationId,
  messageIndex,
  messagePreview,
  agentSlug,
}: MessageRatingProps) {
  const [rating, setRating] = useState<RatingValue>(null);
  const [showReasonInput, setShowReasonInput] = useState(false);
  const [reasonText, setReasonText] = useState('');
  const [savedReason, setSavedReason] = useState<string | undefined>(undefined);
  const { data: ratings = [] } = useFeedbackRatingsQuery({ staleTime: 30_000 });
  const saveRatingMutation = useSaveFeedbackRatingMutation();
  const deleteRatingMutation = useDeleteFeedbackRatingMutation();

  useEffect(() => {
    const existing = ratings.find(
      (entry: any) =>
        entry.conversationId === conversationId &&
        entry.messageIndex === messageIndex,
    );
    if (!existing) {
      setRating(null);
      setSavedReason(undefined);
      return;
    }
    setRating(existing.rating);
    setSavedReason(existing.reason);
  }, [conversationId, messageIndex, ratings]);

  const submitRating = useCallback(
    async (value: RatingValue, reason?: string) => {
      try {
        if (value) {
          await saveRatingMutation.mutateAsync({
            agentSlug,
            conversationId,
            messageIndex,
            messagePreview,
            rating: value,
            ...(reason ? { reason } : {}),
          });
        } else {
          await deleteRatingMutation.mutateAsync({
            conversationId,
            messageIndex,
          });
        }
      } catch {
        throw new Error('rate failed');
      }
    },
    [
      agentSlug,
      conversationId,
      deleteRatingMutation,
      messageIndex,
      messagePreview,
      saveRatingMutation,
    ],
  );

  const handleRate = useCallback(
    async (value: RatingValue) => {
      const newRating = rating === value ? null : value;
      const previousRating = rating;
      setRating(newRating);
      if (newRating === 'thumbs_down') {
        setShowReasonInput(true);
        try {
          await submitRating(newRating);
        } catch {
          setRating(previousRating);
        }
      } else {
        setShowReasonInput(false);
        setReasonText('');
        try {
          await submitRating(newRating);
        } catch {
          setRating(previousRating);
        }
      }
    },
    [rating, submitRating],
  );

  const handleReasonSubmit = useCallback(async () => {
    if (!reasonText.trim()) {
      setShowReasonInput(false);
      return;
    }
    const reason = reasonText.trim();
    try {
      await submitRating(rating, reason);
      setSavedReason(reason);
    } catch {
      // Keep input open on save failure.
    }
    setShowReasonInput(false);
    setReasonText('');
  }, [rating, reasonText, submitRating]);

  return (
    <span className="message__rating">
      <button
        type="button"
        className={`message__rating-btn${rating === 'thumbs_up' ? ' message__rating-btn--active' : ''}`}
        onClick={() => handleRate('thumbs_up')}
        title="Good response"
        aria-label="Good response"
        aria-pressed={rating === 'thumbs_up'}
      >
        <ThumbUpIcon filled={rating === 'thumbs_up'} />
      </button>
      <button
        type="button"
        className={`message__rating-btn${rating === 'thumbs_down' ? ' message__rating-btn--active' : ''}`}
        onClick={() => handleRate('thumbs_down')}
        title="Bad response"
        aria-label="Bad response"
        aria-pressed={rating === 'thumbs_down'}
      >
        <ThumbDownIcon filled={rating === 'thumbs_down'} />
      </button>
      <span
        className={`message__rating-expand${showReasonInput ? ' message__rating-expand--open' : ''}`}
      >
        {showReasonInput ? (
          <input
            className="message__rating-reason"
            placeholder="Why? (optional)"
            maxLength={100}
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isComposingKeyEvent(event))
                handleReasonSubmit();
              if (event.key === 'Escape') {
                setShowReasonInput(false);
                setReasonText('');
              }
            }}
            onBlur={handleReasonSubmit}
          />
        ) : savedReason ? (
          <span className="message__rating-reason-label" title={savedReason}>
            {savedReason}
          </span>
        ) : null}
      </span>
    </span>
  );
}
