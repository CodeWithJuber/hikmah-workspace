'use client';

/** One learning surface for the `/learning` route.
 *
 * The Studio tab is the annotation/training workbench; the Library tab is the
 * memory & learning home. The studio's memory shortcut lands on `/knowledge`,
 * where memory now lives, since there is no chat memory panel on this route.
 *
 * NOTE: the Library tab renders LearningHome, which reads the playground and
 * kernel contexts. The `/learning` page must render inside PlaygroundProvider
 * and the kernel provider, or the tab will throw.
 */
import { useRouter } from 'next/navigation';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LearningStudio } from './learning-studio';
import { LearningHome } from '@/components/playground/learning-home';

export function UnifiedLearning() {
  const router = useRouter();
  return (
    <div className="unified-learning">
      <Tabs defaultValue="studio">
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
