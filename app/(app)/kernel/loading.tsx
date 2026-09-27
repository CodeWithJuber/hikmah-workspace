import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /kernel — mirrors KernelCenter's page layout. */
export default function KernelLoading() {
  return (
    <div className="kernel-page">
      <header className="kernel-page-header">
        <Skeleton className="size-9 rounded-md" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-7 w-64 max-w-full" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
        <Skeleton className="h-9 w-40" />
      </header>
      <nav className="flex flex-wrap gap-2" aria-label="Loading sections">
        <Skeleton className="h-9 w-24 rounded-md" />
        <Skeleton className="h-9 w-28 rounded-md" />
        <Skeleton className="h-9 w-20 rounded-md" />
        <Skeleton className="h-9 w-32 rounded-md" />
      </nav>
      <div className="grid gap-3" role="status" aria-label="Loading kernel">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    </div>
  );
}
