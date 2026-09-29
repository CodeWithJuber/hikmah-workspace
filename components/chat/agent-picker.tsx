'use client';
/** Invocation, not management: the composer's front door to the specialists.
 *
 * Agents were a feature with no door — entry only via the ⌘K palette or a
 * chip that appeared after you had already picked one. This button sits in
 * the composer and opens a bottom sheet with the built-in agents, each with
 * a one-line outcome description and its starters. Picking one applies it to
 * the next turn; tapping a starter also fills the composer as an editable
 * draft. Editing, deleting and the tool allowlist stay in the agents panel,
 * which is now manage-only.
 */
import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { clientFetch } from '@/lib/client/request';
import { AGENT_STARTERS } from '@/lib/chat/agent-starters';
import type { Agent } from './agents-panel';

export function AgentPicker({
  activeAgentId = null,
  onPick,
  onStarter,
  onManage,
}: {
  /** The agent driving the next turn, if any. Tapping it again switches off. */
  activeAgentId?: string | null;
  /** Apply the agent to the next turn (or null to switch off). */
  onPick: (agent: Agent | null) => void;
  /** Fill the composer with a starter as an editable draft — never sends. */
  onStarter: (prompt: string) => void;
  /** Open the agents panel, where agents are created, edited and deleted. */
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Loaded when the sheet opens, not with the composer: the composer mounts
  // on every conversation and the agent list is only needed on demand.
  useEffect(() => {
    if (!open) return;
    let live = true;
    void clientFetch('/api/agents')
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { agents?: Agent[] };
        if (live) setAgents(payload.agents ?? []);
      })
      .catch(() => {
        if (live) {
          setAgents([]);
          setFailed(true);
        }
      });
    return () => {
      live = false;
    };
  }, [open, attempt]);

  const pick = (agent: Agent) => {
    onPick(agent.id === activeAgentId ? null : agent);
    setOpen(false);
  };
  const start = (agent: Agent, prompt: string) => {
    // A starter both picks the specialist and drafts its opening line.
    onPick(agent);
    onStarter(prompt);
    setOpen(false);
  };

  return (
    <>
      <PromptInputButton
        type="button"
        onClick={() => {
          // Fresh state per opening: a failed load from last time is not
          // carried into this one.
          setAgents(null);
          setFailed(false);
          setOpen(true);
        }}
        title="Specialists — pick an agent for the next turn"
        aria-label="Specialists"
        aria-pressed={activeAgentId !== null}
      >
        <Bot size={16} className={activeAgentId ? 'text-primary' : undefined} aria-hidden="true" />
      </PromptInputButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="agent-picker-sheet">
          <DialogHeader>
            <DialogTitle>Specialists</DialogTitle>
            <DialogDescription>
              Pick one for your next message — its instructions and tools apply to that turn.
            </DialogDescription>
          </DialogHeader>
          {failed ? (
            <p className="files-note files-failed" role="status">
              Couldn&rsquo;t load the specialists.
              <button
                type="button"
                onClick={() => {
                  setFailed(false);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </p>
          ) : agents === null ? (
            <div className="grid gap-2" role="status" aria-label="Loading specialists">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-5/6" />
            </div>
          ) : agents.length === 0 ? (
            <p className="files-note">
              No specialists yet. Create one in the agents panel — or pick a template there to start
              from.
            </p>
          ) : (
            <ul className="agent-picker-list">
              {agents.map((agent) => {
                const active = agent.id === activeAgentId;
                const starters = (AGENT_STARTERS[agent.name] ?? []).slice(0, 2);
                return (
                  <li key={agent.id} className={active ? 'is-active' : undefined}>
                    <button
                      type="button"
                      className="agent-picker-row"
                      onClick={() => pick(agent)}
                      aria-pressed={active}
                    >
                      <span className="agent-picker-name">
                        {agent.name}
                        {active && <span className="agents-active">on</span>}
                      </span>
                      <span className="agent-picker-outcome">
                        {agent.description?.trim() ||
                          'Runs your next turn with its own instructions.'}
                      </span>
                    </button>
                    {starters.length > 0 && (
                      <div
                        className="agent-picker-starters"
                        role="group"
                        aria-label={`${agent.name} starters`}
                      >
                        {starters.map((prompt) => (
                          <Button
                            key={prompt}
                            type="button"
                            variant="outline"
                            size="sm"
                            /* h-10: starter chips are thumb targets in a bottom
                               sheet; h-8 (32px) was below the 40px mobile bar
                               (Jev bump-40, mobile audit 2026-09-29). */
                            className="h-10 rounded-full px-3 text-xs"
                            onClick={() => start(agent, prompt)}
                          >
                            {prompt.length > 42 ? prompt.slice(0, 42) + '…' : prompt}
                          </Button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="agent-picker-foot">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              Manage agents →
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
