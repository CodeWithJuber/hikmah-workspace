'use client';
import { useRouter } from 'next/navigation';
import { BookOpen, BrainCircuit, Waves, Sigma, Workflow, ArrowUpRight } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';

export const labs = [
  {
    id: 'meaning',
    name: 'Meaning',
    description: 'Explore how the small symbolic learner represents a sentence.',
    icon: BrainCircuit,
  },
  {
    id: 'learn',
    name: 'Learning',
    description: 'Teach with examples and compare the candidate model.',
    icon: BookOpen,
  },
  {
    id: 'planning',
    name: 'Planning',
    description: 'Simulate a workflow with costs, failures and verification.',
    icon: Workflow,
  },
  {
    id: 'sound',
    name: 'Sound',
    description: 'Compare frequencies and the information they preserve.',
    icon: Waves,
  },
  {
    id: 'maths',
    name: 'Mathematics',
    description: 'Explore evidence, budgets and graph algorithms.',
    icon: Sigma,
  },
];

/** The labs directory. Each lab is its own route (/labs/<id>); the entries
 * navigate with the router because the directory styling targets button
 * elements, and an anchor would lose the layout. */
export function LabsPage() {
  const router = useRouter();
  return (
    <div className="lab-page">
      <header className="lab-header">
        <SidebarTrigger />
        <div>
          <h1>Research labs</h1>
          <p>Explore the ideas behind the workspace.</p>
        </div>
      </header>
      <p className="lab-intro">
        These are local experiments. They work without a provider connection.
      </p>
      <div className="lab-directory">
        {labs.map((l) => (
          <button key={l.id} onClick={() => router.push('/labs/' + l.id)}>
            <l.icon size={24} />
            <div>
              <h2>{l.name}</h2>
              <p>{l.description}</p>
            </div>
            <ArrowUpRight size={20} />
          </button>
        ))}
      </div>
    </div>
  );
}
