import { BookOpen, BrainCircuit, Waves, Sigma, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface LabEntry {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
}

/** The labs directory data. Lives in a plain module (no 'use client') so both
 * the client directory page and the server-side [id] page can import it. */
export const labs: LabEntry[] = [
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
