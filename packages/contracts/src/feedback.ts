/** Server-verified immutable target; an index or preview is never target authority. */
export interface FeedbackRatingTarget {
  conversationId: string;
  sessionId: string;
  turnId: string;
  contentDigest: string;
}
export interface FeedbackRatingRecord {
  id: string;
  agentSlug: string;
  conversationId: string;
  messageIndex: number;
  messagePreview: string;
  rating: 'thumbs_up' | 'thumbs_down';
  reason?: string;
  analysis?: string;
  createdAt: string;
  analyzedAt?: string;
  target?: FeedbackRatingTarget;
}
