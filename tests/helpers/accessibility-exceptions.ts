export type AccessibilityException = {
  surface: string;
  ruleId: string;
  target: string;
  owner: string;
  reason: string;
  expires: string;
};

// Exceptions must name one surface, Axe rule, and exact target; have an accountable owner,
// explain why an immediate fix is unsafe, and expire. Keep this empty whenever
// possible: automated coverage is valuable only when debt cannot become silent.
export const ACCESSIBILITY_EXCEPTIONS: AccessibilityException[] = [];
