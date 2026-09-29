'use client';
/** The workspace's Agents screen.
 *
 * It used to be 389 lines of its own: a list, an editor and a template picker,
 * all over `workspace.agents` in the workspace blob. Nothing has read that
 * field since the browser run loop was retired, so every agent created here
 * was invisible to every run — the same fault as the Tools screen, which wrote
 * a preference nothing read, and the same fault the co-model and the knowledge
 * store had. A screen that saves into a store no run consults is worse than no
 * screen, because it looks like it worked.
 *
 * Agents are server-side rows now (`drizzle/0009_agents.sql`, `/api/agents`),
 * and `components/chat/agents-panel.tsx` is the surface over them. This renders
 * that one rather than keeping a second copy that could drift: both screens
 * read and write the same rows, so they agree by construction.
 *
 * `AgentSelector` went with the rest. It was exported from here and imported by
 * nothing — a picker for the blob's `activeAgentId`, which the deleted chat was
 * the only reader of.
 */
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { AgentsPanel } from '@/components/chat/agents-panel';
import styles from '@/components/app/sections.module.css';

export function AgentsHome() {
  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.header}>
          {/* size-9, because the vendored default is size-7 — 28px, under any
              comfortable touch target. tailwind-merge lets the call site win. */}
          <SidebarTrigger className="size-9" />
          <h1>Assistants</h1>
        </header>
        <section className={styles.hero}>
          <span className={styles.eyebrow}>Your team, your way</span>
          <h2>Give every kind of work the right partner.</h2>
          <p>
            Reusable instructions and a chosen tool set, saved to your workspace. Pick one in the
            chat to apply it to the next message; the model stays yours unless the agent names one.
          </p>
        </section>
        <Link className={styles.link} href="/tools">
          Explore tools &amp; runtimes <ArrowUpRight size={16} />
        </Link>
        {/* No picker here: this screen manages agents, and there is no
            conversation on it to apply one to. Choosing one happens where it
            takes effect. */}
        <AgentsPanel />
        <p className={styles.note}>
          <Link href="/chat">Open the chat</Link> to use one on your next message.
        </p>
      </div>
    </div>
  );
}
