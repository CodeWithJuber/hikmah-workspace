import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /superadmin — mirrors the LearningHome owner view. */
export default function SuperadminLoading() {
  return (
    <div className="knowledge-page">
      <header className="workspace-header">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-6 w-64 max-w-full" />
        <Skeleton className="ml-auto h-9 w-44" />
      </header>
      <div className="learning-home">
        <div className="grid gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <div className="grid grid-cols-3 gap-3" role="status" aria-label="Loading owner console">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </div>
        <div className="grid gap-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
