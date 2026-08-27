export type ContextSafetySeverity = 'block';
export type ContextSafetyProfile = 'full' | 'hidden-only';

export interface ContextSafetyFinding {
  excerpt: string;
  message: string;
  ruleId: string;
  severity: ContextSafetySeverity;
}

export interface ContextSafetyScanResult {
  blocked: boolean;
  findings: ContextSafetyFinding[];
  source: string;
}

interface ContextSafetyRule {
  message: string;
  pattern: RegExp;
  profiles: readonly ContextSafetyProfile[];
  ruleId: string;
  severity: ContextSafetySeverity;
}

interface ContextSafetyOptions {
  profile?: ContextSafetyProfile;
  source: string;
}

const CONTEXT_SAFETY_RULES: readonly ContextSafetyRule[] = [
  {
    message:
      'Contains language that attempts to override higher-priority instructions.',
    pattern:
      /\b(ignore|disregard|forget|override|bypass|skip)\b[\s\S]{0,80}\b(previous|prior|earlier|above|all)\b[\s\S]{0,40}\b(instructions?|messages?|prompts?|guardrails?)\b/i,
    profiles: ['full'],
    ruleId: 'instruction-override',
    severity: 'block',
  },
  {
    message:
      'Contains language that attempts to reveal hidden prompts or secrets.',
    pattern:
      /\b(reveal|print|dump|show|return|exfiltrate|leak)\b[\s\S]{0,80}\b(system prompt|developer message|hidden instructions?|secrets?|api keys?|tokens?|credentials?)\b/i,
    profiles: ['full'],
    ruleId: 'secret-exfiltration',
    severity: 'block',
  },
  {
    message: 'Contains language that attempts to bypass approvals or safety.',
    pattern:
      /\b(disable|bypass|skip|ignore)\b[\s\S]{0,80}\b(approvals?|permissions?|safety|guardrails?|policy|sandbox)\b/i,
    profiles: ['full'],
    ruleId: 'safety-bypass',
    severity: 'block',
  },
  {
    message: 'Contains hidden HTML comments with instruction-like content.',
    pattern:
      /<!--[\s\S]{0,400}\b(ignore|disregard|reveal|exfiltrate|bypass|disable)\b[\s\S]{0,400}-->/i,
    profiles: ['full', 'hidden-only'],
    ruleId: 'hidden-comment-instruction',
    severity: 'block',
  },
  {
    message: 'Contains invisible Unicode characters that can hide content.',
    pattern: /[\u200B-\u200F\u2060\uFEFF]/,
    profiles: ['full', 'hidden-only'],
    ruleId: 'invisible-unicode',
    severity: 'block',
  },
];

export class ContextSafetyError extends Error {
  readonly findings: ContextSafetyFinding[];
  readonly source: string;

  constructor(result: ContextSafetyScanResult) {
    super(buildContextSafetyMessage(result));
    this.name = 'ContextSafetyError';
    this.findings = result.findings;
    this.source = result.source;
  }
}

export function scanContextText(
  text: string,
  options: ContextSafetyOptions,
): ContextSafetyScanResult {
  const profile = options.profile ?? 'full';
  const findings = CONTEXT_SAFETY_RULES.flatMap((rule) => {
    if (!rule.profiles.includes(profile)) {
      return [];
    }
    const match = rule.pattern.exec(text);
    if (!match) {
      return [];
    }

    return [
      {
        excerpt: excerptAround(text, match.index, match[0].length),
        message: rule.message,
        ruleId: rule.ruleId,
        severity: rule.severity,
      } satisfies ContextSafetyFinding,
    ];
  });

  const result = {
    blocked: findings.length > 0,
    findings,
    source: options.source,
  } satisfies ContextSafetyScanResult;

  recordContextSafetyMetrics(result);

  return result;
}

export function assertSafeContextText(
  text: string,
  options: ContextSafetyOptions,
): void {
  const result = scanContextText(text, options);
  if (result.blocked) {
    throw new ContextSafetyError(result);
  }
}

export function isContextSafetyError(
  error: unknown,
): error is ContextSafetyError {
  return error instanceof ContextSafetyError;
}

function buildContextSafetyMessage(result: ContextSafetyScanResult): string {
  const summary = result.findings
    .map((finding) => `${finding.ruleId}: ${finding.excerpt}`)
    .join('; ');
  return `Blocked potentially unsafe context in ${result.source}. ${summary}`;
}

function excerptAround(
  text: string,
  startIndex: number,
  matchLength: number,
): string {
  const start = Math.max(0, startIndex - 30);
  const end = Math.min(text.length, startIndex + matchLength + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function recordContextSafetyMetrics(result: ContextSafetyScanResult): void {
  void import('../../telemetry/metrics.js')
    .then((telemetry) => {
      telemetry.contextSafetyScans?.add?.(1, {
        blocked: result.blocked ? 'true' : 'false',
      });
      for (const finding of result.findings) {
        telemetry.contextSafetyFindings?.add?.(1, {
          rule: finding.ruleId,
          severity: finding.severity,
        });
      }
    })
    .catch(() => undefined);
}
