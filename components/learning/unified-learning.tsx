'use client';

/** One learning surface for the `/learning` route.
 *
 * The Studio tab is the annotation/training workbench; the Library tab is the
 * memory & learning home. The studio's memory shortcut lands on `/knowledge`,
 * where memory now lives, since there is no chat memory panel on this route.
 *
 * The tab is URL-driven (`?tab=studio|library`), so it survives reloads,
 * back/forward and deep links rather than resetting on every navigation.
 *
 * NOTE: the Library tab renders LearningHome, which reads the playground and
 * kernel contexts. The `/learning` page must render inside PlaygroundProvider
 * and the kernel provider, or the tab will throw.
 */
import { Suspense } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { LearningStudio } from './learning-studio';
import { LearningHome } from '@/components/playground/learning-home';

type LearningTab = 'studio' | 'library';

function isLearningTab(value: string | null): value is LearningTab {
  return value === 'studio' || value === 'library';
}

function UnifiedLearningTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get('tab');
  const tab: LearningTab = isLearningTab(raw) ? raw : 'studio';

  const setTab = (value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set('tab', value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="unified-learning">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Learning sections">
          <TabsTrigger value="studio">Studio</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
        </TabsList>
        <TabsContent value="studio">
          <LearningStudio revision={0} active onOpenMemory={() => router.push('/knowledge')} />
        </TabsContent>
        <TabsContent value="library">
          <LearningHome />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function UnifiedLearning() {
  return (
    <Suspense
      fallback={
        <div className="unified-learning grid gap-3" role="status" aria-label="Loading learning">
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <UnifiedLearningTabs />
    </Suspense>
  );
}
