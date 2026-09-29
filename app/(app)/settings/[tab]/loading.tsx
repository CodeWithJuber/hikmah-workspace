import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /settings/[tab] — mirrors WorkspaceAdmin's settings layout. */
export default function AdminTabLoading() {
  return (
    <div className="admin-page">
      <header className="workspace-header">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-6 w-44" />
        <Skeleton className="ml-auto h-9 w-36" />
      </header>
      <div className="admin-scroll">
        <div className="flex flex-wrap gap-2" aria-label="Loading settings sections">
          <Skeleton className="h-9 w-24 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
          <Skeleton className="h-9 w-24 rounded-md" />
        </div>
        <div className="grid gap-3" role="status" aria-label="Loading settings">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
