import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Trash2 } from 'lucide-react';

interface CleanupModalProps {
  onBulkArchive: (status: 'failed' | 'cancelled' | 'completed') => Promise<void>;
  onBulkDeleteFailed: (options: { dryRun: boolean }) => Promise<{
    deletedCount: number;
    runIds: string[];
    dryRun: boolean;
  }>;
}

type BulkStatus = 'failed' | 'cancelled' | 'completed';

export function CleanupModal({
  onBulkArchive,
  onBulkDeleteFailed,
}: CleanupModalProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<BulkStatus>('failed');
  const [preview, setPreview] = useState<{ deletedCount: number; runIds: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiveDone, setArchiveDone] = useState<number | null>(null);
  const [deleteDone, setDeleteDone] = useState<number | null>(null);

  function reset(): void {
    setPreview(null);
    setActionError(null);
    setArchiveDone(null);
    setDeleteDone(null);
    setLoading(false);
    setStatus('failed');
  }

  async function handlePreview(): Promise<void> {
    setLoading(true);
    setActionError(null);
    try {
      const result = await onBulkDeleteFailed({ dryRun: true });
      setPreview(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleArchive(): Promise<void> {
    setLoading(true);
    setActionError(null);
    try {
      await onBulkArchive(status);
      setArchiveDone(1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Archive failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!preview) return;
    setLoading(true);
    setActionError(null);
    try {
      const result = await onBulkDeleteFailed({ dryRun: false });
      setDeleteDone(result.deletedCount);
      setPreview(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v): void => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <AlertDialogTrigger asChild>
        <button className="flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text-secondary hover:border-error hover:text-error transition-colors">
          <Trash2 className="h-3.5 w-3.5" />
          Cleanup
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Bulk run cleanup</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                Two-step: archive first (recoverable), then permanently delete archived failed runs.
              </p>
              <div className="space-y-1">
                <label className="text-sm font-medium text-foreground">Archive by status:</label>
                <select
                  value={status}
                  onChange={(e): void => {
                    setStatus(e.target.value as BulkStatus);
                  }}
                  className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="failed">Failed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="completed">Completed</option>
                </select>
              </div>
              {actionError && <p className="text-sm text-destructive">{actionError}</p>}
              {archiveDone !== null && (
                <p className="text-sm text-green-600">
                  Archived all {status} runs. They are now hidden from the default view.
                </p>
              )}
              {preview && (
                <div className="rounded-md border border-border bg-surface-elevated p-3 text-sm space-y-1">
                  <p>
                    <strong>{String(preview.deletedCount)}</strong> archived failed run
                    {preview.deletedCount !== 1 ? 's' : ''} will be permanently deleted.
                  </p>
                  {preview.runIds.length > 0 && (
                    <p className="text-xs text-text-tertiary font-mono truncate">
                      IDs: {preview.runIds.slice(0, 3).join(', ')}
                      {preview.runIds.length > 3
                        ? ` +${String(preview.runIds.length - 3)} more`
                        : ''}
                    </p>
                  )}
                </div>
              )}
              {deleteDone !== null && (
                <p className="text-sm text-green-600">
                  Permanently deleted {String(deleteDone)} failed run
                  {deleteDone !== 1 ? 's' : ''}.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={(): void => {
                void handleArchive();
              }}
              disabled={loading}
              className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              Archive all {status}
            </button>
            <button
              onClick={(): void => {
                void handlePreview();
              }}
              disabled={loading}
              className="rounded-md border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              Preview delete
            </button>
            {preview && preview.deletedCount > 0 && (
              <button
                onClick={(): void => {
                  void handleDelete();
                }}
                disabled={loading}
                className="rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
              >
                Delete {String(preview.deletedCount)} archived failed
              </button>
            )}
          </div>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
