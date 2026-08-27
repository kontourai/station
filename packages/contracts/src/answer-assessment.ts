import type { StationAnswerBinding } from './task-basis.js';

/** Exact opaque join retained with the assessment revision that published it. */
export interface StationReviewedSourceAssociation {
  version: 'station.reviewed-source-association/v1';
  pluginName: string;
  sourceClaimId: string;
  sourceEvidenceId: string;
  answerClaimId: string;
  answerCitationEvidenceId: string;
  owner: string;
  runId: string;
  exactRef: string;
  assessmentRevision: number;
  projectId: string;
  workspaceId: string;
  principalId: string;
}

/** Browser-safe producer wire; its exact binding is supplied by Station. */
export interface StationAnswerAssessmentPublishInput {
  expectedAnswer: StationAnswerBinding;
  publicationId: string;
  bundle: unknown;
  claimId: string;
  expectedRevision: number;
  /** Published in the same CAS commit as the answer assessment. */
  reviewedSource?: StationReviewedSourceAssociation;
}

/** Identity-only receipt; never exposes bundle bytes or storage paths. */
export interface StationAnswerAssessmentReceipt {
  sessionId: string;
  turnId: string;
  revision: number;
  active: boolean;
}

/** A producer copies this declaration onto its claim before publishing. */
export interface StationAnswerAssessmentProfileTarget {
  version: 'station.answer-content/v1';
  target: string;
  subjectType: 'station.answer-content';
  subjectId: string;
  claimType: 'station.answer-content/v1';
  metadata: {
    stationAnswerAssessment: {
      version: 'station.answer-content/v1';
      target: string;
    };
  };
}

/** Protected exact binding plus its current identity-only CAS state. */
export interface StationAnswerAssessmentReadTarget {
  expectedAnswer: StationAnswerBinding;
  profile: StationAnswerAssessmentProfileTarget;
  /** Zero means this binding has no record; otherwise this includes tombstones. */
  revision: number;
  active: boolean;
}
