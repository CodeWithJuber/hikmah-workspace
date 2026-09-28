import { Skeleton } from '@/components/ui/skeleton';

/** Loading state for /learning — mirrors UnifiedLearning's Studio/Library tabs. */
export default function LearningLoading() {
  return (
    <div className="grid gap-4 p-4 sm:p-6">
      <Skeleton className="h-9 w-48 rounded-lg" />
      <div className="grid gap-3" role="status" aria-label="Loading learning">
        <Skeleton className="h-7 w-2/5" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}
