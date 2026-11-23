import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { PageRow } from '../../components/PageRow';
import { toastStore } from '../../contexts/ToastContext';
import '../page-layout.css';

interface ProjectShareScope {
  apiBase: string;
  authorityKey: string;
  isCurrent(): boolean;
}

interface WebMcpModelContext {
  getTools?: unknown;
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      execute(): object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
    },
    options: { signal: AbortSignal },
  ): Promise<void>;
}

interface ProjectShareProps {
  project: { id: string; name: string; description?: string };
  scope: ProjectShareScope;
}

export function ProjectWebMcpShare(props: ProjectShareProps) {
  const { project, scope } = props;
  return (
    <ProjectShareControl
      key={JSON.stringify([
        scope.apiBase,
        scope.authorityKey,
        project.id,
        project.name,
        project.description,
      ])}
      {...props}
    />
  );
}

function ProjectShareControl({
  project: { name, description },
  scope,
}: ProjectShareProps) {
  const registration = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<'idle' | 'registering' | 'sharing'>(
    'idle',
  );
  useLayoutEffect(
    () => () => {
      registration.current?.abort();
      registration.current = null;
    },
    [],
  );
  if (typeof window === 'undefined') return null;
  const context = (document as Document & { modelContext?: WebMcpModelContext })
    .modelContext;
  if (
    !window.isSecureContext ||
    window.top !== window ||
    typeof context?.registerTool !== 'function' ||
    typeof context.getTools !== 'function'
  ) {
    return null;
  }

  async function toggleShare(modelContext: WebMcpModelContext) {
    if (registration.current) {
      registration.current.abort();
      registration.current = null;
      setStatus('idle');
      return;
    }
    if (!scope.isCurrent()) return;
    const controller = new AbortController();
    registration.current = controller;
    setStatus('registering');
    try {
      await modelContext.registerTool(
        {
          name: 'station_current_project',
          description:
            'Read the name and description shared from this Station Project.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: () =>
            !controller.signal.aborted && scope.isCurrent()
              ? { name, ...(description === undefined ? {} : { description }) }
              : { error: 'This Project summary is no longer shared.' },
        },
        { signal: controller.signal },
      );
      if (registration.current === controller) setStatus('sharing');
    } catch {
      if (registration.current !== controller) return;
      controller.abort();
      registration.current = null;
      setStatus('idle');
      toastStore.show('Could not share this Project summary.');
    }
  }
  return (
    <PageRow
      title="Browser assistant"
      description="Share this Project’s name and description."
      control={
        <Button
          active={status === 'sharing'}
          aria-pressed={status === 'sharing'}
          pending={status === 'registering'}
          onClick={() => void toggleShare(context)}
        >
          {status === 'sharing' ? 'Stop sharing' : 'Share summary'}
        </Button>
      }
    />
  );
}
