import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  CheckCircle2,
  Flame,
  LockKeyhole,
  PlayCircle,
  ShieldCheck,
  Workflow,
  XCircle,
} from 'lucide-react';
import { listPublicWorkflowRuns, type PublicWorkflowRunResponse } from '@/lib/api';
import { ensureUtc } from '@/lib/format';
import type { WorkflowRunStatus } from '@/lib/types';

const statusLabel: Record<WorkflowRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const statusClass: Record<WorkflowRunStatus, string> = {
  pending: 'border-warning/30 bg-warning/10 text-warning',
  running: 'border-primary/30 bg-primary/10 text-primary',
  paused: 'border-warning/30 bg-warning/10 text-warning',
  completed: 'border-success/30 bg-success/10 text-success',
  failed: 'border-error/30 bg-error/10 text-error',
  cancelled: 'border-text-tertiary/30 bg-surface-elevated text-text-secondary',
};

const nodeStatusClass: Record<PublicWorkflowRunResponse['nodes'][number]['status'], string> = {
  pending: 'border-warning/30 bg-warning/10 text-warning',
  running: 'border-primary/30 bg-primary/10 text-primary',
  completed: 'border-success/30 bg-success/10 text-success',
  failed: 'border-error/30 bg-error/10 text-error',
  skipped: 'border-text-tertiary/30 bg-surface-elevated text-text-tertiary',
};

function formatDate(value: string | null): string {
  if (!value) return 'Not finished';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ensureUtc(value)));
}

function NodeIcon({
  status,
}: {
  status: PublicWorkflowRunResponse['nodes'][number]['status'];
}): React.ReactElement {
  if (status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === 'failed') return <XCircle className="h-3.5 w-3.5" />;
  return <PlayCircle className="h-3.5 w-3.5" />;
}

function PublicRunRow({ run }: { run: PublicWorkflowRunResponse }): React.ReactElement {
  return (
    <li className="border-b border-border px-4 py-4 last:border-b-0">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{run.workflow_label}</p>
          <p className="mt-1 text-xs text-text-tertiary">
            Started {formatDate(run.started_at)} - Updated {formatDate(run.last_activity_at)}
          </p>
        </div>
        <span
          className={`w-fit rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass[run.status]}`}
        >
          {statusLabel[run.status]}
        </span>
        <p className="text-xs text-text-tertiary sm:text-right">
          Finished {formatDate(run.completed_at)}
        </p>
      </div>
      {run.nodes.length > 0 ? (
        <ol className="mt-3 flex flex-wrap gap-2">
          {run.nodes.map((node, index) => (
            <li
              key={`${node.label}-${node.updated_at}-${index}`}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${nodeStatusClass[node.status]}`}
            >
              <NodeIcon status={node.status} />
              <span className="truncate">{node.label}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-3 text-xs text-text-tertiary">Waiting for node telemetry.</p>
      )}
    </li>
  );
}

export function PublicCauldronPage(): React.ReactElement {
  const {
    data: runs = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['publicWorkflowRuns'],
    queryFn: () => listPublicWorkflowRuns(12),
    refetchInterval: 30_000,
    retry: 1,
  });

  const stats = useMemo(() => {
    const active = runs.filter(r => r.status === 'running' || r.status === 'pending').length;
    const completed = runs.filter(r => r.status === 'completed').length;
    const failed = runs.filter(r => r.status === 'failed').length;
    return { active, completed, failed };
  }, [runs]);

  return (
    <main className="min-h-screen bg-background text-text-primary">
      <header className="border-b border-border bg-surface/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md border border-primary/40 bg-primary/15">
              <Flame className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold">Cauldron</p>
              <p className="text-xs text-text-tertiary">Thinman Software automation lab</p>
            </div>
          </div>
          <a
            href="/chat"
            className="rounded-md border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-primary/50 hover:text-text-primary"
          >
            Operator console
          </a>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-8 px-5 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-success/25 bg-success/10 px-3 py-1 text-xs font-medium text-success">
            <ShieldCheck className="h-3.5 w-3.5" />
            Read-only public surface
          </div>
          <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-normal text-text-primary sm:text-5xl">
            Workflow orchestration for real software work.
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-text-secondary">
            Cauldron runs scoped work orders, tracks agent activity, and keeps operator control
            points separate from the public portfolio view.
          </p>
          <div className="mt-7 grid max-w-2xl gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-border bg-surface p-4">
              <Activity className="mb-3 h-5 w-5 text-primary" />
              <p className="text-2xl font-semibold">{stats.active}</p>
              <p className="mt-1 text-xs text-text-tertiary">Active or queued</p>
            </div>
            <div className="rounded-md border border-border bg-surface p-4">
              <Workflow className="mb-3 h-5 w-5 text-success" />
              <p className="text-2xl font-semibold">{stats.completed}</p>
              <p className="mt-1 text-xs text-text-tertiary">Recently completed</p>
            </div>
            <div className="rounded-md border border-border bg-surface p-4">
              <LockKeyhole className="mb-3 h-5 w-5 text-warning" />
              <p className="text-2xl font-semibold">0</p>
              <p className="mt-1 text-xs text-text-tertiary">Private fields exposed</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-surface shadow-2xl shadow-black/20">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Recent public workflow progress</h2>
              <p className="mt-1 text-xs text-text-tertiary">
                Sanitized workflow and node progress
              </p>
            </div>
            <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-tertiary">
              live
            </span>
          </div>
          {isLoading ? (
            <p className="px-4 py-10 text-sm text-text-secondary">Loading workflow status...</p>
          ) : isError ? (
            <p className="px-4 py-10 text-sm text-error">Unable to load public run status.</p>
          ) : runs.length === 0 ? (
            <p className="px-4 py-10 text-sm text-text-secondary">
              No recent workflow runs to show.
            </p>
          ) : (
            <ul>
              {runs.map((run, index) => (
                <PublicRunRow key={`${run.started_at}-${run.status}-${index}`} run={run} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
