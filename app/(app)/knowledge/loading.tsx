import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /knowledge — mirrors the Memory page layout. */
export default function KnowledgeLoading() {
  return (
    <div className="knowledge-page">
      <header className="workspace-header">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-6 w-28" />
      </header>
      <div className="knowledge-body">
        <div className="flex items-center gap-4">
          <Skeleton className="size-12 rounded-full" />
          <div className="grid flex-1 gap-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-44 rounded-md" />
        </div>
        <div className="grid gap-3" role="status" aria-label="Loading knowledge">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
