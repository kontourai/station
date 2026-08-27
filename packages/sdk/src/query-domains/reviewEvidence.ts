import type {
  IndependentReviewRequest,
  IndependentReviewRunResult,
  ReviewEvidenceAggregate,
} from '@kontourai/station-contracts/review-evidence';
import { _getApiBase } from '../api';
import { listAllReviewReceipts, runIndependentReview } from '../client/reviews';
import { type QueryConfig, useApiMutation, useApiQuery } from '../query-core';

export const reviewEvidenceQueryKey = () => ['review-evidence'];

export async function fetchIndependentReviewReceipts(): Promise<ReviewEvidenceAggregate> {
  return listAllReviewReceipts(await _getApiBase());
}

export function useReviewEvidenceQuery(
  config?: QueryConfig<ReviewEvidenceAggregate>,
) {
  return useApiQuery(reviewEvidenceQueryKey(), fetchIndependentReviewReceipts, {
    ...config,
    staleTime: config?.staleTime ?? 15_000,
  });
}

export function useRunIndependentReviewMutation() {
  return useApiMutation<IndependentReviewRunResult, IndependentReviewRequest>(
    async (request) => runIndependentReview(await _getApiBase(), request),
    { invalidateKeys: [reviewEvidenceQueryKey()] },
  );
}
