#!/usr/bin/env tsx
/**
 * Dev-only decoder shadow for real Claude Code JSONL transcripts.
 *
 * Usage:
 *   npx tsx scripts/ferry-claude-shadow.ts [--config-dir ~/.claude] [--count 5]
 *
 * The production probe deliberately uses ClaudeTranscriptSessionSource defaults.
 * The semantic comparison then raises only its byte/event caps so both decoders
 * can see the same complete file; it retains Station's line cap and mapper.
 * No Station production code imports this file.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createClaudeCodeImporter } from '@kontourai/ferry';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { ClaudeTranscriptSessionSource } from '../src-server/providers/sessions/claude-transcript-session-source.js';

const DEFAULT_EXAMPLES = 3;
const DEFAULT_COUNT = 5;
type FerryMessage = ReturnType<
  ReturnType<typeof createClaudeCodeImporter>['thread']
>['messages'][number];

interface Options {
  configDir: string;
  count: number;
  examples: number;
}

interface Candidate {
  path: string;
  sessionId: string;
  size: number;
  modifiedAt: number;
}

interface Header {
  sessionId?: string;
  stationEligible: boolean;
  ferryEligible: boolean;
}

interface Fact {
  kind: 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'usage';
  key: string;
  detail: string;
}

interface Difference {
  category: string;
  index: number;
  station?: Fact;
  ferry?: Fact;
}

interface TranscriptReport {
  transcript: string;
  bytes: number;
  lines: number;
  stationProduction: { outcome: string; events: number; cursor: unknown };
  stationComparison: { outcome: string; events: number };
  ferry: { messages: number; announced: number; errors: string[] };
  categories: Record<string, number>;
  examples: Difference[];
}

function parseArgs(argv: readonly string[]): Options {
  let configDir = join(homedir(), '.claude');
  let count = DEFAULT_COUNT;
  let examples = DEFAULT_EXAMPLES;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--config-dir' && value) {
      configDir = resolve(value);
      index += 1;
    } else if (argument === '--count' && value) {
      count = positiveInteger(value, '--count');
      index += 1;
    } else if (argument === '--examples' && value) {
      examples = positiveInteger(value, '--examples');
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return { configDir, count, examples };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} requires a positive integer`);
  }
  return parsed;
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value))
    .digest('hex')
    .slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function redacted(value: unknown): string {
  const serialized = typeof value === 'string' ? value : stableJson(value);
  return `len=${serialized.length} sha256=${digest(serialized)}`;
}

function candidateLabel(configDir: string, file: string): string {
  return `transcript:${digest(relative(join(configDir, 'projects'), file))}`;
}

function transcriptCandidates(configDir: string): Candidate[] {
  const root = join(configDir, 'projects');
  const found: Candidate[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = lstatSync(path);
        const header = transcriptHeader(path);
        if (!header.stationEligible || !header.ferryEligible) continue;
        const sessionId = header.sessionId ?? basename(path, '.jsonl');
        found.push({
          path,
          sessionId,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        // Station is authoritative for source acceptance; this only selects IDs.
      }
    }
  };
  visit(root);
  return found;
}

function transcriptHeader(path: string): Header {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .split('\n', 1)[0];
    const parsed = JSON.parse(firstLine) as {
      type?: unknown;
      cwd?: unknown;
      message?: { role?: unknown };
      sessionId?: unknown;
    };
    const sessionId =
      typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined;
    return {
      sessionId,
      stationEligible: Boolean(sessionId && typeof parsed.cwd === 'string'),
      ferryEligible:
        (parsed.type === 'user' || parsed.type === 'assistant') &&
        parsed.message?.role === parsed.type,
    };
  } catch {
    return { stationEligible: false, ferryEligible: false };
  } finally {
    closeSync(descriptor);
  }
}

function chooseCandidates(
  candidates: readonly Candidate[],
  count: number,
): Candidate[] {
  const newest = [...candidates].sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt || right.size - left.size,
  );
  const largest = [...candidates].sort(
    (left, right) => right.size - left.size,
  )[0];
  const selected = largest ? [largest] : [];
  for (const candidate of newest) {
    if (selected.length >= count) break;
    if (!selected.some((item) => item.sessionId === candidate.sessionId)) {
      selected.push(candidate);
    }
  }
  return selected;
}

async function ferryFacts(path: string): Promise<{
  facts: Fact[];
  lines: number;
  messages: number;
  announced: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const importer = createClaudeCodeImporter({
    // Station maps sidechain records; include them so this is a decoder
    // comparison rather than Ferry's default presentation filter.
    includeSidechains: true,
    onWarn: (warning) => errors.push(warning),
  });
  let lines = 0;
  let announced = 0;
  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    lines += 1;
    announced += importer.pushLines([line]).length;
  }
  announced += importer.finalize().length;
  try {
    const thread = importer.thread();
    return {
      facts: factsFromFerry(thread.messages),
      lines,
      messages: thread.messages.length,
      announced,
      errors,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { facts: [], lines, messages: 0, announced, errors };
  }
}

function factsFromStation(events: readonly CanonicalRuntimeEvent[]): Fact[] {
  const facts: Fact[] = [];
  for (const event of events) {
    if (event.method === 'content.text-delta') {
      facts.push({
        kind: 'text',
        key: digest(event.delta),
        detail: redacted(event.delta),
      });
    } else if (event.method === 'content.reasoning-delta') {
      facts.push({
        kind: 'reasoning',
        key: digest(event.delta),
        detail: redacted(event.delta),
      });
    } else if (event.method === 'tool.started') {
      facts.push({
        kind: 'tool-call',
        key: `${event.toolCallId}:${event.toolName}:${digest(event.arguments)}`,
        detail: `id=${event.toolCallId} name=${event.toolName} args(${redacted(event.arguments)})`,
      });
    } else if (event.method === 'tool.completed') {
      facts.push({
        kind: 'tool-result',
        key: event.toolCallId,
        detail: `call=${event.toolCallId}`,
      });
    }
  }
  return facts;
}

function factsFromFerry(messages: readonly FerryMessage[]): Fact[] {
  const facts: Fact[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const content of message.content) {
        if (content.type === 'text') {
          facts.push({
            kind: 'text',
            key: digest(content.text),
            detail: redacted(content.text),
          });
        } else if (content.type === 'reasoning') {
          const reasoning = content.reasoning;
          const marker =
            reasoning.text ?? stableJson(reasoning.providerMetadata ?? {});
          facts.push({
            kind: 'reasoning',
            key: digest(marker),
            detail: `text(${redacted(marker)}) signature=${reasoning.signature ? 'present' : 'absent'}`,
          });
        } else if (content.type === 'tool_call') {
          const call = content.toolCall;
          facts.push({
            kind: 'tool-call',
            key: `${call.id}:${call.name}:${digest(call.parsedArguments ?? call.arguments)}`,
            detail: `id=${call.id} name=${call.name} args(${redacted(call.parsedArguments ?? call.arguments)})`,
          });
        }
      }
      if (message.usage) {
        facts.push({
          kind: 'usage',
          key: stableJson(message.usage),
          detail: redacted(message.usage),
        });
      }
    } else if (message.role === 'tool') {
      for (const result of message.toolResults) {
        facts.push({
          kind: 'tool-result',
          key: result.toolCallId,
          detail: `call=${result.toolCallId}`,
        });
      }
    }
  }
  return facts;
}

function compare(
  station: readonly Fact[],
  ferry: readonly Fact[],
): Difference[] {
  const differences: Difference[] = [];
  const kinds: Fact['kind'][] = [
    'text',
    'tool-call',
    'tool-result',
    'reasoning',
    'usage',
  ];
  for (const kind of kinds) {
    const stationFacts = station.filter((fact) => fact.kind === kind);
    const ferryFacts = ferry.filter((fact) => fact.kind === kind);
    const length = Math.max(stationFacts.length, ferryFacts.length);
    for (let index = 0; index < length; index += 1) {
      const stationFact = stationFacts[index];
      const ferryFact = ferryFacts[index];
      if (!stationFact) {
        differences.push({
          category: `ferry-only-${kind}`,
          index,
          ferry: ferryFact,
        });
      } else if (!ferryFact) {
        differences.push({
          category: `station-only-${kind}`,
          index,
          station: stationFact,
        });
      } else if (stationFact.key !== ferryFact.key) {
        differences.push({
          category: `${kind}-mismatch`,
          index,
          station: stationFact,
          ferry: ferryFact,
        });
      }
    }
  }
  compareToolOrdering(station, ferry, differences);
  return differences;
}

function compareToolOrdering(
  station: readonly Fact[],
  ferry: readonly Fact[],
  differences: Difference[],
): void {
  const stationOrder = station
    .filter((fact) => fact.kind === 'tool-call' || fact.kind === 'tool-result')
    .map((fact) => `${fact.kind}:${fact.key}`);
  const ferrySet = new Set(
    ferry
      .filter(
        (fact) => fact.kind === 'tool-call' || fact.kind === 'tool-result',
      )
      .map((fact) => `${fact.kind}:${fact.key}`),
  );
  const commonStation = stationOrder.filter((item) => ferrySet.has(item));
  const stationSet = new Set(commonStation);
  const commonFerry = ferry
    .filter((fact) => fact.kind === 'tool-call' || fact.kind === 'tool-result')
    .map((fact) => `${fact.kind}:${fact.key}`)
    .filter((item) => stationSet.has(item));
  for (
    let index = 0;
    index < Math.min(commonStation.length, commonFerry.length);
    index += 1
  ) {
    if (commonStation[index] !== commonFerry[index]) {
      differences.push({
        category: 'tool-lifecycle-ordering',
        index,
        station: {
          kind: 'tool-call',
          key: commonStation[index],
          detail: 'common lifecycle fact',
        },
        ferry: {
          kind: 'tool-call',
          key: commonFerry[index],
          detail: 'common lifecycle fact',
        },
      });
      return;
    }
  }
}

function formatDifference(difference: Difference): string {
  const station = difference.station
    ? `${difference.station.kind} ${difference.station.detail}`
    : 'none';
  const ferry = difference.ferry
    ? `${difference.ferry.kind} ${difference.ferry.detail}`
    : 'none';
  return `  - #${difference.index}: station=[${station}] ferry=[${ferry}]`;
}

async function reportTranscript(
  configDir: string,
  candidate: Candidate,
  examples: number,
): Promise<TranscriptReport> {
  const staging = stageTranscript(candidate.path);
  try {
    const production = new ClaudeTranscriptSessionSource({
      configDir: staging.configDir,
    });
    const productionDiscovery = await production.discover();
    const productionDescriptor = productionDiscovery.sessions[0];
    const comparison = new ClaudeTranscriptSessionSource({
      configDir: staging.configDir,
      maxBytes: candidate.size,
      maxEvents: Number.MAX_SAFE_INTEGER,
    });
    const comparisonDiscovery = await comparison.discover();
    const comparisonDescriptor = comparisonDiscovery.sessions[0];
    if (!productionDescriptor || !comparisonDescriptor) {
      throw new Error(
        `Station rejected staged transcript during discovery (production=${productionDiscovery.outcome}, comparison=${comparisonDiscovery.outcome})`,
      );
    }
    const productionRead = await production.read(productionDescriptor);
    const comparisonRead = await comparison.read(comparisonDescriptor);
    const ferry = await ferryFacts(candidate.path);
    const differences = compare(
      factsFromStation(comparisonRead.events),
      ferry.facts,
    );
    const categories: Record<string, number> = {};
    for (const difference of differences) {
      categories[difference.category] =
        (categories[difference.category] ?? 0) + 1;
    }
    return {
      transcript: candidateLabel(configDir, candidate.path),
      bytes: candidate.size,
      lines: ferry.lines,
      stationProduction: {
        outcome: productionRead.outcome,
        events: productionRead.events.length,
        cursor: productionRead.cursor,
      },
      stationComparison: {
        outcome: comparisonRead.outcome,
        events: comparisonRead.events.length,
      },
      ferry: {
        messages: ferry.messages,
        announced: ferry.announced,
        errors: ferry.errors,
      },
      categories,
      examples: boundedExamples(differences, examples),
    };
  } finally {
    rmSync(staging.root, { recursive: true, force: true });
  }
}

function boundedExamples(
  differences: readonly Difference[],
  limit: number,
): Difference[] {
  const counts = new Map<string, number>();
  return differences.filter((difference) => {
    const count = counts.get(difference.category) ?? 0;
    if (count >= limit) return false;
    counts.set(difference.category, count + 1);
    return true;
  });
}

function stageTranscript(path: string): { root: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'station-ferry-shadow-'));
  const transcriptDirectory = join(root, 'projects', 'shadow');
  mkdirSync(transcriptDirectory, { recursive: true });
  copyFileSync(path, join(transcriptDirectory, 'transcript.jsonl'));
  return { root, configDir: root };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const candidates = transcriptCandidates(options.configDir);
  const ranked = chooseCandidates(candidates, candidates.length);
  if (ranked.length === 0)
    throw new Error('No Station-discoverable Claude transcripts found');
  const reports: TranscriptReport[] = [];
  const skipped: string[] = [];
  for (const candidate of ranked) {
    if (reports.length >= options.count) break;
    try {
      reports.push(
        await reportTranscript(options.configDir, candidate, options.examples),
      );
    } catch (error) {
      skipped.push(
        `${candidateLabel(options.configDir, candidate.path)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (reports.length === 0)
    throw new Error('Station accepted none of the selected transcripts');

  const totals: Record<string, number> = {};
  for (const report of reports) {
    for (const [category, count] of Object.entries(report.categories)) {
      totals[category] = (totals[category] ?? 0) + count;
    }
  }
  console.log('FERRY / STATION CLAUDE DECODER SHADOW (dev-only)');
  console.log(
    `files compared: ${reports.length}; lines compared: ${reports.reduce((sum, item) => sum + item.lines, 0)}`,
  );
  console.log(
    `selection: largest file plus newest readable files; source candidates: ${candidates.length}; Station-rejected candidates skipped: ${skipped.length}`,
  );
  console.log(
    'comparison mode: Station real reader with byte/event caps raised only for complete-file semantic comparison; production-default read reported separately.',
  );
  for (const skippedCandidate of skipped.slice(0, options.examples))
    console.log(`skipped: ${skippedCandidate}`);
  console.log(
    'absolute paths and transcript text are redacted as stable hashes and length only.',
  );
  console.log(
    `total categories: ${
      Object.entries(totals)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ') || 'none'
    }`,
  );
  for (const report of reports) {
    console.log(
      `\n${report.transcript} bytes=${report.bytes} lines=${report.lines}`,
    );
    console.log(
      `  Station production: outcome=${report.stationProduction.outcome} events=${report.stationProduction.events} cursor=${JSON.stringify(report.stationProduction.cursor)}`,
    );
    console.log(
      `  Station comparison: outcome=${report.stationComparison.outcome} events=${report.stationComparison.events}; Ferry: messages=${report.ferry.messages} announced=${report.ferry.announced} errors=${report.ferry.errors.length}`,
    );
    console.log(
      `  categories: ${
        Object.entries(report.categories)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ') || 'none'
      }`,
    );
    for (const error of report.ferry.errors.slice(0, options.examples))
      console.log(`  ferry warning/error: ${error}`);
    for (const example of report.examples)
      console.log(formatDifference(example));
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
