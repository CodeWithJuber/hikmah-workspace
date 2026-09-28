import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /connections — mirrors the Connections page layout. */
export default function ConnectionsLoading() {
  return (
    <div className="lab-page">
      <header className="lab-header">
        <Skeleton className="size-9 rounded-md" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-6 w-36" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      </header>
      <div className="px-6 pb-4">
        <Skeleton className="h-9 w-44" />
      </div>
      <div className="grid gap-2 px-6" role="status" aria-label="Loading connections">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </div>
  );
}
