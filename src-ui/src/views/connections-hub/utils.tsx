import type {
  ConnectionReadinessEvidence,
  Prerequisite,
} from '@kontourai/station-contracts/tool';
import type { ReactNode } from 'react';
import { prerequisiteStatusLabel } from '../../utils/execution';

export interface Connection {
  id: string;
  kind: 'model' | 'agent';
  type: string;
  name: string;
  enabled: boolean;
  description?: string;
  capabilities: string[];
  status: string;
  prerequisites: Prerequisite[];
  config: Record<string, unknown>;
  readinessEvidence?: ConnectionReadinessEvidence;
}

function IconCloud() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
    </svg>
  );
}

function IconServer() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  );
}

function IconLink() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

export function IconDatabase() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

export function IconTool() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

const PROVIDER_ICONS: Record<string, () => ReactNode> = {
  bedrock: IconCloud,
  ollama: IconServer,
  'openai-compat': IconLink,
};

export function getProviderIcon(type: string): () => ReactNode {
  return PROVIDER_ICONS[type] ?? IconLink;
}

export function getConnectionStatusClass(status: string): string {
  if (status === 'ready') return 'ready';
  if (status === 'missing_prerequisites') return 'warn';
  if (status === 'error') return 'error';
  if (status === 'disabled') return 'disabled';
  return 'warn';
}

export function describeConnection(connection: Connection): string {
  const missing = connection.prerequisites.filter(
    (item) => item.status !== 'installed',
  );
  if (missing.length > 0) {
    return missing
      .map((item) => `${item.name} — ${prerequisiteStatusLabel(item.status)}`)
      .join(' · ');
  }
  return '';
}
