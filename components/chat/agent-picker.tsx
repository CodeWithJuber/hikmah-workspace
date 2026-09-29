'use client';
/** Invocation, not management: the composer's front door to the specialists.
 *
 * Agents were a feature with no door — entry only via the ⌘K palette or a
 * chip that appeared after you had already picked one. This button sits in
 * the composer and opens a native bottom sheet: search, category chips, a
 * recently-used rail, and one card per agent with its outcome line and
 * starters. Picking one applies it to the next turn; tapping a starter also
 * fills the composer as an editable draft. Editing, deleting and the tool
 * allowlist stay in the agents panel, which is now manage-only.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Bot, Check, Search, X } from 'lucide-react';
import { PromptInputButton } from '@/components/ai-elements/prompt-input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { clientFetch } from '@/lib/client/request';
import { AGENT_STARTERS } from '@/lib/chat/agent-starters';
import { CATEGORY_ORDER, agentCategory, type AgentCategory } from '@/lib/chat/agent-categories';
import { AGENT_CATEGORY_ICONS } from './agent-category-icons';
import type { Agent } from './agents-panel';

const RECENT_KEY = 'hikmah.recent-agent-ids';
const RECENT_MAX = 4;
/** Truncate at a word boundary so chips never cut mid-word ("…"
 * baked into the label looked sloppy on the live sheet). */
function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max).replace(/\s+\S*$/, '');
  return (cut || text.slice(0, max)) + '…';
}
function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}
function writeRecent(ids: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_MAX)));
  } catch {
    /* Private mode: the rail just doesn't persist. */
  }
}

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
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'All' | AgentCategory>('All');
  const [recentIds, setRecentIds] = useState<string[]>([]);

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

  const categories = useMemo(() => {
    const present = new Set<AgentCategory>();
    for (const agent of agents ?? []) present.add(agentCategory(agent));
    return CATEGORY_ORDER.filter((label) => present.has(label));
  }, [agents]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (agents ?? []).filter((agent) => {
      if (category !== 'All' && agentCategory(agent) !== category) return false;
      if (!q) return true;
      const hay = `${agent.name} ${agent.description ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [agents, query, category]);

  const recent = useMemo(() => {
    if (query.trim() || category !== 'All' || !agents) return [];
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    return recentIds.map((id) => byId.get(id)).filter((a): a is Agent => a !== undefined);
  }, [agents, recentIds, query, category]);
  const rest = useMemo(
    () => visible.filter((agent) => !recent.some((r) => r.id === agent.id)),
    [visible, recent],
  );

  const pick = (agent: Agent) => {
    setRecentIds((ids) => {
      const next = [agent.id, ...ids.filter((id) => id !== agent.id)];
      writeRecent(next);
      return next.slice(0, RECENT_MAX);
    });
    onPick(agent.id === activeAgentId ? null : agent);
    setOpen(false);
  };
  const start = (agent: Agent, prompt: string) => {
    // A starter both picks the specialist and drafts its opening line.
    onPick(agent);
    onStarter(prompt);
    setOpen(false);
  };
  const openSheet = () => {
    // Fresh state per opening: a failed load or a stale filter from last
    // time is not carried into this one.
    setAgents(null);
    setFailed(false);
    setQuery('');
    setCategory('All');
    setRecentIds(readRecent());
    setOpen(true);
  };

  return (
    <>
      <PromptInputButton
        type="button"
        onClick={openSheet}
        title="Specialists — pick an agent for the next turn"
        aria-label="Specialists"
        aria-pressed={activeAgentId !== null}
      >
        <Bot size={16} className={activeAgentId ? 'text-primary' : undefined} aria-hidden="true" />
      </PromptInputButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="agent-picker-sheet" showCloseButton={false}>
          <div className="n-sheet-head">
            <div>
              <DialogTitle>Specialists</DialogTitle>
              <DialogDescription>
                Pick one for your next message — its instructions and tools apply to that turn.
              </DialogDescription>
            </div>
            <button
              type="button"
              className="n-icon-btn n-press"
              onClick={() => setOpen(false)}
              aria-label="Close specialists"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="n-search" role="search">
            <Search size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search specialists"
              aria-label="Search specialists"
            />
            {query && (
              <button
                type="button"
                className="n-search-clear n-press"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          {categories.length > 1 && (
            <div className="n-chip-row" role="group" aria-label="Filter by category">
              {(['All', ...categories] as const).map((label) => (
                <button
                  key={label}
                  type="button"
                  className={`n-chip n-press${category === label ? ' is-active' : ''}`}
                  aria-pressed={category === label}
                  onClick={() => setCategory(label)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {failed ? (
            <div className="n-empty" role="status">
              <p className="n-empty-title">Couldn&rsquo;t load the specialists.</p>
              <button
                type="button"
                className="n-cta"
                onClick={() => {
                  setFailed(false);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </div>
          ) : agents === null ? (
            <div role="status" aria-label="Loading specialists">
              <div className="n-shimmer-line" style={{ width: '70%' }} />
              <div className="n-shimmer-line" style={{ width: '90%' }} />
              <div className="n-shimmer-line" style={{ width: '55%' }} />
            </div>
          ) : agents.length === 0 ? (
            <div className="n-empty">
              <Bot size={32} aria-hidden="true" className="n-empty-icon" />
              <p className="n-empty-title">No specialists yet</p>
              <p className="n-empty-body">
                Create one in the agents panel — or pick a template there to start from.
              </p>
            </div>
          ) : (
            <>
              {recent.length > 0 && (
                <section aria-label="Recently used">
                  <h3 className="n-section-title">Recently used</h3>
                  <ul className="n-list">
                    {recent.map((agent, i) => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        index={i}
                        active={agent.id === activeAgentId}
                        onPick={pick}
                        onStarter={start}
                      />
                    ))}
                  </ul>
                </section>
              )}
              <section aria-label={recent.length > 0 ? 'All specialists' : 'Specialists'}>
                {recent.length > 0 && <h3 className="n-section-title">All specialists</h3>}
                {rest.length === 0 ? (
                  <p className="n-note">No specialists match this filter.</p>
                ) : (
                  <ul className="n-list">
                    {rest.map((agent, i) => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        index={recent.length + i}
                        active={agent.id === activeAgentId}
                        onPick={pick}
                        onStarter={start}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </>
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

function AgentCard({
  agent,
  index,
  active,
  onPick,
  onStarter,
}: {
  agent: Agent;
  index: number;
  active: boolean;
  onPick: (agent: Agent) => void;
  onStarter: (agent: Agent, prompt: string) => void;
}) {
  const category = agentCategory(agent);
  const tint = `n-av-${agent.id.length % 4}`;
  const starters = (AGENT_STARTERS[agent.name] ?? []).slice(0, 2);
  return (
    <li className="n-stagger" style={{ '--i': index } as CSSProperties}>
      <button
        type="button"
        className={`n-agent-card n-press${active ? ' is-active' : ''}`}
        onClick={() => onPick(agent)}
        aria-pressed={active}
      >
        <span className={`n-avatar ${tint}`} aria-hidden="true">
          {AGENT_CATEGORY_ICONS[category]}
        </span>
        <span className="n-row-main">
          <span className="n-row-title">
            {agent.name}
            {active && (
              <span className="n-badge" aria-label="Active">
                <Check size={12} aria-hidden="true" /> on
              </span>
            )}
          </span>
          <span className="n-row-snippet">
            {agent.description?.trim() || 'Runs your next turn with its own instructions.'}
          </span>
          <span className="n-row-meta">{category}</span>
        </span>
      </button>
      {starters.length > 0 && (
        <div className="n-starter-row" role="group" aria-label={`${agent.name} starters`}>
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
              onClick={() => onStarter(agent, prompt)}
            >
              {truncateWords(prompt, 60)}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
