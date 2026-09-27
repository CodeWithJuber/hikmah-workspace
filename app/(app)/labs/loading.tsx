import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /labs — mirrors the labs list layout. */
export default function LabsLoading() {
  return (
    <div className="lab-page">
      <header className="lab-header">
        <Skeleton className="size-9 rounded-md" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </header>
      <div
        className="grid gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3"
        role="status"
        aria-label="Loading labs"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="grid gap-2 rounded-lg border p-4">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
