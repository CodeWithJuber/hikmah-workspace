import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /terminal — mirrors TerminalPage's shell layout. */
export default function TerminalLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <Skeleton className="size-9 rounded-md" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-full max-w-2xl" />
          <Skeleton className="h-4 w-2/3 max-w-xl" />
        </div>
      </header>
      <div
        className="flex min-h-64 flex-1 flex-col p-4"
        role="status"
        aria-label="Loading terminal"
      >
        <Skeleton className="min-h-40 flex-1 rounded-md" />
      </div>
      <div className="grid gap-2 border-t p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-12 w-full rounded-md" />
      </div>
    </div>
  );
}
