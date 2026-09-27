'use client';
/** Agents: a named bundle of instructions and a tool set.
 *
 * Picking one changes the next turn — its instructions are added to the run's
 * and its tool list narrows what the model is offered. It does not change the
 * conversation retrospectively, and it does not change the model unless the
 * agent names one, so choosing an agent cannot silently move the conversation
 * to a different provider.
 */
import { useCallback, useEffect, useState } from 'react';
import { clientFetch } from '@/lib/client/request';
import { Skeleton } from '@/components/ui/skeleton';

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
          No agents yet. An agent is a named set of instructions and tools.
        </p>
      ) : null}

      <ul>
        {agents?.map((agent) => (
          <li key={agent.id} className={agent.id === activeId ? 'is-open' : ''}>
            <button
              type="button"
              onClick={() => onPick?.(agent.id === activeId ? null : agent)}
              // Without a picker this row is a label, not a control: saying so
              // is the difference between "nothing happened" and "nothing was
              // supposed to happen".
              disabled={!onPick}
              title={agent.description}
            >
              <span className="files-path">{agent.name}</span>
              {agent.id === activeId && <span className="agents-active">on</span>}
            </button>
            <button
              type="button"
              className="files-delete"
              onClick={() => edit(agent)}
              aria-label={`Edit ${agent.name}`}
            >
              ✎
            </button>
            <button
              type="button"
              className="files-delete"
              onClick={() => void remove(agent)}
              aria-label={`Delete ${agent.name}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <button type="button" className="conversation-new" onClick={() => edit(null)}>
        New agent
      </button>

      {open && (
        <div className="files-editor">
          <label htmlFor="agent-name">Name</label>
          <input
            id="agent-name"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
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
