'use client';
/** Which tools the run may use.
 *
 * Not a port of `components/playground/tools-menu.tsx`. That menu toggles a
 * different set of names, half of which have no server equivalent, and its
 * connector half drives the browser MCP client — a decision the server now
 * makes for itself in `lib/mcp/run-context.ts`. The names here come from the
 * server's own list so the two cannot drift.
 */
import { useEffect, useState } from 'react';
import { Wrench } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';

type Availability = { name: string; available: boolean; reason?: string };

/** Plain names for tools whose identifiers are not sentences. Anything absent
 * falls back to its identifier with the underscores taken out, which is worse
 * but never wrong. */
const LABELS: Record<string, string> = {
  ask_user: 'Ask you a question',
  bash: 'Run shell commands',
  calculate: 'Arithmetic',
  delete_file: 'Delete a workspace file',
  generate_image: 'Generate images',
  generate_speech: 'Generate speech',
  interpret_meaning: 'Interpret a sentence',
  list_files: 'List workspace files',
  list_ssh_hosts: 'List saved SSH hosts',
  read_file: 'Read a workspace file',
  read_webpage: 'Read a web page',
  research_quran: "Look up Qur'an references",
  run_javascript: 'Run JavaScript, isolated',
  sandbox_run: 'Run code in the workbench',
  search_reference: 'Search reference works',
  search_web: 'Search the web',
  simulate_plan: 'Simulate a plan',
  ssh_exec: 'Run a command over SSH',
  transition_estimate: 'Estimate a transition',
  update_plan: 'Keep a task plan',
  write_file: 'Write a workspace file',
};

const label = (name: string) => LABELS[name] ?? name.replace(/_/g, ' ');

export function ToolsMenu({
  disabled,
  onChange,
  busy,
}: {
  /** Tool names the owner has switched off. */
  disabled: string[];
  onChange: (disabledTools: string[]) => Promise<void> | void;
  busy?: boolean;
}) {
  const [tools, setTools] = useState<Availability[]>([]);

  useEffect(() => {
    let live = true;
    void fetch('/api/agents', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!live || !payload) return;
        // Availability travels with the list, so the menu never offers a switch
        // for a tool this deployment cannot run.
        setTools(
          (payload.availability as Availability[] | undefined) ??
            ((payload.tools as string[] | undefined) ?? []).map((name) => ({
              name,
              available: true,
            })),
        );
      })
      // No list means no menu, which is better than a menu that lies about
      // what is on.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!tools.length) return null;

  const off = new Set(disabled);
  const activeCount = tools.filter((tool) => tool.available && !off.has(tool.name)).length;

  const toggle = (name: string, on: boolean) =>
    void onChange(
      on ? disabled.filter((tool) => tool !== name) : [...new Set([...disabled, name])],
    );

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="chat-tools-trigger" disabled={busy}>
          <Wrench size={16} />
          Tools
          <span>{activeCount}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="chat-tools-menu" align="start">
        <p className="chat-tools-note">
          Applies from your next message. Connectors are managed under Connections in the workspace.
        </p>
        <ul>
          {tools.map((tool) => (
            <li key={tool.name}>
              <label title={tool.reason}>
                <input
                  type="checkbox"
                  checked={tool.available && !off.has(tool.name)}
                  disabled={!tool.available || busy}
                  onChange={(event) => toggle(tool.name, event.target.checked)}
                />
                <span>
                  {label(tool.name)}
                  <code>{tool.name}</code>
                </span>
              </label>
              {!tool.available && <small>{tool.reason}</small>}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
