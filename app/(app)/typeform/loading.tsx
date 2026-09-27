import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /typeform — mirrors the Integrations page layout. */
export default function TypeformLoading() {
  return (
    <div className="lab-page">
      <header className="lab-header">
        <Skeleton className="size-9 rounded-md" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-60 max-w-full" />
        </div>
      </header>
      <div className="grid gap-3 px-6" role="status" aria-label="Loading integrations">
        <Skeleton className="h-10 w-56 rounded-md" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    </div>
  );
}
