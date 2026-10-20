/** Shared, head-bound reading tour. Guide text is untrusted model output. */
export interface PullRequestReviewGuideExcerpt {
  path: string;
  side: 'new' | 'old';
  start: number;
  end: number;
  caption: string;
}
export interface PullRequestReviewGuideStop {
  title: string;
  summary: string;
  attention: {
    kind: 'tradeoff' | 'contract' | 'product' | 'risk' | 'accessibility';
    note: string;
  } | null;
  excerpts: PullRequestReviewGuideExcerpt[];
  files: { path: string; note?: string }[];
  notes: { path: string; line: number; title: string; body: string }[];
  questions: string[];
}
export interface PullRequestReviewGuide {
  headSha: string;
  generatedAt: string;
  modelSelection: string;
  stops: PullRequestReviewGuideStop[];
}
export type PullRequestReviewGuideRun =
  | { state: 'Running'; headSha: string; startedAt: string }
  | { state: 'Failed'; headSha: string; failedAt: string; detail: string };
export interface PullRequestReviewGuideResult {
  guide: PullRequestReviewGuide | null;
  run: PullRequestReviewGuideRun | null;
  currentHeadSha: string | null;
  excerptContents: {
    path: string;
    side: 'new' | 'old';
    start: number;
    lines: string[];
  }[];
}
