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
  activeId,
  onPick,
}: {
  activeId: string | null;
  /** The agent to apply to the next turn, or null for none. */
  onPick: (agent: Agent | null) => void;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
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
    void fetch('/api/agents', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { agents: [], tools: [] }))
      .then((payload: { agents?: Agent[]; tools?: string[] }) => {
        if (!live) return;
        setAgents(payload.agents ?? []);
        setTools(payload.tools ?? []);
      })
      .catch(() => {
        if (live) setAgents([]);
      });
    return () => {
      live = false;
    };
  }, [revision]);

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
    const response = await fetch('/api/agents', {
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
      const response = await fetch(`/api/agents?id=${encodeURIComponent(agent.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) return;
      // A deleted agent cannot go on driving the next turn.
      if (agent.id === activeId) onPick(null);
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
      {agents === null && <p className="files-note">Loading…</p>}

      <ul>
        {agents?.map((agent) => (
          <li key={agent.id} className={agent.id === activeId ? 'is-open' : ''}>
            <button
              type="button"
              onClick={() => onPick(agent.id === activeId ? null : agent)}
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
