import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /labs/[id] — mirrors the lab detail layout. */
export default function LabDetailLoading() {
  return (
    <div className="lab-page">
      <header className="lab-header">
        <Skeleton className="size-9 rounded-md" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      </header>
      <div className="lab-switcher">
        <Skeleton className="h-9 w-28 rounded-md" />
        <Skeleton className="h-7 w-48" />
      </div>
      <div className="grid gap-3 px-6" role="status" aria-label="Loading lab">
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}
