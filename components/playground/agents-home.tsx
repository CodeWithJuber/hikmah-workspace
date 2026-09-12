'use client';
import { useState } from 'react';
import { Plus, ArrowUpRight, Check, Trash2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { SidebarTrigger } from '@/components/ui/sidebar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { HikmahIcon } from '@/components/kernel/icons';
import { usePlayground } from './context';
import { agentTemplates, builtInToolIds, type AgentProfile } from '@/lib/playground/agents';
import { randomId } from '@/lib/id';
import { newConversation } from '@/lib/playground/session';
import { toast } from 'sonner';
const labels: Record<string, string> = {
  calculate: 'Calculator',
  list_files: 'List files',
  read_file: 'Read files',
  write_file: 'Edit files',
  update_plan: 'Task planning',
  run_javascript: 'JavaScript sandbox',
  search_web: 'Web search',
  research_quran: 'Quran research index',
  search_reference: 'Reference search',
  read_webpage: 'Read public pages',
  interpret_meaning: 'Meaning experiment',
  simulate_plan: 'Planning simulation',
  transition_estimate: 'Transition experiment',
};
export function AgentSelector() {
  const { workspace, setWorkspace, setWorkspacePage } = usePlayground();
  return (
    <div className="agent-selector">
      <HikmahIcon name="agent" size={17} />
      <select
        aria-label="Active agent"
        value={workspace.activeAgentId}
        onChange={(e) => setWorkspace((w) => ({ ...w, activeAgentId: e.target.value }))}
      >
        <option value="">Hikmah · automatic tools</option>
        {workspace.agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button onClick={() => setWorkspacePage('agents')} aria-label="Manage agents">
        <Plus size={15} />
      </button>
    </div>
  );
}
export function AgentsHome() {
  const {
    workspace,
    setWorkspace,
    connectorTools,
    setWorkspacePage,
    setMode,
    setConversations,
    setActiveId,
  } = usePlayground();
  const [draft, setDraft] = useState<AgentProfile | null>(null);
  const [remove, setRemove] = useState('');
  const make = (template?: AgentProfile) =>
    setDraft(
      template
        ? { ...structuredClone(template), id: randomId() }
        : {
            id: randomId(),
            name: '',
            description: '',
            instructions: '',
            tools: ['calculate', 'list_files', 'read_file', 'update_plan'],
            connectors: [],
            memory: true,
            review: true,
            kind: 'custom',
          },
    );
  const use = (a: AgentProfile) => {
    setWorkspace((w) => ({ ...w, activeAgentId: a.id }));
    setMode('agent');
    const c = newConversation();
    setConversations((cs) => [c, ...cs]);
    setActiveId(c.id);
    setWorkspacePage('workspace');
  };
  const toggle = (field: 'tools' | 'connectors', id: string, on: boolean) =>
    setDraft((d) =>
      d
        ? { ...d, [field]: on ? [...new Set([...d[field], id])] : d[field].filter((x) => x !== id) }
        : d,
    );
  return (
    <div className="destination-page">
      <header className="workspace-header">
        <SidebarTrigger />
        <h1>Agents</h1>
        <Button disabled={workspace.agents.length >= 40} onClick={() => make()}>
          <Plus size={16} />
          Create agent
        </Button>
      </header>
      <div className="destination-scroll">
        <section className="destination-hero">
          <span className="eyebrow">YOUR TEAM, YOUR WAY</span>
          <h2>
            Give every kind of work
            <br />
            the right partner.
          </h2>
          <p>
            Reusable instructions, selected tools and clear permissions. Every agent works in the
            same chat, with the model you choose.
          </p>
          <button className="text-link" onClick={() => setWorkspacePage('tools')}>
            Explore tools & runtimes <ArrowUpRight size={15} />
          </button>
        </section>
        {workspace.agents.length > 0 && (
          <>
            <h3 className="section-label">
              Your agents <span>{workspace.agents.length}</span>
            </h3>
            <div className="agent-grid">
              {workspace.agents.map((a) => (
                <section className="agent-card" key={a.id}>
                  <div className="agent-card-top">
                    <span className={'agent-avatar ' + a.kind}>
                      <HikmahIcon
                        name={
                          a.kind === 'coding'
                            ? 'artifact'
                            : a.kind === 'voice'
                              ? 'voice'
                              : a.kind === 'research'
                                ? 'search'
                                : 'agent'
                        }
                        size={24}
                      />
                    </span>
                    {workspace.activeAgentId === a.id && (
                      <span className="status-pill">
                        <Check size={12} />
                        Selected
                      </span>
                    )}
                  </div>
                  <h3>{a.name}</h3>
                  <p>{a.description || 'Custom instructions and selected workspace tools.'}</p>
                  <div className="agent-card-meta">
                    <span>{a.tools.length} allowed tools</span>
                    <span>
                      {
                        a.connectors.filter(
                          (id) =>
                            workspace.connectors.some((c) => c.id === id && c.enabled) &&
                            connectorTools[id]?.length,
                        ).length
                      }{' '}
                      services connected
                    </span>
                  </div>
                  <div className="agent-card-actions">
                    <Button onClick={() => use(a)}>
                      Start chat <ArrowUpRight size={15} />
                    </Button>
                    <Button variant="ghost" onClick={() => setDraft(structuredClone(a))}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      className="icon-button"
                      aria-label={'Duplicate ' + a.name}
                      disabled={workspace.agents.length >= 40}
                      onClick={() =>
                        setDraft({
                          ...structuredClone(a),
                          id: randomId(),
                          name: a.name.slice(0, 70) + ' copy',
                        })
                      }
                    >
                      <Copy size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      className="icon-button"
                      aria-label={'Delete ' + a.name}
                      onClick={() => setRemove(a.id)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
        <h3 className="section-label">Start from a template</h3>
        <div className="template-list">
          {agentTemplates.map((t) => (
            <button key={t.id} disabled={workspace.agents.length >= 40} onClick={() => make(t)}>
              <span className={'agent-avatar ' + t.kind}>
                <HikmahIcon
                  name={
                    t.kind === 'coding'
                      ? 'artifact'
                      : t.kind === 'voice'
                        ? 'voice'
                        : t.kind === 'research'
                          ? 'search'
                          : 'agent'
                  }
                  size={22}
                />
              </span>
              <div>
                <strong>{t.name}</strong>
                <p>{t.description}</p>
              </div>
              <Plus size={18} />
            </button>
          ))}
        </div>
        <div className="plain-callout">
          <strong>From assistant to workflow</strong>
          <p>
            Voice controls provide dictation and read-aloud where your browser supports them. Video
            rendering, phone calls, CRM actions and unattended jobs need their own connected
            services. A template gives instructions; a connected tool performs the action.
          </p>
        </div>
      </div>
      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)}>
        <DialogContent className="agent-editor">
          <DialogHeader>
            <DialogTitle>
              {workspace.agents.some((a) => a.id === draft?.id)
                ? 'Edit agent'
                : 'Create your agent'}
            </DialogTitle>
            <DialogDescription>
              Instructions define the job. Tool selections define what it may access.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="agent-editor-body">
              <label>
                Name
                <Input
                  value={draft.name}
                  maxLength={80}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. My research partner"
                />
              </label>
              <label>
                Description
                <Input
                  value={draft.description}
                  maxLength={240}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What should this agent help with?"
                />
              </label>
              <label>
                Instructions
                <Textarea
                  value={draft.instructions}
                  maxLength={12000}
                  onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                  placeholder="Goal, workflow, boundaries and expected deliverable…"
                />
              </label>
              <h4>Allowed workspace tools</h4>
              <p className="small-note">
                Workspace switches still apply. Selecting a tool here does not override a disabled
                tool.
              </p>
              <div className="agent-tool-grid">
                {builtInToolIds.map((id) => (
                  <label key={id}>
                    <Switch
                      checked={draft.tools.includes(id)}
                      onCheckedChange={(on) => toggle('tools', id, on)}
                    />
                    {labels[id]}
                  </label>
                ))}
              </div>
              <h4>External services</h4>
              {workspace.connectors.length ? (
                workspace.connectors.map((c) => (
                  <label className="agent-switch-row" key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <small>
                        {c.enabled && connectorTools[c.id]?.length
                          ? 'Connected'
                          : 'Needs connection'}{' '}
                        · {c.approval === 'ask' ? 'approval per call' : 'server calls allowed'}
                      </small>
                    </div>
                    <Switch
                      checked={draft.connectors.includes(c.id)}
                      onCheckedChange={(on) => toggle('connectors', c.id, on)}
                    />
                  </label>
                ))
              ) : (
                <p className="small-note">
                  No services added. Save this agent, then open Tools & runtimes to connect one.
                </p>
              )}
              <label className="agent-switch-row">
                <div>
                  <strong>Use saved memory</strong>
                  <small>Retrieve reviewed items and suggest new memories for review.</small>
                </div>
                <Switch
                  checked={draft.memory}
                  onCheckedChange={(memory) => setDraft({ ...draft, memory })}
                />
              </label>
              <label className="agent-switch-row">
                <div>
                  <strong>Review before finishing</strong>
                  <small>Ask the configured model to check its draft when Hikmah is enabled.</small>
                </div>
                <Switch
                  checked={draft.review}
                  onCheckedChange={(review) => setDraft({ ...draft, review })}
                />
              </label>
            </div>
          )}
          <Button
            disabled={!draft?.name.trim() || !draft?.instructions.trim()}
            onClick={() => {
              if (!draft) return;
              setWorkspace((w) => ({
                ...w,
                agents: [
                  ...w.agents.filter((a) => a.id !== draft.id),
                  { ...draft, name: draft.name.trim() },
                ],
              }));
              setDraft(null);
              toast.success('Agent saved. Start a chat to use it.');
            }}
          >
            Save agent
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog open={!!remove} onOpenChange={(v) => !v && setRemove('')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this agent?</DialogTitle>
            <DialogDescription>Existing chats stay in your workspace.</DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            onClick={() => {
              setWorkspace((w) => ({
                ...w,
                agents: w.agents.filter((a) => a.id !== remove),
                activeAgentId: w.activeAgentId === remove ? '' : w.activeAgentId,
              }));
              setRemove('');
            }}
          >
            Delete agent
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
