'use client';
/** Agents: a named bundle of instructions and a tool set.
 *
 * Picking one changes the next turn — its instructions are added to the run's
 * and its tool list narrows what the model is offered. It does not change the
 * conversation retrospectively, and it does not change the model unless the
 * agent names one, so choosing an agent cannot silently move the conversation
 * to a different provider.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Check, Pencil, Trash2 } from 'lucide-react';
import { clientFetch } from '@/lib/client/request';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { agentCategory } from '@/lib/chat/agent-categories';
import { AGENT_CATEGORY_ICONS } from './agent-category-icons';

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  model: string;
  builtIn: boolean;
};

const EMPTY: Omit<Agent, 'id' | 'builtIn'> = {
  name: '',
  description: '',
  instructions: '',
  tools: [],
  model: '',
};

/** "Start from an example": a blank editor is a wall of empty fields, so each
 * template pre-fills the name, the one-line outcome description, the
 * instructions and a sane tool set. The owner edits, then saves. */
const EXAMPLE_TEMPLATES: Omit<Agent, 'id' | 'builtIn' | 'model'>[] = [
  {
    name: 'Code reviewer',
    description: 'Reviews a change and names what would break first.',
    instructions:
      'Review the change in front of you. Name what it does, what could break, and the smallest fix for each risk. Do not rewrite the code unless asked.',
    tools: ['read_file', 'list_files'],
  },
  {
    name: 'Research brief',
    description: 'Reads sources and delivers a cited brief.',
    instructions:
      'Search the web and read primary sources. Cite the exact URLs retrieved. Distinguish evidence, interpretation and missing sources. Deliver a concise brief naming unresolved questions.',
    tools: ['search_web', 'read_webpage', 'search_reference'],
  },
  {
    name: 'Meeting prep',
    description: 'Turns rough notes into a tight agenda.',
    instructions:
      'Turn the notes into a tight agenda: goal, topics with time boxes, decisions needed, and owners. Ask for anything missing before finalizing.',
    tools: [],
  },
];

export function AgentsPanel({
  activeId = null,
  onPick,
}: {
  activeId?: string | null;
  /**
   * The agent to apply to the next turn, or null for none.
   *
   * Optional, because the same panel serves two surfaces. In the chat it picks
   * the agent for the next turn; on the workspace's Agents screen there is no
   * conversation to apply one to, so it manages them and picking is off. That
   * screen had its own 389-line copy over the workspace blob — a store nothing
   * has read since the browser run loop was retired, so every agent created
   * there was invisible to every run.
   */
  onPick?: (agent: Agent | null) => void;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  /** The last load did not come back. Separate from the rows themselves, so a
   * failure never overwrites what is already on screen. */
  const [failed, setFailed] = useState(false);
  /** Bumped by Retry, which is what re-runs the load. */
  const [attempt, setAttempt] = useState(0);
  const [tools, setTools] = useState<string[]>([]);
  // Whether the editor is open is its own state rather than something inferred
  // from the draft: "new agent, nothing typed yet" and "editor closed" have
  // identical drafts and must not look the same.
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [note, setNote] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    void clientFetch('/api/agents')
      .then(async (response) => {
        // A refusal is not an empty workspace: this used to fall through to
        // `{ agents: [], tools: [] }`, so a 500 rendered as a blank list with a
        // New agent button and no explanation at all.
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { agents?: Agent[]; tools?: string[] };
        if (!live) return;
        setAgents(payload.agents ?? []);
        setTools(payload.tools ?? []);
        setFailed(false);
      })
      .catch(() => {
        // Not "no agents": a failed load rendered as an empty list with a New
        // agent button and no explanation at all.
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [revision, attempt]);

  const edit = useCallback((agent: Agent | null) => {
    setOpen(true);
    setEditing(agent);
    setDraft(agent ? { ...agent } : EMPTY);
    setNote('');
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setEditing(null);
    setDraft(EMPTY);
    setNote('');
  }, []);

  const save = useCallback(async () => {
    const response = await clientFetch('/api/agents', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editing ? { ...draft, id: editing.id } : draft),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    // The server's own words: it knows whether this was a name, a ceiling or an
    // unknown tool, and a generic failure would hide all three.
    setNote(response.ok ? 'Saved.' : (payload.error ?? 'That did not save.'));
    if (response.ok) {
      setOpen(false);
      setEditing(null);
      setDraft(EMPTY);
      setRevision((value) => value + 1);
    }
  }, [draft, editing]);

  const remove = useCallback(
    async (agent: Agent) => {
      const response = await clientFetch(`/api/agents?id=${encodeURIComponent(agent.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) return;
      // A deleted agent cannot go on driving the next turn.
      if (agent.id === activeId) onPick?.(null);
      setRevision((value) => value + 1);
    },
    [activeId, onPick],
  );

  const toggleTool = (name: string) =>
    setDraft((current) => ({
      ...current,
      tools: current.tools.includes(name)
        ? current.tools.filter((tool) => tool !== name)
        : [...current.tools, name],
    }));

  return (
    <div className="agents-panel">
      {failed ? (
        <p className="files-note files-failed" role="status">
          Couldn&rsquo;t load your agents.
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : agents === null ? (
        <div className="files-note grid gap-2" role="status" aria-label="Loading agents">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      ) : agents.length === 0 ? (
        <p className="files-note">
          No specialists yet. Pick an agent before a message and it runs that turn with its own
          instructions and tools — create one below to get started.
        </p>
      ) : null}

      <ul className="n-list">
        {agents?.map((agent, i) => {
          const category = agentCategory(agent);
          const tint = `n-av-${agent.id.length % 4}`;
          const active = agent.id === activeId;
          return (
            <li key={agent.id} className="n-stagger" style={{ '--i': i } as CSSProperties}>
              <div className={`n-agent-card n-agent-manage${active ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="n-agent-pick n-press-tint"
                  onClick={() => onPick?.(agent.id === activeId ? null : agent)}
                  // Without a picker this row is a label, not a control: saying so
                  // is the difference between "nothing happened" and "nothing was
                  // supposed to happen".
                  disabled={!onPick}
                  title={agent.description}
                  aria-pressed={onPick ? active : undefined}
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
                    {agent.description?.trim() ? (
                      <span className="n-row-snippet">{agent.description.trim()}</span>
                    ) : null}
                    <span className="n-row-meta">{category}</span>
                  </span>
                </button>
                <span className="n-agent-tools">
                  <button
                    type="button"
                    className="n-icon-btn n-press"
                    onClick={() => edit(agent)}
                    aria-label={`Edit ${agent.name}`}
                  >
                    <Pencil size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="n-icon-btn n-press"
                    onClick={() => void remove(agent)}
                    aria-label={`Delete ${agent.name}`}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>

      <Button type="button" variant="default" className="w-full" onClick={() => edit(null)}>
        New agent
      </Button>

      {open && (
        <div className="files-editor">
          {/* Templates only for a new agent: applying one to an existing
              agent would clobber its instructions without a way back. */}
          {!editing && (
            <div className="agents-templates">
              <p className="agents-templates-label">Start from an example</p>
              <div className="agents-templates-row">
                {EXAMPLE_TEMPLATES.map((template) => (
                  <button
                    key={template.name}
                    type="button"
                    className="agents-template"
                    onClick={() =>
                      setDraft((current) => ({ ...current, ...template, model: current.model }))
                    }
                    title={template.description}
                  >
                    <span className="agents-template-name">{template.name}</span>
                    <span className="agents-template-desc">{template.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <label htmlFor="agent-name">Name</label>
          <input
            id="agent-name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />

          {/* The one line the picker shows next to the name: what picking it
              does to the next turn — an outcome, not a model fact. */}
          <label htmlFor="agent-description">What it does</label>
          <input
            id="agent-description"
            value={draft.description}
            placeholder="One line: what picking it does for the next turn"
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />

          <label htmlFor="agent-instructions">Instructions</label>
          <textarea
            id="agent-instructions"
            value={draft.instructions}
            onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
          />

          <fieldset className="agents-tools">
            {/* No tools chosen means every tool the run would offer anyway,
                which is what an agent that only changes the wording should do. */}
            <legend>Tools ({draft.tools.length === 0 ? 'all' : draft.tools.length})</legend>
            {tools.map((tool) => (
              <label key={tool}>
                <input
                  type="checkbox"
                  checked={draft.tools.includes(tool)}
                  onChange={() => toggleTool(tool)}
                />
                {tool}
              </label>
            ))}
          </fieldset>

          <div className="files-actions">
            <button type="button" onClick={() => void save()} disabled={!draft.name.trim()}>
              Save
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
            <span aria-live="polite">{note}</span>
          </div>
        </div>
      )}
    </div>
  );
}
