import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { bulkDeleteFailedRuns } from '@/lib/api';

interface BulkCleanupModalProps {
  /** The element that opens the modal when clicked. */
  trigger: React.ReactNode;
  /** Called after a non-dry-run delete completes successfully. */
  onComplete?: () => void;
}

type Phase = 'idle' | 'confirming' | 'done';

/**
 * Two-phase cleanup modal for bulk-deleting archived failed workflow runs.
 * Phase 1: dry-run preview (shows count without deleting).
 * Phase 2: confirmation + permanent delete.
 */
export function BulkCleanupModal({
  trigger,
  onComplete,
}: BulkCleanupModalProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reset(): void {
    setPhase('idle');
    setPreviewCount(null);
    setError(null);
    setLoading(false);
  }

  async function handlePreview(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await bulkDeleteFailedRuns({ dryRun: true });
      setPreviewCount(result.count);
      setPhase('confirming');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to preview');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      await bulkDeleteFailedRuns({ dryRun: false });
      setPhase('done');
      onComplete?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(v: boolean): void {
    setOpen(v);
    if (!v) reset();
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {phase === 'done' ? 'Cleanup complete' : 'Bulk delete archived failed runs'}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {phase === 'idle' ? (
                <p>
                  This will permanently delete all <strong>archived failed</strong> workflow run
                  rows and their events. Worktree directories on disk are not affected.
                </p>
              ) : phase === 'confirming' ? (
                <p>
                  Found <strong>{String(previewCount)}</strong> archived failed run
                  {previewCount === 1 ? '' : 's'} to delete. This cannot be undone.
                </p>
              ) : (
                <p>Archived failed runs have been permanently deleted.</p>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {phase === 'done' ? (
            <AlertDialogCancel
              onClick={(): void => {
                setOpen(false);
              }}
            >
              Close
            </AlertDialogCancel>
          ) : phase === 'confirming' ? (
            <>
              <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e): void => {
                  e.preventDefault();
                  void handleDelete();
                }}
                disabled={loading || previewCount === 0}
              >
                {loading ? 'Deleting...' : `Delete ${String(previewCount ?? 0)} runs`}
              </AlertDialogAction>
            </>
          ) : (
            <>
              <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e): void => {
                  e.preventDefault();
                  void handlePreview();
                }}
                disabled={loading}
              >
                {loading ? 'Checking...' : 'Preview'}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
