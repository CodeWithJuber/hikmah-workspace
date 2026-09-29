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
import { SidebarTrigger } from '@/components/ui/sidebar';
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
        <div className="unified-learning-bar">
          <SidebarTrigger className="size-9" />
          <div className="unified-learning-title">
            <span className="learning-eyebrow">Teach</span>
            <h1>Learning</h1>
          </div>
        </div>
        <div className="unified-learning-tabs">
          <TabsList variant="line" className="learning-tab-list" aria-label="Learning sections">
            <TabsTrigger className="learning-tab-trigger" value="studio">
              Studio
            </TabsTrigger>
            <TabsTrigger className="learning-tab-trigger" value="library">
              Library
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="studio" className="learning-tab-panel">
          <LearningStudio revision={0} active onOpenMemory={() => router.push('/knowledge')} />
        </TabsContent>
        <TabsContent value="library" className="learning-tab-panel">
          {/* The Library tab skips LearningHome's own page chrome: the Teach
              header and tab bar above already frame it. */}
          <LearningHome flush />
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
