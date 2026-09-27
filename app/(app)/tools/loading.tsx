import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /tools — mirrors RuntimeHome's destination layout. */
export default function ToolsLoading() {
  return (
    <div className="destination-page">
      <header className="workspace-header">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="ml-auto h-9 w-44" />
      </header>
      <div className="destination-scroll">
        <section className="destination-hero">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-9 w-1/3" />
          <Skeleton className="h-4 w-full max-w-md" />
        </section>
        <div className="grid gap-2" role="status" aria-label="Loading tools">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
        <div className="grid gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  );
}
