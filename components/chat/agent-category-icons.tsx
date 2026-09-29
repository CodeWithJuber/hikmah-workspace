/** One static icon per agent category.
 *
 * Static elements, not a dynamic <Icon/>: creating components during render
 * resets their state on every render. The map lives here so the picker's
 * cards and the panel's rows render the same mark for the same category.
 */
import type { ReactElement } from 'react';
import { BookOpen, Bot, Code2, PenLine, Server, Sparkles } from 'lucide-react';
import type { AgentCategory } from '@/lib/chat/agent-categories';

export const AGENT_CATEGORY_ICONS: Record<AgentCategory, ReactElement> = {
  Code: <Code2 size={20} aria-hidden="true" />,
  Research: <BookOpen size={20} aria-hidden="true" />,
  Ops: <Server size={20} aria-hidden="true" />,
  Writing: <PenLine size={20} aria-hidden="true" />,
  General: <Sparkles size={20} aria-hidden="true" />,
  Custom: <Bot size={20} aria-hidden="true" />,
};
