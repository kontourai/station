import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  captureReviewFile,
  LEARNING_MEDIA_MANIFEST,
  REVIEW_LEDGER_DIR,
  REVIEW_LEDGER_INDEX,
  recordFile,
  serializeCaptureReviewFile,
  serializeLedgerIndex,
  serializeRecordFile,
} from '../../lib/review-ledger-store.mjs';

/** A revision placeholder for fixtures that never resolve revisions. */
const FIXTURE_REVISION = 'a'.repeat(40);

type Binding = { path: string; digest: string; revision?: string };

export type FixtureRecord = {
  path: string;
  kind: string;
  state: string;
  summary: string;
  limits: string;
  documentDigest: string;
  documentRevision?: string;
  sources: Binding[];
  checks: string[];
};

export type FixtureCapture = Record<string, unknown> & {
  path: string;
  sources: Binding[];
  reviewNotes?: string[];
};

const withRevision = (revision: string) => (source: Binding) => ({
  path: source.path,
  digest: source.digest,
  revision: source.revision ?? revision,
});

/** The review ledger files the real serializer writes (#2936), path -> text. */
function reviewLedgerFiles(
  records: FixtureRecord[],
  { coverageBaseline }: { coverageBaseline?: string } = {},
) {
  const files = new Map<string, string>([
    [REVIEW_LEDGER_INDEX, serializeLedgerIndex({ coverageBaseline })],
  ]);
  for (const record of records) {
    const revision = record.documentRevision ?? FIXTURE_REVISION;
    files.set(
      recordFile(record.path),
      serializeRecordFile({
        path: record.path,
        kind: record.kind,
        state: record.state,
        summary: record.summary,
        limits: record.limits,
        document: { digest: record.documentDigest, revision },
        sources: record.sources.map(withRevision(revision)),
        checks: record.checks,
      }),
    );
  }
  return files;
}

/**
 * Replace the ledger directory in `root` with `records`, written in the exact
 * layout the record command produces.
 */
export function writeReviewLedger(
  root: string,
  records: FixtureRecord[],
  options: { coverageBaseline?: string } = {},
) {
  rmSync(join(root, REVIEW_LEDGER_DIR, 'records'), {
    recursive: true,
    force: true,
  });
  for (const [file, text] of reviewLedgerFiles(records, options)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/**
 * Write capture metadata to media.json and each capture's review to the
 * ledger directory. Returns the media.json text.
 */
export function writeLearningMedia(
  root: string,
  captures: FixtureCapture[],
  revision = FIXTURE_REVISION,
) {
  const metadata = captures.map(
    ({ sources: _sources, reviewNotes: _notes, reviewedRevision, ...rest }) =>
      rest,
  );
  const text = `${JSON.stringify(
    { version: 1, captures: metadata },
    null,
    2,
  ).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )}\n`;
  mkdirSync(dirname(join(root, LEARNING_MEDIA_MANIFEST)), { recursive: true });
  writeFileSync(join(root, LEARNING_MEDIA_MANIFEST), text);
  for (const capture of captures) {
    const file = join(root, captureReviewFile(capture.path));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      serializeCaptureReviewFile({
        path: capture.path,
        sources: capture.sources.map(
          withRevision(
            typeof capture.reviewedRevision === 'string'
              ? capture.reviewedRevision
              : revision,
          ),
        ),
        reviewNotes: capture.reviewNotes ?? [],
      }),
    );
  }
  return text;
}
