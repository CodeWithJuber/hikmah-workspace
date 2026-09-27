'use client';
import { useRouter } from 'next/navigation';
import { Meaning } from '@/components/playground/meaning';

/** The meaning lab, wired to its route: "teach with examples" jumps to the
 * learning lab's page instead of swapping in-page state. */
export function MeaningLab() {
  const router = useRouter();
  return <Meaning onLearn={() => router.push('/labs/learn')} />;
}
