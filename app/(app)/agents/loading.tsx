import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /agents — mirrors AgentsHome's destination layout. */
export default function AgentsLoading() {
  return (
    <div className="destination-page">
      <header className="workspace-header">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-6 w-28" />
      </header>
      <div className="destination-scroll">
        <section className="destination-hero">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-9 w-1/2" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-4 w-40" />
        </section>
        <div className="grid gap-2" role="status" aria-label="Loading agents">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>
    </div>
  );
}
