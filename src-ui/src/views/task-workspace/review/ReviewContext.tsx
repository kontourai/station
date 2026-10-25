import type { TaskReviewArtifactRef } from '@kontourai/station-contracts/task-review';
import { createContext, useContext } from 'react';

export interface ReviewOutline {
  artifact: TaskReviewArtifactRef;
  headings: { id: string; label: string; count: number }[];
}
export const ReviewContext = createContext<
  | {
      outline?: ReviewOutline;
      setOutline: (outline: ReviewOutline | undefined) => void;
      emphasizedThread?: string;
      emphasize: (threadId: string | undefined) => void;
    }
  | undefined
>(undefined);
export const useReviewContext = () => useContext(ReviewContext);
